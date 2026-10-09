/**
 * ============================================================================
 *  SentryNode — Firmware para AI-Thinker ESP32-CAM
 * ============================================================================
 *  Placa : AI-Thinker ESP32-CAM (ESP32-D0WD, 4 MB PSRAM), sensor OV2640 u OV5640
 *  IDE   : Arduino IDE 2.x  ·  "esp32 by Espressif" 3.x
 *  Placa en el IDE: "AI Thinker ESP32-CAM"  (PSRAM: Enabled)
 *  Librerías externas: NINGUNA (todo viene con el core de Espressif)
 *
 *  RED
 *  ───
 *  El ESP32 se conecta como ESTACIÓN (STA) al hotspot del celular. Así el
 *  teléfono ve al ESP32 en su red local y, al mismo tiempo, conserva sus datos
 *  móviles para enviar el correo de alerta. Si en 20 s no logra conectarse,
 *  levanta su propio Access Point "SentryNode-XXXX" (192.168.4.1) como modo
 *  de rescate, para que la cámara se pueda probar igual.
 *
 *  ARQUITECTURA (productor / consumidores)
 *  ──────────────────────────────────────
 *
 *   ┌───────────── Core 1 ─────────────┐   ┌──────────── Core 0 ─────────────┐
 *   │ cameraTask (prio 5)  PRODUCTOR   │   │ Pila Wi-Fi / lwIP (Espressif)   │
 *   │  fb_get → copia JPEG → fb_return │   │ httpd :80  (control, JSON)      │
 *   │        │                         │   │ httpd :81  (stream MJPEG)       │
 *   │        ▼                         │   │ motionTask (prio 2) CONSUMIDOR  │
 *   │  latest = {jpeg, len, seq}  ◀────┼───┼── copia bajo frameMutex         │
 *   │  loop(): LED estado, Wi-Fi       │   │                                 │
 *   └──────────────────────────────────┘   └─────────────────────────────────┘
 *
 *  La cámara SOLO la toca cameraTask. Copia cada JPEG a un búfer compartido
 *  ("último frame") y devuelve el frame-buffer DMA de inmediato. El stream y
 *  la detección leen ese búfer compartido bajo un mutex. Así:
 *    - el DMA nunca se queda sin búferes aunque un cliente Wi-Fi sea lento;
 *    - un cliente lento no frena la detección de movimiento (ni al revés).
 *
 *  ENDPOINTS
 *  ─────────
 *   Puerto 80 (control):
 *     GET /              Página de prueba con el video
 *     GET /status        Telemetría JSON (modo, motion_seq, fps, rssi, hora…)
 *     GET /capture       Foto JPEG actual
 *     GET /motion.jpg    Evidencia del último movimiento (JPEG 320×240)
 *     GET /mode?value=disarmed|home|away   Fija el modo (idempotente)
 *     GET /flash?state=0|1                 LED flash (idempotente)
 *     GET /siren?state=0|1                 Buzzer opcional (idempotente)
 *   Puerto 81 (video):
 *     GET /stream        multipart/x-mixed-replace (MJPEG)
 * ============================================================================
 */

#include <WiFi.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <time.h>
#include <atomic>
#include "esp_camera.h"
#include "img_converters.h"
#include "esp_http_server.h"
#include "lwip/sockets.h"
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"

// ─── 1. CONFIGURACIÓN (edita esto) ───────────────────────────────────────────

// Credenciales del hotspot: van en secrets.h (no se sube a GitHub).
// Copia secrets.example.h como secrets.h y pon tu red.
#if __has_include("secrets.h")
#include "secrets.h"
#else
#define WIFI_SSID          "TU_HOTSPOT"
#define WIFI_PASS          "TU_CLAVE"
#endif
#define WIFI_CONNECT_MS    20000             // Espera máxima antes del AP de rescate
#define FALLBACK_AP_PASS   "sabana2026"      // Clave del AP de rescate
#define MDNS_HOSTNAME      "sentrynode"      // http://sentrynode.local (desde un PC)
#define TZ_INFO            "<-05>5"          // Bogotá: UTC-5, sin horario de verano

#define XCLK_FREQ_HZ       20000000          // Si ves imágenes corruptas, prueba 16000000
#define FRAME_SIZE         FRAMESIZE_VGA     // 640×480. Si lo cambias, ajusta FRAME_W/FRAME_H
#define FRAME_W            640               // (la detección decodifica a FRAME_W/8 × FRAME_H/8)
#define FRAME_H            480
#define JPEG_QUALITY       12                // 0-63, menor = mejor calidad

// Sensores/actuadores opcionales (no hacen falta para el parcial)
#define USE_BUZZER         0                 // 1 si conectas un buzzer activo
#define BUZZER_PIN         14
#define USE_PIR            0                 // 1 si conectas un sensor PIR
#define PIR_PIN            13

// ─── 2. Pines AI-Thinker ESP32-CAM ───────────────────────────────────────────

#define PWDN_GPIO_NUM      32
#define RESET_GPIO_NUM     -1
#define XCLK_GPIO_NUM       0
#define SIOD_GPIO_NUM      26
#define SIOC_GPIO_NUM      27
#define Y9_GPIO_NUM        35
#define Y8_GPIO_NUM        34
#define Y7_GPIO_NUM        39
#define Y6_GPIO_NUM        36
#define Y5_GPIO_NUM        21
#define Y4_GPIO_NUM        19
#define Y3_GPIO_NUM        18
#define Y2_GPIO_NUM         5
#define VSYNC_GPIO_NUM     25
#define HREF_GPIO_NUM      23
#define PCLK_GPIO_NUM      22

#define FLASH_LED_PIN       4                // LED blanco de alta potencia
#define STATUS_LED_PIN     33                // LED rojo de la placa (activo en BAJO)

// ─── 3. Parámetros de detección de movimiento ────────────────────────────────
// Se decodifica cada JPEG a 1/8 de escala (640×480 → 80×60) y se pasa a gris.
// La imagen se divide en bloques de 10×10 px (8×6 = 48 bloques). Un bloque
// "cambia" si su brillo promedio se aleja más de BLOCK_DIFF del fondo.

#define DETECT_PERIOD_MS     200   // ~5 análisis por segundo
#define BLOCK_PX             10
#define BLOCK_DIFF           18    // Diferencia de brillo (0-255) para marcar un bloque
#define MIN_CHANGED_BLOCKS   3     // Bloques mínimos para considerar movimiento (~6 %)
#define GLOBAL_CHANGE_RATIO  0.80f // Si cambia >80 % de la imagen = cambio de luz, no intruso
#define CONFIRM_FRAMES       2     // Detecciones seguidas para confirmar (filtra ruido)
#define MOTION_COOLDOWN_MS   10000 // Tiempo mínimo entre dos eventos
#define WARMUP_FRAMES        15    // Frames para aprender el fondo al arrancar
#define BG_LEARN_RATE        0.05f // Adaptación lenta del fondo (sombras, nubes)

// ─── 4. Estado compartido ────────────────────────────────────────────────────

enum SecurityMode : uint8_t { MODE_DISARMED = 0, MODE_HOME = 1, MODE_AWAY = 2 };
static const char* MODE_NAMES[] = { "disarmed", "home", "away" };

// Último frame (lo escribe cameraTask, lo leen stream y motionTask)
static SemaphoreHandle_t frameMutex = nullptr;
static uint8_t*  latestJpeg   = nullptr;
static size_t    latestLen    = 0;
static size_t    latestCap    = 0;
static uint32_t  latestSeq    = 0;     // Sube con cada frame nuevo

// Evidencia del último movimiento (la escribe motionTask, la lee /motion.jpg)
static SemaphoreHandle_t evidenceMutex = nullptr;
static uint8_t*  evidenceJpeg = nullptr;
static size_t    evidenceLen  = 0;

// Valores pequeños: se leen/escriben atómicamente (32 bits) entre tareas
static volatile SecurityMode securityMode = MODE_DISARMED;
static volatile uint32_t motionSeq        = 0;  // Contador de eventos confirmados
static volatile uint32_t motionUptimeMs   = 0;  // millis() del último evento
static volatile time_t   motionEpoch      = 0;  // Hora real del último evento (NTP)
static volatile uint16_t lastChangedBlocks = 0;
static volatile float    cameraFps        = 0;
static std::atomic<uint8_t> streamClients{0};  // Lo modifican varias conexiones

// Registro de la app: se considera "conectada" mientras consulte /status.
// La app sondea cada ~1.5 s; 10 s sin consultas = la app se fue.
#define APP_TIMEOUT_MS 10000
static portMUX_TYPE appMux = portMUX_INITIALIZER_UNLOCKED;
static char     appIp[46] = "";
static uint32_t appLastSeenMs = 0;
static uint32_t appConnectedMs = 0;
static bool     appActive = false;
static volatile bool     flashOn          = false;
static volatile bool     sirenOn          = false;
static bool              apFallback       = false;

static Preferences prefs;
static httpd_handle_t controlServer = nullptr;
static httpd_handle_t streamServer  = nullptr;

// ─── 5. Cámara ───────────────────────────────────────────────────────────────

bool initCamera() {
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer   = LEDC_TIMER_0;
  c.pin_d0 = Y2_GPIO_NUM;  c.pin_d1 = Y3_GPIO_NUM;  c.pin_d2 = Y4_GPIO_NUM;
  c.pin_d3 = Y5_GPIO_NUM;  c.pin_d4 = Y6_GPIO_NUM;  c.pin_d5 = Y7_GPIO_NUM;
  c.pin_d6 = Y8_GPIO_NUM;  c.pin_d7 = Y9_GPIO_NUM;
  c.pin_xclk = XCLK_GPIO_NUM;   c.pin_pclk = PCLK_GPIO_NUM;
  c.pin_vsync = VSYNC_GPIO_NUM; c.pin_href = HREF_GPIO_NUM;
  c.pin_sccb_sda = SIOD_GPIO_NUM; c.pin_sccb_scl = SIOC_GPIO_NUM;
  c.pin_pwdn = PWDN_GPIO_NUM;   c.pin_reset = RESET_GPIO_NUM;
  c.xclk_freq_hz = XCLK_FREQ_HZ;
  c.pixel_format = PIXFORMAT_JPEG;   // El sensor comprime: el ESP32 no gasta CPU en eso
  c.frame_size   = FRAME_SIZE;
  c.jpeg_quality = JPEG_QUALITY;
  c.fb_count     = 2;                // Doble búfer: el sensor llena uno mientras copiamos el otro
  c.fb_location  = CAMERA_FB_IN_PSRAM;
  c.grab_mode    = CAMERA_GRAB_LATEST; // Siempre el frame más reciente (menos latencia)

  esp_err_t err = esp_camera_init(&c);
  if (err != ESP_OK) {
    Serial.printf("[CAM] esp_camera_init falló: 0x%x\n", err);
    return false;
  }
  sensor_t* s = esp_camera_sensor_get();
  Serial.printf("[CAM] Sensor PID=0x%04X (%s)\n", s->id.PID,
                s->id.PID == OV5640_PID ? "OV5640" : s->id.PID == OV2640_PID ? "OV2640" : "otro");
  // Si la imagen sale al revés: s->set_vflip(s, 1); s->set_hmirror(s, 1);
  // Descartar los primeros frames (exposición automática aún ajustándose)
  for (int i = 0; i < 3; i++) {
    camera_fb_t* fb = esp_camera_fb_get();
    if (fb) esp_camera_fb_return(fb);
  }
  return true;
}

/**
 * PRODUCTOR. Única tarea que llama a esp_camera_fb_get/return.
 * Copia el JPEG al búfer compartido y devuelve el frame-buffer enseguida.
 */
void cameraTask(void*) {
  uint32_t frames = 0, fpsT0 = millis();
  for (;;) {
    camera_fb_t* fb = esp_camera_fb_get();          // Bloquea hasta que el DMA tenga un frame
    if (!fb) { vTaskDelay(pdMS_TO_TICKS(20)); continue; }

    if (xSemaphoreTake(frameMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
      if (fb->len > latestCap) {                    // Crecer el búfer si el JPEG es más grande
        size_t newCap = fb->len + 16 * 1024;
        uint8_t* p = (uint8_t*)ps_realloc(latestJpeg, newCap);
        if (p) { latestJpeg = p; latestCap = newCap; }
      }
      if (fb->len <= latestCap) {
        memcpy(latestJpeg, fb->buf, fb->len);       // ~1 ms para 40 KB
        latestLen = fb->len;
        latestSeq++;
      }
      xSemaphoreGive(frameMutex);
    }
    esp_camera_fb_return(fb);                       // Devolver al DMA lo antes posible

    frames++;
    uint32_t now = millis();
    if (now - fpsT0 >= 2000) {
      cameraFps = frames * 1000.0f / (now - fpsT0);
      frames = 0; fpsT0 = now;
    }
    vTaskDelay(1);                                  // Cede CPU a tareas de igual prioridad
  }
}

/**
 * Copia el último frame a un búfer propio del llamador (que crece si hace falta).
 * Devuelve la secuencia copiada, o 0 si no hay frame.
 */
uint32_t copyLatestFrame(uint8_t** buf, size_t* cap, size_t* len) {
  uint32_t seq = 0;
  if (xSemaphoreTake(frameMutex, pdMS_TO_TICKS(200)) != pdTRUE) return 0;
  if (latestLen > 0) {
    if (latestLen > *cap) {
      size_t newCap = latestLen + 16 * 1024;
      uint8_t* p = (uint8_t*)ps_realloc(*buf, newCap);
      if (p) { *buf = p; *cap = newCap; }
    }
    if (latestLen <= *cap) {
      memcpy(*buf, latestJpeg, latestLen);
      *len = latestLen;
      seq = latestSeq;
    }
  }
  xSemaphoreGive(frameMutex);
  return seq;
}

// ─── 6. Detección de movimiento (CONSUMIDOR) ─────────────────────────────────
// Comparar bytes de JPEG no sirve: la compresión hace que un cambio mínimo de
// luz cambie casi todos los bytes. Por eso decodificamos a una miniatura en
// gris y comparamos el brillo por bloques contra un modelo de fondo.

#define THUMB_W (FRAME_W / 8)
#define THUMB_H (FRAME_H / 8)
#define BLOCKS_X (THUMB_W / BLOCK_PX)
#define BLOCKS_Y (THUMB_H / BLOCK_PX)
#define N_BLOCKS (BLOCKS_X * BLOCKS_Y)

static inline uint8_t rgb565ToGray(const uint8_t* px) {
  // jpg2rgb565 (esp_jpeg, sin swap) escribe cada píxel en little-endian
  uint16_t v = px[0] | (px[1] << 8);
  uint8_t r = (v >> 11) << 3, g = ((v >> 5) & 0x3F) << 2, b = (v & 0x1F) << 3;
  return (uint8_t)((r * 77 + g * 150 + b * 29) >> 8);  // Luminancia (BT.601)
}

/** Genera la evidencia: decodifica a 320×240 y recomprime con más compresión. */
void saveEvidence(const uint8_t* jpeg, size_t len) {
  const int w = FRAME_W / 2, h = FRAME_H / 2;
  uint8_t* rgb = (uint8_t*)ps_malloc(w * h * 2);
  if (!rgb) return;
  uint8_t* out = nullptr;
  size_t outLen = 0;
  if (jpg2rgb565(jpeg, len, rgb, JPG_SCALE_2X) &&
      fmt2jpg(rgb, w * h * 2, w, h, PIXFORMAT_RGB565, 30, &out, &outLen)) {
    // ~10-15 KB: cabe en el límite de adjuntos de EmailJS
    xSemaphoreTake(evidenceMutex, portMAX_DELAY);
    free(evidenceJpeg);
    evidenceJpeg = out;
    evidenceLen  = outLen;
    xSemaphoreGive(evidenceMutex);
  } else if (out) {
    free(out);
  }
  free(rgb);
}

void motionTask(void*) {
  uint8_t* jpeg = nullptr; size_t jpegCap = 0, jpegLen = 0;
  uint8_t* rgb  = (uint8_t*)ps_malloc(THUMB_W * THUMB_H * 2);
  float background[N_BLOCKS] = {0};
  uint32_t lastSeq = 0, analysed = 0;
  uint8_t streak = 0;

  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(DETECT_PERIOD_MS));
    uint32_t seq = copyLatestFrame(&jpeg, &jpegCap, &jpegLen);
    if (seq == 0 || seq == lastSeq || !rgb) continue;
    lastSeq = seq;
    if (!jpg2rgb565(jpeg, jpegLen, rgb, JPG_SCALE_8X)) continue;

    // Brillo promedio por bloque
    float cur[N_BLOCKS];
    for (int by = 0; by < BLOCKS_Y; by++) {
      for (int bx = 0; bx < BLOCKS_X; bx++) {
        uint32_t sum = 0;
        for (int y = 0; y < BLOCK_PX; y++) {
          const uint8_t* row = rgb + ((by * BLOCK_PX + y) * THUMB_W + bx * BLOCK_PX) * 2;
          for (int x = 0; x < BLOCK_PX; x++) sum += rgb565ToGray(row + x * 2);
        }
        cur[by * BLOCKS_X + bx] = sum / float(BLOCK_PX * BLOCK_PX);
      }
    }

    analysed++;
    if (analysed <= WARMUP_FRAMES) {                 // Aprender el fondo
      for (int i = 0; i < N_BLOCKS; i++)
        background[i] = (analysed == 1) ? cur[i] : background[i] * 0.7f + cur[i] * 0.3f;
      continue;
    }

    int changed = 0;
    for (int i = 0; i < N_BLOCKS; i++)
      if (fabsf(cur[i] - background[i]) > BLOCK_DIFF) changed++;
    lastChangedBlocks = changed;

    bool globalChange = changed > N_BLOCKS * GLOBAL_CHANGE_RATIO;
    bool motionPir    = USE_PIR && digitalRead(PIR_PIN) == HIGH;
    bool motionNow    = motionPir || (!globalChange && changed >= MIN_CHANGED_BLOCKS);

    if (globalChange) {
      // Prendieron la luz o la cámara reajustó exposición: re-aprender el fondo
      for (int i = 0; i < N_BLOCKS; i++) background[i] = cur[i];
      streak = 0;
      continue;
    }
    // Adaptación lenta solo donde NO hay movimiento (para no "absorber" al intruso)
    for (int i = 0; i < N_BLOCKS; i++)
      if (fabsf(cur[i] - background[i]) <= BLOCK_DIFF)
        background[i] += BG_LEARN_RATE * (cur[i] - background[i]);

    streak = motionNow ? streak + 1 : 0;
    bool armed = securityMode != MODE_DISARMED;
    if (armed && streak >= CONFIRM_FRAMES &&
        (motionSeq == 0 || millis() - motionUptimeMs > MOTION_COOLDOWN_MS)) {
      saveEvidence(jpeg, jpegLen);                   // Primero la foto…
      time_t now = time(nullptr);
      motionEpoch    = now > 1700000000 ? now : 0;
      motionUptimeMs = millis();
      motionSeq      = motionSeq + 1;                // …luego publicar el evento
      streak = 0;
      Serial.printf("[MOTION] Evento #%u (%d/%d bloques)\n", motionSeq, changed, N_BLOCKS);
#if USE_BUZZER
      if (securityMode == MODE_AWAY) {
        digitalWrite(BUZZER_PIN, HIGH); vTaskDelay(pdMS_TO_TICKS(150));
        digitalWrite(BUZZER_PIN, sirenOn ? HIGH : LOW);
      }
#endif
    }
  }
}

// ─── 7. Servidor HTTP ────────────────────────────────────────────────────────

static void cors(httpd_req_t* req) {
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_set_hdr(req, "Cache-Control", "no-store");
}

/** Lee ?key=value de la URL. Devuelve true si existe. */
static bool queryParam(httpd_req_t* req, const char* key, char* out, size_t outLen) {
  char query[64];
  if (httpd_req_get_url_query_str(req, query, sizeof(query)) != ESP_OK) return false;
  return httpd_query_key_value(query, key, out, outLen) == ESP_OK;
}

static esp_err_t sendJson(httpd_req_t* req, const char* json) {
  cors(req);
  httpd_resp_set_type(req, "application/json");
  return httpd_resp_sendstr(req, json);
}

static esp_err_t sendError(httpd_req_t* req, const char* status, const char* msg) {
  char json[96];
  snprintf(json, sizeof(json), "{\"error\":\"%s\"}", msg);
  httpd_resp_set_status(req, status);
  return sendJson(req, json);
}

// IP del cliente de una petición (las conexiones IPv4 llegan como IPv6 "mapeadas")
static void peerIp(httpd_req_t* req, char* out, size_t n) {
  struct sockaddr_storage addr;
  socklen_t len = sizeof(addr);
  strlcpy(out, "?", n);
  if (getpeername(httpd_req_to_sockfd(req), (struct sockaddr*)&addr, &len) != 0) return;
  if (addr.ss_family == AF_INET) {
    inet_ntop(AF_INET, &((struct sockaddr_in*)&addr)->sin_addr, out, n);
  } else if (addr.ss_family == AF_INET6) {
    struct sockaddr_in6* a6 = (struct sockaddr_in6*)&addr;
    inet_ntop(AF_INET, &a6->sin6_addr.un.u32_addr[3], out, n);   // ::ffff:a.b.c.d → a.b.c.d
  }
}

// Llamado en cada GET /status: detecta cuándo la app empieza (o vuelve) a consultar
static void trackAppPoll(httpd_req_t* req) {
  char ip[46];
  peerIp(req, ip, sizeof(ip));
  uint32_t now = millis();
  bool wasActive, sameIp, seenBefore;
  uint32_t silentMs;
  portENTER_CRITICAL(&appMux);
  wasActive = appActive;
  seenBefore = appLastSeenMs != 0;
  sameIp = strcmp(ip, appIp) == 0;
  silentMs = now - appLastSeenMs;
  appLastSeenMs = now;
  if (!wasActive || !sameIp) { strlcpy(appIp, ip, sizeof(appIp)); appConnectedMs = now; }
  appActive = true;
  portEXIT_CRITICAL(&appMux);

  if (!wasActive && sameIp && seenBefore) {
    Serial.printf("[APP] App reconectada desde %s tras %u s sin consultas\n", ip, silentMs / 1000);
  } else if (!wasActive || !sameIp) {
    Serial.printf("[APP] App conectada desde %s (consulta /status cada ~1.5 s) · modo %s\n",
                  ip, MODE_NAMES[securityMode]);
  }
}

// Llamado desde loop(): avisa una vez cuando la app deja de consultar
static void checkAppTimeout() {
  char ip[46];
  uint32_t connectedFor = 0;
  bool lost = false;
  portENTER_CRITICAL(&appMux);
  if (appActive && millis() - appLastSeenMs > APP_TIMEOUT_MS) {
    appActive = false;
    lost = true;
    connectedFor = appLastSeenMs - appConnectedMs;
    strlcpy(ip, appIp, sizeof(ip));
  }
  portEXIT_CRITICAL(&appMux);
  if (lost) {
    Serial.printf("[APP] La app %s dejó de consultar hace %d s (estuvo conectada %u s) — "
                  "¿se cerró, se bloqueó el teléfono o cambió de red?\n",
                  ip, APP_TIMEOUT_MS / 1000, connectedFor / 1000);
  }
}

esp_err_t statusHandler(httpd_req_t* req) {
  trackAppPoll(req);
  time_t now = time(nullptr);
  char json[640];
  snprintf(json, sizeof(json),
    "{\"device\":\"sentrynode\",\"fw\":2,"
    "\"mode\":\"%s\",\"armed\":%s,"
    "\"motion_seq\":%u,\"motion_detected\":%s,\"motion_uptime_ms\":%u,\"motion_epoch\":%ld,"
    "\"changed_blocks\":%u,\"total_blocks\":%d,"
    "\"fps\":%.1f,\"rssi\":%d,\"ip\":\"%s\",\"net\":\"%s\","
    "\"uptime_ms\":%u,\"epoch\":%ld,\"time_synced\":%s,"
    "\"streaming\":%s,\"stream_clients\":%u,\"flash\":%s,\"siren\":%s,"
    "\"free_heap\":%u,\"free_psram\":%u}",
    MODE_NAMES[securityMode], securityMode != MODE_DISARMED ? "true" : "false",
    motionSeq, (motionSeq && millis() - motionUptimeMs < 3000) ? "true" : "false",
    motionUptimeMs, (long)motionEpoch,
    lastChangedBlocks, N_BLOCKS,
    cameraFps, apFallback ? 0 : WiFi.RSSI(),
    apFallback ? WiFi.softAPIP().toString().c_str() : WiFi.localIP().toString().c_str(),
    apFallback ? "ap" : "sta",
    millis(), now > 1700000000 ? (long)now : 0L, now > 1700000000 ? "true" : "false",
    streamClients.load() ? "true" : "false", streamClients.load(),
    flashOn ? "true" : "false", sirenOn ? "true" : "false",
    ESP.getFreeHeap(), ESP.getFreePsram());
  return sendJson(req, json);
}

esp_err_t captureHandler(httpd_req_t* req) {
  uint8_t* buf = nullptr; size_t cap = 0, len = 0;
  if (copyLatestFrame(&buf, &cap, &len) == 0) {
    free(buf);
    return sendError(req, "503 Service Unavailable", "no frame");
  }
  cors(req);
  httpd_resp_set_type(req, "image/jpeg");
  esp_err_t res = httpd_resp_send(req, (const char*)buf, len);
  free(buf);
  return res;
}

esp_err_t motionJpegHandler(httpd_req_t* req) {
  // Copiar bajo mutex y enviar sin él: un cliente lento no bloquea a motionTask
  xSemaphoreTake(evidenceMutex, portMAX_DELAY);
  size_t len = evidenceLen;
  uint8_t* copy = len ? (uint8_t*)ps_malloc(len) : nullptr;
  if (copy) memcpy(copy, evidenceJpeg, len);
  xSemaphoreGive(evidenceMutex);

  if (!copy) return sendError(req, "404 Not Found", "no evidence yet");
  char seq[12];
  snprintf(seq, sizeof(seq), "%u", motionSeq);
  cors(req);
  httpd_resp_set_hdr(req, "X-Motion-Seq", seq);
  httpd_resp_set_type(req, "image/jpeg");
  esp_err_t res = httpd_resp_send(req, (const char*)copy, len);
  free(copy);
  return res;
}

esp_err_t modeHandler(httpd_req_t* req) {
  char value[16];
  if (queryParam(req, "value", value, sizeof(value))) {
    int m = -1;
    for (int i = 0; i < 3; i++) if (strcmp(value, MODE_NAMES[i]) == 0) m = i;
    if (m < 0) return sendError(req, "400 Bad Request", "mode must be disarmed|home|away");
    if (m != securityMode) {
      securityMode = (SecurityMode)m;
      prefs.putUChar("mode", m);                    // Sobrevive a un reinicio
      Serial.printf("[MODE] -> %s\n", MODE_NAMES[m]);
      if (securityMode == MODE_DISARMED && sirenOn) {
        sirenOn = false;
#if USE_BUZZER
        digitalWrite(BUZZER_PIN, LOW);
#endif
      }
    }
  }
  char json[48];
  snprintf(json, sizeof(json), "{\"mode\":\"%s\"}", MODE_NAMES[securityMode]);
  return sendJson(req, json);
}

/** Lee ?state=0|1. Devuelve -1 si falta, -2 si es inválido. */
static int readState(httpd_req_t* req) {
  char v[4];
  if (!queryParam(req, "state", v, sizeof(v))) return -1;
  if (strcmp(v, "1") == 0) return 1;
  if (strcmp(v, "0") == 0) return 0;
  return -2;
}

esp_err_t flashHandler(httpd_req_t* req) {
  int st = readState(req);
  if (st == -2) return sendError(req, "400 Bad Request", "state must be 0|1");
  if (st >= 0) { flashOn = st; digitalWrite(FLASH_LED_PIN, flashOn); }
  return sendJson(req, flashOn ? "{\"flash\":true}" : "{\"flash\":false}");
}

esp_err_t sirenHandler(httpd_req_t* req) {
  int st = readState(req);
  if (st == -2) return sendError(req, "400 Bad Request", "state must be 0|1");
  if (st >= 0) {
    sirenOn = st;
#if USE_BUZZER
    digitalWrite(BUZZER_PIN, sirenOn);
#endif
  }
  return sendJson(req, sirenOn ? "{\"siren\":true}" : "{\"siren\":false}");
}

esp_err_t rootHandler(httpd_req_t* req) {
  const char* html =
    "<!DOCTYPE html><html><head><meta name='viewport' content='width=device-width'>"
    "<title>SentryNode</title></head><body style='background:#0a0e17;color:#dfe2ef;font-family:monospace'>"
    "<h3>SentryNode ESP32-CAM</h3><img id='v' style='width:100%;max-width:640px'>"
    "<p><a style='color:#4cd7f6' href='/status'>/status</a> · "
    "<a style='color:#4cd7f6' href='/capture'>/capture</a> · "
    "<a style='color:#4cd7f6' href='/motion.jpg'>/motion.jpg</a></p>"
    "<script>document.getElementById('v').src='http://'+location.hostname+':81/stream'</script>"
    "</body></html>";
  httpd_resp_set_type(req, "text/html");
  return httpd_resp_sendstr(req, html);
}

/**
 * GET :81/stream — MJPEG.
 * Corre en la tarea propia del servidor de video, así nunca bloquea al puerto 80.
 * Envía cada frame NUEVO (por número de secuencia) como una parte multipart.
 * Si el cliente deja de leer, el envío falla por timeout del socket (send_wait_timeout)
 * y el bucle termina, liberando el servidor para la siguiente conexión.
 */
#define PART_BOUNDARY "sentryframe"
esp_err_t streamHandler(httpd_req_t* req) {
  uint8_t* buf = nullptr; size_t cap = 0, len = 0;
  uint32_t lastSeq = 0, lastFrameMs = millis();
  char part[96];

  httpd_resp_set_type(req, "multipart/x-mixed-replace;boundary=" PART_BOUNDARY);
  cors(req);
  httpd_resp_set_hdr(req, "X-Framerate", "15");
  streamClients++;
  char ip[46];
  peerIp(req, ip, sizeof(ip));
  uint32_t startedMs = millis();
  Serial.printf("[STREAM] Video abierto por %s (clientes: %u)\n", ip, streamClients.load());

  esp_err_t res = ESP_OK;
  while (res == ESP_OK) {
    uint32_t seq = copyLatestFrame(&buf, &cap, &len);
    if (seq == 0 || seq == lastSeq) {
      if (millis() - lastFrameMs > 3000) { res = ESP_FAIL; break; }  // Cámara detenida
      vTaskDelay(pdMS_TO_TICKS(10));
      continue;
    }
    lastSeq = seq;
    lastFrameMs = millis();
    int hlen = snprintf(part, sizeof(part),
      "\r\n--" PART_BOUNDARY "\r\nContent-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n", len);
    res = httpd_resp_send_chunk(req, part, hlen);
    if (res == ESP_OK) res = httpd_resp_send_chunk(req, (const char*)buf, len);
  }
  free(buf);
  streamClients--;
  Serial.printf("[STREAM] Video cerrado por %s tras %u s (clientes: %u)\n",
                ip, (millis() - startedMs) / 1000, streamClients.load());
  return res;
}

void startServers() {
  httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
  cfg.server_port      = 80;
  cfg.ctrl_port        = 32768;
  cfg.max_uri_handlers = 10;
  cfg.lru_purge_enable = true;      // Si se llenan los sockets, cierra el más viejo
  cfg.core_id          = 0;

  httpd_uri_t routes[] = {
    { "/",           HTTP_GET, rootHandler,       nullptr },
    { "/status",     HTTP_GET, statusHandler,     nullptr },
    { "/capture",    HTTP_GET, captureHandler,    nullptr },
    { "/motion.jpg", HTTP_GET, motionJpegHandler, nullptr },
    { "/mode",       HTTP_GET, modeHandler,       nullptr },
    { "/flash",      HTTP_GET, flashHandler,      nullptr },
    { "/siren",      HTTP_GET, sirenHandler,      nullptr },
  };
  if (httpd_start(&controlServer, &cfg) == ESP_OK) {
    for (auto& r : routes) httpd_register_uri_handler(controlServer, &r);
  }

  // Segundo servidor = segunda tarea: el stream (bucle largo) no frena el control
  cfg.server_port       = 81;
  cfg.ctrl_port         = 32769;
  cfg.max_open_sockets  = 3;
  cfg.send_wait_timeout = 3;        // s: si el cliente no lee en 3 s, se corta
  cfg.core_id           = 0;
  httpd_uri_t stream = { "/stream", HTTP_GET, streamHandler, nullptr };
  if (httpd_start(&streamServer, &cfg) == ESP_OK) {
    httpd_register_uri_handler(streamServer, &stream);
  }
  Serial.println("[HTTP] Control :80  ·  Video :81/stream");
}

// ─── 8. Wi-Fi ────────────────────────────────────────────────────────────────

void onWifiEvent(WiFiEvent_t event) {
  switch (event) {
    case ARDUINO_EVENT_WIFI_STA_GOT_IP:
      Serial.printf("[WIFI] Conectado. IP=%s  RSSI=%d dBm\n",
                    WiFi.localIP().toString().c_str(), WiFi.RSSI());
      break;
    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      Serial.println("[WIFI] Desconectado del hotspot — reintentando…");
      break;
    case ARDUINO_EVENT_WIFI_AP_STACONNECTED:     // Modo AP de rescate
      Serial.printf("[AP] Un teléfono se unió a la red del ESP32 (conectados: %d)\n",
                    WiFi.softAPgetStationNum());
      break;
    case ARDUINO_EVENT_WIFI_AP_STADISCONNECTED:
      Serial.printf("[AP] Un teléfono salió de la red del ESP32 (conectados: %d)\n",
                    WiFi.softAPgetStationNum());
      break;
    default: break;
  }
}

void startWifi() {
  WiFi.onEvent(onWifiEvent);
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(MDNS_HOSTNAME);
  WiFi.setSleep(false);             // Sin ahorro de energía del radio: menos latencia
  WiFi.setAutoReconnect(true);      // El core reintenta solo si se cae el hotspot
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  Serial.printf("[WIFI] Conectando a \"%s\"", WIFI_SSID);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_CONNECT_MS) {
    digitalWrite(STATUS_LED_PIN, !digitalRead(STATUS_LED_PIN));
    Serial.print('.');
    delay(250);
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    configTzTime(TZ_INFO, "pool.ntp.org", "time.google.com");  // Hora real para las alertas
    if (MDNS.begin(MDNS_HOSTNAME)) MDNS.addService("http", "tcp", 80);
    Serial.println("==============================================");
    Serial.printf (" IP del ESP32 (ponla en la app): %s\n", WiFi.localIP().toString().c_str());
    Serial.println("==============================================");
  } else {
    // Modo rescate: AP propio. El teléfono pierde internet (no habrá correos).
    apFallback = true;
    WiFi.disconnect(true);
    WiFi.mode(WIFI_AP);
    char ssid[24];
    snprintf(ssid, sizeof(ssid), "SentryNode-%04X", (uint16_t)(ESP.getEfuseMac() >> 32));
    WiFi.softAP(ssid, FALLBACK_AP_PASS);
    Serial.printf("[WIFI] Hotspot no encontrado. AP de rescate \"%s\" en %s\n",
                  ssid, WiFi.softAPIP().toString().c_str());
  }
}

// ─── 9. setup / loop ─────────────────────────────────────────────────────────

void setup() {
  // El ESP32-CAM con USB débil suele reiniciarse por caída de tensión al
  // arrancar Wi-Fi + cámara. Se desactiva el detector de brownout; lo correcto
  // es alimentarlo con una fuente de 5 V / 2 A.
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);
  Serial.begin(115200);
  Serial.println("\n=== SentryNode ESP32-CAM ===");

  pinMode(FLASH_LED_PIN, OUTPUT);  digitalWrite(FLASH_LED_PIN, LOW);
  pinMode(STATUS_LED_PIN, OUTPUT); digitalWrite(STATUS_LED_PIN, HIGH);  // apagado
#if USE_BUZZER
  pinMode(BUZZER_PIN, OUTPUT); digitalWrite(BUZZER_PIN, LOW);
#endif
#if USE_PIR
  pinMode(PIR_PIN, INPUT_PULLDOWN);
#endif

  if (!psramFound()) {
    Serial.println("[ERROR] Sin PSRAM. En el IDE: Herramientas > PSRAM > Enabled");
  }

  prefs.begin("sentry", false);
  uint8_t savedMode = prefs.getUChar("mode", MODE_DISARMED);
  securityMode = savedMode <= MODE_AWAY ? (SecurityMode)savedMode : MODE_DISARMED;
  Serial.printf("[MODE] Modo restaurado: %s\n", MODE_NAMES[securityMode]);

  jpgSetRgb565BE(false);   // fmt2jpg debe leer el RGB565 little-endian que produce jpg2rgb565
  frameMutex    = xSemaphoreCreateMutex();
  evidenceMutex = xSemaphoreCreateMutex();

  if (!initCamera()) {
    Serial.println("[ERROR] Cámara no inicializó. Reiniciando en 3 s…");
    delay(3000);
    ESP.restart();
  }

  startWifi();
  startServers();

  xTaskCreatePinnedToCore(cameraTask, "camera", 4096, nullptr, 5, nullptr, 1);
  xTaskCreatePinnedToCore(motionTask, "motion", 8192, nullptr, 2, nullptr, 0);
  Serial.println("[SETUP] Listo.");
}

void loop() {
  // loop() es una tarea de prioridad 1 en el core 1. Solo hace mantenimiento.
  static uint32_t lastBlink = 0, disconnectedSince = 0;
  bool connected = apFallback || WiFi.status() == WL_CONNECTED;

  if (connected) {
    digitalWrite(STATUS_LED_PIN, LOW);                    // Fijo = conectado
    disconnectedSince = 0;
  } else {
    if (millis() - lastBlink > 300) {                     // Parpadeo = sin red
      digitalWrite(STATUS_LED_PIN, !digitalRead(STATUS_LED_PIN));
      lastBlink = millis();
    }
    if (!disconnectedSince) disconnectedSince = millis();
    if (millis() - disconnectedSince > 30000) {           // Respaldo del auto-reconnect
      Serial.println("[WIFI] 30 s sin red — forzando reconexión");
      WiFi.reconnect();
      disconnectedSince = millis();
    }
  }
  checkAppTimeout();
  delay(100);
}
