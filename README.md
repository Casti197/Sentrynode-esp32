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
│   Gmail API ──▶ correo con intruso.jpg       │        │
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
| `src/services/emailService.ts` | Correo con la foto adjunta: Gmail API (principal) o EmailJS (respaldo) |
| `src/services/googleAuth.ts` · `gmailService.ts` | Inicio de sesión OAuth con Google y armado del mensaje MIME para Gmail |
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

### 2. Correo de alerta

Dos opciones (se elige en Horarios → Alertas Email):
- **Gmail API** (recomendado): envía desde tu Gmail. Configuración en la sección 5.
- **EmailJS** (respaldo, sirve en Expo Go): sección 6.

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

### 4. Modo demo (practicar sin la placa)

La app trae un ESP32 simulado. El video, la cámara y la foto son simulados; el motor de
vigilancia, las alertas, los horarios y el **correo (Gmail API o EmailJS) son los reales**.

1. `npx expo start` y abre la app en Expo Go (no hace falta estar en el hotspot del ESP32,
   pero el teléfono sí necesita internet para el correo).
2. Horarios → ESP32 → activa **Modo demo**.
3. En Horarios → Alertas Email llena Service ID, Template ID y Public Key.
4. En Streaming, arma el sistema (**En Casa** o **Fuera de Casa**) y toca **Simular intrusión**.
   Debe aparecer la alerta con la foto en la pestaña Alertas y llegar el correo con `intruso.jpg`.
5. Prueba también:
   - **Simular intrusión con el sistema desarmado** → no pasa nada (igual que el firmware real).
   - **Desconectar cámara** → a los ~3 s pasa a "sin conexión"; si estás armado, a los 45 s llega la
     alerta "Cámara sin conexión" (también por correo).
   - **Reconectar cámara** → la app la detecta sola y el video vuelve.
   - Desarmar a mano en medio de una franja horaria → queda desarmado hasta que termine la franja.

### 5. Correo con Gmail API (recomendado)

La app inicia sesión con tu cuenta de Google y envía el correo **desde tu Gmail** con
`users.messages.send`, con la foto adjunta. Solo pide el permiso `gmail.send` (enviar, no leer).
Necesita un **development build**; en Expo Go usa EmailJS (sección 6).

**En Google Cloud (una vez, ~10 min):**
1. [console.cloud.google.com](https://console.cloud.google.com) → crear proyecto **SentryNode**.
2. *APIs y servicios → Biblioteca* → busca **Gmail API** → **Habilitar**.
3. *APIs y servicios → Pantalla de consentimiento de OAuth* (Google Auth Platform):
   tipo **Externo**, nombre "SentryNode", tu correo como soporte y contacto.
   En *Acceso a datos* agrega el scope `.../auth/gmail.send`.
   En *Público* → **Usuarios de prueba** → agrega `alejocastiblan2007@gmail.com`.
4. *Credenciales* (Clientes) → **Crear ID de cliente de OAuth** → tipo **Android**:
   - Nombre del paquete: `com.unisabana.sentrynode`
   - Huella SHA-1 del certificado con el que se firma la app:
     - con `npx expo run:android`:
       `keytool -list -v -keystore android/app/debug.keystore -alias androiddebugkey -storepass android -keypass android`
       (o `cd android; .\gradlew signingReport`)
     - con EAS: `npx eas-cli@latest credentials` → Android → muestra el SHA-1.

**En la app:** Horarios → Alertas Email → **Gmail API** → **Iniciar sesión con Google** → elige tu
cuenta → acepta "Enviar correo en tu nombre" → **Enviar email de prueba**. Llega a tu bandeja y
queda en *Enviados*.

Errores comunes (el *Registro de envíos* los explica):
- `DEVELOPER_ERROR` al iniciar sesión → el paquete o la SHA-1 del cliente Android no coinciden con la compilación.
- `403 ... Gmail API has not been used` → falta habilitar la Gmail API (paso 2).
- `403 access_denied` → tu cuenta no está como usuario de prueba (paso 3).
- En modo *Prueba*, Google pide volver a iniciar sesión cada 7 días.

### 5b. Gmail sin iniciar sesión (cuenta fija) — lo que usamos

Autorizas tu cuenta **una vez** desde el PC y la app envía siempre desde ella, sin pantallas de
Google en el teléfono. Si existe `.env.local`, tiene prioridad sobre el inicio de sesión.

1. **Google Cloud → Credenciales → Crear ID de cliente de OAuth → Aplicación web.**
   En *URI de redireccionamiento autorizados* agrega `https://developers.google.com/oauthplayground`.
   Copia el **ID de cliente** y el **Secreto del cliente**.
2. Abre [OAuth 2.0 Playground](https://developers.google.com/oauthplayground):
   - ⚙️ (arriba a la derecha) → marca **Use your own OAuth credentials** → pega ID y secreto.
   - *Step 1*: en el cuadro "Input your own scopes" escribe
     `https://www.googleapis.com/auth/gmail.send` → **Authorize APIs** → elige tu cuenta →
     "Google no verificó esta app" → **Continuar** → acepta.
   - *Step 2*: **Exchange authorization code for tokens** → copia el **Refresh token** (`1//…`).
3. En `D:\proyectos\mobile_app`, copia `.env.example` como `.env.local` y llena los 4 valores.
4. Reinicia Metro con `npx expo start --dev-client -c` (las variables se leen al empaquetar;
   no hace falta un build nuevo, funciona también en Expo Go).
5. En la app: Horarios → Alertas Email → **Gmail API** debe mostrar "Cuenta fija · sin inicio de
   sesión" → **Enviar email de prueba**.

> **Ojo:** con la app en estado *Prueba* en Google Cloud, el refresh token **vence a los 7 días**
> (el Registro de envíos dirá `invalid_grant`). Para que no venza: *Google Auth Platform → Público →
> Publicar app*. O vuelve a generarlo el día antes de la sustentación.

### 6. EmailJS (respaldo, funciona en Expo Go)

1. **Email Services** → Add New Service → Gmail → conecta tu cuenta. Copia el **Service ID**.
2. **Email Templates** → Create New Template:
   - *Subject*: `🚨 SentryNode: {{alert_type}}`
   - *To Email*: `{{to_email}}` · *From Name*: `{{from_name}}`
   - *Content*: pega el HTML de [`docs/emailjs-template.html`](docs/emailjs-template.html).
   - Pestaña **Attachments** → Add Attachment → **Variable Attachment** → Parameter Name `snapshot`,
     Filename `intruso.jpg`, Content Type `image/jpeg`.
   - Guarda y copia el **Template ID**.
   - En la app elige **EmailJS (respaldo)** en Horarios → Alertas Email.
3. **Account → General**: copia la **Public Key**.
4. **Account → Security**: activa **Allow EmailJS API for non-browser applications**
   (si no, la app recibe error 403).
5. En la app, Horarios → Alertas Email → llena los campos → **Enviar email de prueba**.

Errores comunes: `403` = falta el paso 4 · `400 ... template` = Template ID mal copiado ·
llega sin foto = el parámetro del adjunto no se llama exactamente `snapshot`.


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
(TLS sobre TCP) a la Gmail API de Google. No usamos UDP: el video MJPEG necesita entrega confiable y en
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
| Gmail/EmailJS 4xx (mala config) | Se marca el error en la alerta y no se insiste; se puede reintentar a mano |
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
(~10-15 KB) para que el correo sea liviano (y quepa en el límite de EmailJS si se usa el respaldo). La app la descarga de `/motion.jpg` y la manda
como adjunto (data URL base64). La hora sale del reloj del ESP32, sincronizado por **NTP**
(UTC-5). Si no hay NTP, la app la reconstruye con `uptime_ms − motion_uptime_ms`.

**¿Cómo envía el correo la app?** (Gmail API)
1. El usuario inicia sesión con Google una vez. Es OAuth 2.0: Google muestra su propia pantalla,
   el usuario acepta el permiso `gmail.send` y la app recibe un **access token** (vence en ~1 h).
2. Para cada alerta la app arma un mensaje **MIME** `multipart/mixed`: una parte `text/html` con el
   texto y otra `image/jpeg` con la foto en base64 (`intruso.jpg`).
3. Hace `POST` a `gmail.googleapis.com/upload/gmail/v1/users/me/messages/send` con
   `Authorization: Bearer <token>` y `Content-Type: message/rfc822`.
   Con la **cuenta fija**, el access token no viene de una pantalla de login sino de cambiar el
   *refresh token* guardado: `POST oauth2.googleapis.com/token` con `grant_type=refresh_token`.
   Se guarda en memoria hasta 1 minuto antes de que venza y se reutiliza entre correos.
4. Si Gmail responde **401**, el token venció: se descarta, se pide uno nuevo en silencio y se
   reintenta una vez. **429/5xx** → cola con backoff. **403** → error de configuración (no se insiste).

*Contrapregunta: ¿por qué no SMTP?* Un cliente SMTP necesita sockets TCP crudos (módulo nativo) y la
contraseña o una "contraseña de aplicación" guardada en el teléfono. Con la API, la app nunca toca la
contraseña y el permiso se limita a enviar.

## 6. Seguridad (limitaciones reconocidas)

El Wi-Fi va cifrado con WPA2, pero dentro de la red el HTTP va sin cifrar y la API no tiene
autenticación: cualquiera conectado al hotspot podría desarmar la cámara. El correo usa OAuth 2.0:
la app nunca ve tu contraseña de Google, solo un token de corta duración con el permiso mínimo
(`gmail.send`, enviar pero no leer), que Google renueva y que puedes revocar desde tu cuenta.
Para producción: un token en cada petición al ESP32 (o HTTPS), y la app publicada (fuera del modo
"Prueba" de OAuth, que obliga a reautenticar cada 7 días).
