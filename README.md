# SentryNode — Detección de intrusos IoT (ESP32-CAM + React Native)

Parcial de Desarrollo Móvil, Proyecto 1. Una ESP32-CAM transmite video MJPEG y detecta
movimiento analizando la imagen. La app (Expo / React Native) muestra el video en vivo,
vigila en segundo plano con un Foreground Service, arma y desarma el sistema por franjas
horarias y envía un correo con la foto del intruso.

```
┌──────────────── Celular (hotspot + app) ───────────────┐          ┌──────────── ESP32-CAM (STA) ────────────┐
│ UI (Expo Router)                                      │  Wi-Fi   │ cameraTask  (core 1)  PRODUCTOR         │
│  ├ Streaming  → WebView <img src=":81/stream">  ◀─────┼── MJPEG ─┤   fb_get → copia JPEG → fb_return       │
│  ├ Horarios / Config                                  │  :81     │        ▼                                │
│  └ Alertas (fotos de evidencia)                       │          │   [último frame]  ◀── frameMutex        │
│ useSecurityStore  ◀── useSyncExternalStore ──┐        │          │        ├──▶ httpd :81 /stream           │
│                                              │        │  HTTP    │        └──▶ motionTask (core 0)         │
│ monitor.ts (motor, sin React) ───────────────┼────────┼─ JSON ──▶│ httpd :80 /status /mode /motion.jpg …   │
│   corre dentro del Foreground Service        │        │  :80     │ Pila Wi-Fi/lwIP (core 0)                │
│   (react-native-background-actions)          │        │          └─────────────────────────────────────────┘
│        │ HTTPS (datos móviles)               │        │
│        ▼                                     │        │
│   EmailJS API ──▶ correo con intruso.jpg     │        │
└──────────────────────────────────────────────────────┘
```

## Estructura

| Ruta | Qué hace |
|---|---|
| `esp32_firmware/sentry_esp32_cam/sentry_esp32_cam.ino` | Firmware: Wi-Fi STA (AP de rescate), cámara productor/consumidor, detección por bloques, 2 servidores HTTP |
| `src/services/monitor.ts` | Motor de vigilancia: sondeo, eventos, resincronización, cola de correos con reintentos |
| `src/services/foregroundService.ts` | Foreground Service de Android (tipo `connectedDevice`) que ejecuta el motor |
| `src/services/esp32Api.ts` | Cliente HTTP: timeouts, errores tipados, reintentos solo de fallas transitorias |
| `src/services/schedule.ts` | Franjas horarias (incluye las que cruzan medianoche) y regla manual vs. horario |
| `src/services/emailService.ts` | Correo vía API REST de EmailJS con la foto adjunta |
| `src/services/storage.ts` | Persistencia (AsyncStorage), compartida por UI y motor |
| `src/store/useSecurityStore.ts` | Estado de la UI; se suscribe al motor |
| `src/screens/*` | Streaming, Horarios/Configuración, Alertas |
| `plugins/withSentryAndroid.js` | Config plugin: tipo del Foreground Service y HTTP sin cifrar en el manifest |

## Puesta en marcha

### 1. Firmware

1. Arduino IDE 2.x con **esp32 by Espressif 3.x**. Placa: **AI Thinker ESP32-CAM**, PSRAM **Enabled**.
2. Copia `secrets.example.h` como `secrets.h` (misma carpeta del sketch) y pon el nombre y la clave
   del hotspot de tu celular (banda de **2.4 GHz**, el ESP32 no ve 5 GHz). `secrets.h` está en
   `.gitignore` para que la clave no se publique.
3. Sube el sketch (GPIO0 a GND para programar, quítalo y reinicia).
4. Monitor serie a 115200: verás `IP del ESP32 (ponla en la app): 10.x.x.x`.
   Desde un PC conectado al mismo hotspot puedes abrir `http://<IP>/` y ver el video.

El LED rojo de la placa queda **fijo** si está conectado y **parpadea** si no tiene red.
Si no encuentra el hotspot en 20 s, crea la red `SentryNode-XXXX` (clave `sabana2026`) en `192.168.4.1`;
en ese modo hay video, pero el teléfono no tiene internet y no salen correos.

Ajuste fino de la detección: `/status` devuelve `changed_blocks` (zonas con cambio, de 48). Con la
escena quieta debe estar en 0–1; si no, sube `BLOCK_DIFF`. Si no detecta a una persona, bájalo o
baja `MIN_CHANGED_BLOCKS`.

### 2. EmailJS (una sola vez)

1. Account → Security → activar **Allow EmailJS API for non-browser applications**.
2. Template: destinatario `{{to_email}}`; variables `{{alert_timestamp}}`, `{{alert_type}}`,
   `{{alert_description}}`, `{{security_mode}}`, `{{esp32_ip}}`.
3. Template → **Attachments** → *Variable Attachment*, parámetro `snapshot`, nombre `intruso.jpg`, tipo `image/jpeg`.
4. En la app: Horarios → Alertas Email → llenar los IDs → **Enviar email de prueba** (lleva una foto actual).

### 3. App

```powershell
npm install
npx expo start              # Expo Go: todo funciona, pero solo vigila con la app abierta
```

El Foreground Service necesita un **development build** (Expo Go no trae ese módulo nativo):

```powershell
npx expo run:android        # con Android Studio instalado y el celular por USB
# o, sin Android Studio, compilando en la nube de Expo:
npx eas-cli@latest build --profile development --platform android
```

Luego, en la app: Horarios → ESP32 → escribe la IP del monitor serie → **Probar conexión**.

---

# Guía para la defensa técnica

Las respuestas apuntan a lo que pide la rúbrica: explicar la arquitectura de red, justificar los
flujos asíncronos, el manejo de estados del hardware y defenderse en las contrapreguntas.

## 1. Arquitectura de red

**¿Qué topología usan y por qué?**
El celular comparte su hotspot y el ESP32 se une como estación (STA). Así el teléfono está en la
misma LAN que la cámara y además conserva sus datos móviles para mandar el correo. Si el ESP32
fuera Access Point, el teléfono se conectaría a él y quedaría **sin internet**: no saldría la alerta.
El AP solo queda como modo de rescate.

**¿Qué protocolos usan, capa por capa?**
802.11 (Wi-Fi 2.4 GHz, WPA2) → IP → **TCP** → HTTP/1.1. El control es petición/respuesta con JSON
(puerto 80). El video es **MJPEG**: una sola respuesta HTTP `multipart/x-mixed-replace` que nunca
termina; cada parte es un JPEG completo, separada por un *boundary*. El correo sale por **HTTPS**
(TLS sobre TCP) a la API de EmailJS. No usamos UDP: el video MJPEG necesita entrega confiable y en
orden, porque un JPEG con un byte perdido no se decodifica.

**¿Por qué MJPEG y no WebSockets?**
El sensor ya entrega JPEG por hardware, así que el ESP32 no recomprime nada, y el `<img>` de cualquier
navegador o WebView reproduce MJPEG de forma nativa. Con WebSockets habría que hacer handshake,
enmarcar binario y decodificar cada frame en JS, lo que pasa los bytes por el hilo de JavaScript.
Lo que se pierde: MJPEG no tiene compresión entre frames (más ancho de banda que H.264).

**¿Por qué dos puertos (80 y 81)?**
`esp_http_server` atiende cada servidor en **una sola tarea**. El handler del stream es un bucle
infinito: si estuviera en el puerto 80, `/status` y `/mode` quedarían bloqueados mientras alguien
ve el video. Con dos servidores hay dos tareas independientes.

**¿Cómo se entera la app de un movimiento?**
Sondeo (polling) de `GET /status` cada 1.5 s. El firmware tiene un contador `motion_seq` que sube
con cada evento confirmado. La app guarda el último valor visto: si subió, hubo eventos nuevos.
*Contrapregunta: ¿por qué no un booleano?* Un booleano puede encenderse y apagarse entre dos sondeos
(se pierde el evento) o seguir en `true` varios sondeos (se duplica). El contador no se pierde ni se
duplica. *¿Por qué no push?* Para push, el ESP32 tendría que conocer la IP del teléfono o mantener
un WebSocket abierto, que se rompe cada vez que Android duerme la red. El sondeo es más robusto, y
con 1.5 s la latencia es aceptable.

**¿Cómo sabe la app la IP del ESP32?**
El DHCP del hotspot se la asigna y el firmware la imprime por el monitor serie; se escribe en la
app. También responde por mDNS como `sentrynode.local` (útil desde un PC; Android no resuelve
`.local` de forma fiable en las apps).

## 2. Firmware y concurrencia en el ESP32

**¿Cómo se organizan las tareas?** (FreeRTOS, 2 núcleos)
- `cameraTask` (core 1, prioridad 5): **único** que toca la cámara. Toma el frame del DMA, lo copia al
  búfer "último frame" y lo devuelve enseguida (patrón productor/consumidor).
- Servidor `:81` (stream) y `motionTask` (core 0): consumidores; copian el último frame bajo un mutex.
- Servidor `:80`: endpoints de control.
- `loop()` (core 1, prioridad 1): solo LED de estado y respaldo de reconexión Wi-Fi.
- La pila Wi-Fi/lwIP de Espressif corre en el core 0.

**¿Por qué copiar el frame en vez de enviarlo directo del frame-buffer?**
Los frame-buffers son del DMA de la cámara (hay 2). Si un cliente Wi-Fi lento retiene uno mientras
se envía, el sensor se queda sin dónde escribir (`FB-OVF`) y la detección se detiene. Copiar ~40 KB
tarda ~1 ms y desacopla la cámara de la red.

**¿Qué protege el mutex y qué pasa si no está?**
`frameMutex` protege el búfer del último frame (puntero, largo, secuencia). Sin él, el stream podría
leer un JPEG a medio escribir y mandar una imagen corrupta, o leer un puntero que `ps_realloc` acaba
de liberar (crash). `evidenceMutex` protege la foto del evento. Los valores pequeños (`motionSeq`, modo)
son de 32 bits y tienen un solo escritor, así que su lectura es atómica.

**¿Cómo detectan movimiento?**
1. Se decodifica el JPEG a 1/8 de escala (640×480 → 80×60) y se pasa a **luminancia** (gris).
2. La imagen se divide en 48 bloques de 10×10 y se compara el brillo promedio de cada bloque con un
   **modelo de fondo**.
3. Hay movimiento si cambian ≥3 bloques, y se confirma si se repite en **2 análisis seguidos**
   (filtra ruido del sensor).
4. Si cambia >80 % de la imagen, es un cambio de luz (alguien prendió el bombillo o la cámara
   reajustó la exposición): se re-aprende el fondo y no se alerta.
5. El fondo se adapta lento (5 %) solo en los bloques **sin** movimiento, para seguir sombras y nubes
   sin "absorber" al intruso.

*Contrapregunta: ¿por qué no comparar los bytes del JPEG?* JPEG es compresión entrópica: un cambio
mínimo de luz cambia casi todos los bytes del archivo. Hay que comparar píxeles decodificados.

**¿Qué pasa si el ESP32 se reinicia?**
El modo armado se guarda en NVS (`Preferences`), así que un corte de luz no desarma el sistema. La app
detecta el reinicio porque `uptime_ms` baja; ahí reinicia su referencia del contador. Además, si el
modo del ESP32 no coincide con el de la app, la app se lo vuelve a enviar.

**¿Por qué desactivan el brownout detector?**
Al arrancar Wi-Fi y cámara a la vez hay picos de corriente; con un cable USB débil, el voltaje cae
y el chip se reinicia. Es una mitigación: lo correcto es una fuente de 5 V / 2 A.

## 3. App: hilos, asincronía y segundo plano

**¿Cuántos hilos hay en la app?**
JavaScript corre en **un solo hilo** con *event loop*. `fetch` no bloquea: la E/S de red ocurre en
hilos nativos (OkHttp en Android) y el resultado vuelve como Promesa. La UI la pinta el hilo principal
nativo. El video lo decodifica el motor del WebView en sus propios hilos, sin pasar por JS.

**¿Por qué `setTimeout` encadenado y no `setInterval`?**
Con `setInterval`, si el ESP32 tarda más que el intervalo, las peticiones se acumulan. Encadenando,
la siguiente consulta se programa cuando termina la anterior: nunca hay dos a la vez.

**¿Qué es el Foreground Service y por qué lo necesitan?**
Android congela las apps en segundo plano; `BackgroundFetch`/WorkManager corren como mínimo cada
~15 min. Un Foreground Service es un componente nativo que Android no mata porque muestra una
**notificación persistente** obligatoria. Lo arranca `react-native-background-actions`, que ejecuta
el motor como tarea *HeadlessJS*. Su tipo es `connectedDevice` (obligatorio desde Android 14); se
eligió sobre `dataSync`, que en Android 15 tiene un límite de 6 h al día. Se declara con un config
plugin porque `android/` se regenera en cada build.

*Contrapregunta: ¿y en iOS?* iOS no tiene Foreground Services. Una app solo puede seguir activa en
segundo plano con modos especiales (audio, ubicación, VoIP). Ahí la vigilancia continua dependería
de que la app esté abierta, o habría que mover el envío del correo al ESP32.

**¿Por qué la lógica de vigilancia no está en una pantalla?**
Porque el servicio corre aunque no haya pantallas montadas. `monitor.ts` no depende de React; la UI
solo se suscribe con `useSyncExternalStore`. Todo comparte el mismo hilo JS, así que no hay
condiciones de carrera entre el servicio y la UI.

**¿Qué condiciones de carrera controlan?**
- Dos cadenas de sondeo (ej. el servicio reinicia el motor): cada cadena tiene un `loopId` y la vieja
  se detiene sola.
- Petición colgada al detener: `AbortController` la cancela.
- Correos duplicados: la cola tiene un flag `emailBusy`; solo un envío a la vez.
- Doble toque en flash/sirena: el botón se deshabilita mientras hay un comando en curso.

## 4. Errores y resiliencia

| Falla | Qué pasa |
|---|---|
| ESP32 no responde | Timeout de 2.5 s con `AbortController` (sin él, `fetch` espera ~60 s) |
| 2 fallas seguidas | Estado "sin conexión"; el sondeo baja con backoff exponencial 1.5 → 3 → 6 → 10 s |
| Cámara caída 45 s con el sistema armado | Alerta "Cámara sin conexión" (alguien pudo desenchufarla) |
| Vuelve la cámara | El motor la ve en `/status` y el video se reconecta solo |
| Video congelado | El ESP32 corta el stream si el cliente no lee en 3 s (`send_wait_timeout`); el WebView reintenta con backoff |
| Comando falla por red | Hasta 3 intentos (300, 600 ms). Es seguro porque los comandos son **idempotentes** (fijan un valor, no lo alternan) |
| Error 4xx o JSON inválido | No se reintenta: repetir no lo arregla. Se valida la forma del JSON |
| Sin internet para el correo | La alerta queda en cola y se reintenta con backoff (20 s, 40 s, 80 s…, hasta 6 veces) |
| EmailJS 4xx (mala config) | Se marca el error en la alerta y no se insiste; se puede reintentar a mano |
| Hotspot se cae | El ESP32 reintenta solo (`setAutoReconnect`) y fuerza `reconnect()` cada 30 s |
| ESP32 sin hotspot al arrancar | AP de rescate `SentryNode-XXXX` |
| ESP32 se reinicia | Modo restaurado desde NVS; la app detecta el reinicio por `uptime_ms` |

## 5. Horarios y alertas

**¿Cómo se combinan el modo manual y los horarios?**
La selección manual **manda hasta que el horario cambie de estado**. Si a las 9:00 (franja "Fuera de
casa" activa) desarmas, queda desarmado hasta las 18:00, cuando termina la franja. Si se solapan dos
franjas activas, gana la más estricta. Las franjas que cruzan medianoche (22:00 → 07:00) pertenecen
al día en que empiezan.

**¿Cómo es la evidencia y la marca de tiempo?**
Al confirmar un evento, el ESP32 decodifica el frame a 320×240 y lo recomprime con más compresión
(~10-15 KB) para que quepa en el límite de EmailJS. La app la descarga de `/motion.jpg` y la manda
como adjunto (data URL base64). La hora sale del reloj del ESP32, sincronizado por **NTP**
(UTC-5). Si no hay NTP, la app la reconstruye con `uptime_ms − motion_uptime_ms`.

## 6. Seguridad (limitaciones reconocidas)

El Wi-Fi va cifrado con WPA2, pero dentro de la red el HTTP va sin cifrar y la API no tiene
autenticación: cualquiera conectado al hotspot podría desarmar la cámara. Las claves de EmailJS
están en el teléfono. Para producción: un token en cada petición (o HTTPS en el ESP32), las
credenciales fuera del código y el correo enviado desde un backend propio.
