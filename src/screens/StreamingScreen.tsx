/**
 * StreamingScreen
 *
 * Module 2 — Live Video Streaming
 *
 * Video en vivo del ESP32-CAM (MJPEG por HTTP, puerto 81) dentro de un WebView.
 *
 *   - ¿Por qué WebView? <Image> de React Native no soporta
 *     multipart/x-mixed-replace; el motor del navegador sí lo decodifica
 *     nativamente, frame por frame, sin pasar los JPEG por el hilo JS.
 *   - Reconexión: backoff exponencial si el <img> falla, y reconexión forzada
 *     cuando el motor de monitoreo ve que la cámara volvió o la app vuelve a
 *     primer plano (el socket del stream suele morir en segundo plano).
 *   - La detección de movimiento NO ocurre aquí: la hace el motor
 *     (services/monitor.ts), que sigue corriendo aunque esta pantalla no exista.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView,
  Alert, ActivityIndicator, AppState,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons, MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import type { SecurityStore } from '@/store/useSecurityStore';
import { setFlash, setSiren, streamUrl as buildStreamUrl } from '@/services/esp32Api';
import { monitor } from '@/services/monitor';
import { deviceLog } from '@/services/deviceLog';
import { getDemoState, setDemoOnline, simulateIntrusion, subscribeDemo } from '@/services/demoDevice';

// ─── Types ────────────────────────────────────────────────────────────────────

type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'error';

interface Props {
  store: SecurityStore;
}

const MODE_LABELS: Record<'disarmed' | 'home' | 'away', string> = {
  disarmed: 'DESARMADO (SIN MONITOREO)',
  home: 'EN CASA (PERIMÉTRICO ACTIVO)',
  away: 'FUERA DE CASA (MÁXIMA)',
};

// ─── MJPEG HTML wrapper ───────────────────────────────────────────────────────
// WebView renders an HTML page that embeds the MJPEG stream as an <img> tag.
// This is necessary because React Native's <Image> doesn't support MJPEG streams.

function buildMjpegHtml(streamUrl: string): string {
  // Cache-bust the URL so Android WebView doesn't serve a stale cached response
  const url = `${streamUrl}?t=${Date.now()}`;
  return `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #0a0e17; }
    #container { position: relative; width: 100%; height: 100%;
                 display: flex; align-items: center; justify-content: center; }
    img#stream { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
    #overlay { display: none; position: absolute; inset: 0;
               align-items: center; justify-content: center;
               background: rgba(10,14,23,0.90); flex-direction: column; gap: 12px; }
    #overlay.visible { display: flex; }
    #msg { color: #4cd7f6; font-family: monospace; font-size: 13px; text-align: center;
           padding: 8px 16px; border-radius: 8px; }
    #retry { color: #0a0e17; background: #4cd7f6; border: none; border-radius: 8px;
             padding: 8px 20px; font-size: 13px; font-family: monospace; cursor: pointer; }
  </style>
</head>
<body>
  <div id="container">
    <img id="stream" />
    <div id="overlay" class="visible">
      <div id="msg">Conectando con la cámara...</div>
      <button id="retry">Reintentar</button>
    </div>
  </div>
  <script>
    var img = document.getElementById('stream');
    var overlay = document.getElementById('overlay');
    var msg = document.getElementById('msg');
    var retryBtn = document.getElementById('retry');
    var streamUrl = '${url}';
    var alive = false;
    var checkTimer = null;

    function notify(data) {
      if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(data);
    }

    function startStream() {
      alive = false;
      if (checkTimer) clearInterval(checkTimer);
      // Set src to kick off the MJPEG request
      img.src = streamUrl + '&r=' + Date.now();

      // Poll naturalWidth — MJPEG won't fire onload reliably
      checkTimer = setInterval(function() {
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
          if (!alive) {
            alive = true;
            overlay.classList.remove('visible');
            notify('STREAM_LIVE');
          }
        }
      }, 200);
    }

    img.onerror = function() {
      alive = false;
      overlay.classList.add('visible');
      msg.innerText = 'No se pudo conectar. Verifica que el ESP32 esté encendido.';
      notify('STREAM_ERROR');
    };

    retryBtn.addEventListener('click', function() {
      msg.innerText = 'Reconectando...';
      startStream();
    });

    // Watchdog: if no frame arrives in 8 seconds, signal error
    setTimeout(function() {
      if (!alive) {
        overlay.classList.add('visible');
        msg.innerText = 'Tiempo de espera agotado. ¿Estás conectado al WiFi del ESP32?';
        notify('STREAM_ERROR');
      }
    }, 8000);

    startStream();
  </script>
</body>
</html>`;
}

// ─── Video simulado (modo demo) ───────────────────────────────────────────────
// Un <canvas> dibuja una habitación con ruido de sensor y hora, a ~15 fps.
// window.intrude() hace cruzar una silueta; window.setOnline(false) muestra "SIN SEÑAL".

function buildDemoHtml(): string {
  return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<style>html,body{margin:0;height:100%;background:#0a0e17;overflow:hidden}
canvas{width:100%;height:100%;object-fit:contain;display:block}</style></head>
<body><canvas id="c" width="320" height="240"></canvas><script>
var c=document.getElementById('c'),x=c.getContext('2d'),online=true,walkStart=0;
function room(){
  var g=x.createLinearGradient(0,0,0,165);g.addColorStop(0,'#262a33');g.addColorStop(1,'#3a3f49');
  x.fillStyle=g;x.fillRect(0,0,320,165);x.fillStyle='#2f2b26';x.fillRect(0,165,320,75);
  x.fillStyle='#46505f';x.fillRect(30,40,80,60);x.strokeStyle='#5a5f69';x.lineWidth=3;x.strokeRect(30,40,80,60);
  x.fillStyle='#3e342c';x.fillRect(205,55,60,110);x.fillStyle='#968c6e';x.fillRect(253,108,6,6);
  x.fillStyle='#3c424e';x.fillRect(20,120,110,20);x.fillStyle='#373c46';x.fillRect(20,135,110,35);
}
function person(px){
  x.fillStyle='#121216';x.beginPath();x.arc(px+11,82,12,0,6.3);x.fill();
  x.beginPath();x.moveTo(px-8,98);x.lineTo(px+30,98);x.lineTo(px+36,160);x.lineTo(px+26,200);
  x.lineTo(px+16,200);x.lineTo(px+11,165);x.lineTo(px+6,200);x.lineTo(px-4,200);x.lineTo(px-12,160);x.closePath();x.fill();
  x.strokeStyle='#ff5a50';x.lineWidth=2;x.strokeRect(px-18,64,60,142);
  x.fillStyle='#ff5a50';x.fillRect(px-18,52,84,12);x.fillStyle='#fff';x.font='9px monospace';x.fillText('MOVIMIENTO',px-15,61);
}
function noise(n){var d=x.getImageData(0,0,320,240),p=d.data;for(var i=0;i<p.length;i+=4){var r=(Math.random()-0.5)*n;p[i]+=r;p[i+1]+=r;p[i+2]+=r;}x.putImageData(d,0,0);}
function hud(){x.fillStyle='rgba(0,0,0,.7)';x.fillRect(0,0,320,13);x.fillStyle='#4cd7f6';x.font='9px monospace';
  x.fillText('SENTRYNODE CAM-01  DEMO  '+new Date().toLocaleTimeString(),4,10);
  if(Date.now()%1000<500){x.fillStyle='#ff3c3c';x.beginPath();x.arc(312,6,3.5,0,6.3);x.fill();}}
function frame(){
  if(!online){noise(0);x.fillStyle='#111';x.fillRect(0,0,320,240);noise(160);
    x.fillStyle='#ffb4ab';x.font='bold 16px monospace';x.fillText('SIN SEÑAL',112,124);return;}
  room();
  var t=Date.now()-walkStart;
  if(walkStart&&t<4500){person(-40+t/4500*380);}
  noise(18);hud();
}
window.intrude=function(){walkStart=Date.now();};
window.setOnline=function(v){online=v;};
setInterval(frame,66);frame();
if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage('STREAM_LIVE');
</script></body></html>`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function StreamingScreen({ store }: Props) {
  const { mode, setMode, esp32Config, isSystemArmed, live, modeSource, activeScheduleLabel } = store;

  const [connState, setConnState] = useState<ConnectionState>('connecting');
  const [reconnectCount, setReconnectCount] = useState(0);
  const [busy, setBusy] = useState<'flash' | 'siren' | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);

  const demo = esp32Config.demo;
  const streamUrl = demo ? 'demo://camara' : buildStreamUrl(esp32Config);
  const webViewRef = useRef<WebView>(null);
  const [demoOnline, setDemoOnlineState] = useState(getDemoState().online);
  const status = live.status;
  const flashOn = status?.flash ?? false;
  const sirenOn = status?.siren ?? false;
  const fps = status ? status.fps.toFixed(1) : '--';
  const latency = live.latencyMs != null ? String(live.latencyMs) : '--';
  const signal = status && status.net === 'sta' ? String(status.rssi) : '--';

  // ── Reconexión del stream ───────────────────────────────────────────────────
  const reconnectNow = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    setConnState('connecting');
    setReconnectCount(c => c + 1);           // Nueva key → WebView nuevo → socket nuevo
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current) return;   // Ya hay una reconexión programada
    const attempt = attemptRef.current++;
    const delay = Math.min(1000 * 2 ** attempt, 15000);   // 1 s, 2 s, 4 s… máx 15 s
    setConnState('reconnecting');
    reconnectTimerRef.current = setTimeout(reconnectNow, delay);
  }, [reconnectNow]);

  // La cámara volvió a responder /status → reconectar el video de inmediato
  const prevConnection = useRef(live.connection);
  useEffect(() => {
    if (prevConnection.current === 'offline' && live.connection === 'online') {
      attemptRef.current = 0;
      reconnectNow();
    }
    prevConnection.current = live.connection;
  }, [live.connection, reconnectNow]);

  // Al volver a primer plano, el socket viejo del stream suele estar muerto
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') reconnectNow();
    });
    return () => sub.remove();
  }, [reconnectNow]);

  useEffect(() => () => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
  }, []);

  // ── Modo demo: reflejar en el video simulado si la "placa" está conectada ─────
  useEffect(() => {
    if (!demo) return;
    return subscribeDemo(() => {
      const st = getDemoState();
      setDemoOnlineState(st.online);
      webViewRef.current?.injectJavaScript(`window.setOnline(${st.online});true;`);
    });
  }, [demo]);

  const handleSimulateIntrusion = useCallback(() => {
    webViewRef.current?.injectJavaScript('window.intrude();true;');
    const counted = simulateIntrusion();
    if (!counted) {
      Alert.alert(
        'Evento ignorado',
        demoOnline
          ? 'El sistema está DESARMADO: el ESP32 ve el movimiento pero no lo cuenta como intrusión. Arma el sistema (En Casa o Fuera de Casa) y vuelve a intentar.'
          : 'La cámara está desconectada. Reconéctala primero.',
      );
    } else {
      monitor.pokeNow();               // Que el motor lo vea ya, sin esperar el próximo ciclo
    }
  }, [demoOnline]);

  // ── Controles ───────────────────────────────────────────────────────────────
  // La UI no es optimista: muestra lo que el ESP32 confirma en /status.
  const toggle = useCallback(async (what: 'flash' | 'siren') => {
    setBusy(what);
    try {
      if (what === 'flash') await setFlash(esp32Config, !flashOn);
      else await setSiren(esp32Config, !sirenOn);
      monitor.pokeNow();                     // Refrescar /status ya
    } catch {
      Alert.alert('Sin conexión', 'No se pudo hablar con el ESP32. ¿Está en el mismo hotspot?');
    } finally {
      setBusy(null);
    }
  }, [esp32Config, flashOn, sirenOn]);

  const handleSetMode = useCallback((newMode: typeof mode) => { setMode(newMode); }, [setMode]);

  // ── Mensajes del WebView ────────────────────────────────────────────────────
  // Registro del video: solo transiciones (no cada reintento) para no llenar el log
  const streamLiveRef = useRef(false);
  const streamFailingSince = useRef<number | null>(null);

  const onStreamFailure = useCallback((reason: string) => {
    if (streamLiveRef.current || streamFailingSince.current === null) {
      deviceLog(streamLiveRef.current ? 'warn' : 'error',
        streamLiveRef.current ? 'Video interrumpido' : 'No se pudo abrir el video',
        `${streamUrl} · ${reason} · reintentando con espera creciente (1 s → 15 s)`);
    }
    streamLiveRef.current = false;
    streamFailingSince.current ??= Date.now();
    scheduleReconnect();
  }, [scheduleReconnect, streamUrl]);

  const handleWebViewMessage = useCallback((event: { nativeEvent: { data: string } }) => {
    const msg = event.nativeEvent.data;
    if (msg === 'STREAM_LIVE') {
      if (!streamLiveRef.current) {
        const since = streamFailingSince.current;
        deviceLog('success', since ? `Video recuperado tras ${Math.round((Date.now() - since) / 1000)} s` : 'Video en vivo',
          demo ? 'cámara simulada' : `MJPEG ${streamUrl}`);
      }
      streamLiveRef.current = true;
      streamFailingSince.current = null;
      attemptRef.current = 0;
      setConnState('live');
    } else if (msg === 'STREAM_ERROR') {
      onStreamFailure('el stream dejó de enviar cuadros');
    }
  }, [onStreamFailure, demo, streamUrl]);

  const handleWebViewError = useCallback(
    (e: { nativeEvent: { description?: string } }) => onStreamFailure(e.nativeEvent.description || 'error del WebView'),
    [onStreamFailure]);

  const runnerLabel = live.runner === 'foreground-service' ? 'SVC: FOREGROUND ACTIVE'
    : live.runner === 'in-app' ? 'VIGILANDO (APP ABIERTA)' : 'MONITOR DETENIDO';
  const modeSourceLabel = modeSource === 'manual' ? 'Selección manual'
    : modeSource === 'schedule' ? `Horario: ${activeScheduleLabel}` : 'Sin horario activo';

  // ─── Render ────────────────────────────────────────────────────────────────

  const connColor = connState === 'live' ? '#4edea3' : connState === 'connecting' ? '#4cd7f6' : '#ffb4ab';
  const connLabel = connState === 'live' ? 'LIVE' : connState === 'connecting' ? 'CONECTANDO...' : connState === 'reconnecting' ? 'RECONECTANDO...' : 'ERROR';

  return (
    <SafeAreaView className="flex-1 bg-surface">
      <StatusBar style="light" />

      {/* Header */}
      <View className="z-50 bg-surface-container-lowest shadow-lg">
        <View className="px-margin py-space-xs flex-row items-center justify-between bg-surface-container-low">
          <View className="flex-row items-center gap-space-xs">
            <View className="w-2 h-2 rounded-full bg-secondary" />
            <Text className="font-label-caps text-label-caps uppercase tracking-wider text-secondary">
              {runnerLabel}
            </Text>
          </View>
          <View className="flex-row items-center gap-space-xs">
            <MaterialIcons name="wifi-tethering" size={14} color="#4cd7f6" />
            <Text className="font-telemetry-sm text-telemetry-sm text-on-surface-variant">
              {esp32Config.ip}
            </Text>
            <Text style={{ color: connColor }} className="font-bold font-telemetry-sm">
              • {connLabel}
            </Text>
          </View>
        </View>

        <View className="h-16 px-margin flex-row items-center justify-between">
          <View className="flex-col">
            <Text className="font-headline-sm text-headline-sm text-on-surface tracking-tight leading-tight">
              SentryNode ESP32
            </Text>
            <Text className="font-telemetry-sm text-telemetry-sm text-primary uppercase">
              Streaming en Vivo
            </Text>
          </View>
          <View className="flex-row items-center gap-space-sm">
            {isSystemArmed && (
              <View className="bg-secondary/20 px-space-sm py-1 rounded-full flex-row items-center gap-space-xs">
                <MaterialIcons name="security" size={12} color="#4edea3" />
                <Text className="font-label-caps text-label-caps text-secondary uppercase">ARMADO</Text>
              </View>
            )}
          </View>
        </View>
      </View>

      <ScrollView
        className="flex-1 bg-surface"
        contentContainerStyle={{ paddingBottom: 100, paddingTop: 16, paddingHorizontal: 16 }}
        showsVerticalScrollIndicator={false}
      >
        <View className="gap-space-md">

          {/* Foreground service pill */}
          <View className="w-full bg-surface-container-low rounded-xl px-space-md py-space-xs flex-row items-center justify-between shadow-sm">
            <View className="flex-row items-center gap-space-xs flex-1">
              <View className="w-2 h-2 rounded-full bg-secondary" />
              <Text className="font-telemetry-sm text-telemetry-sm text-on-surface flex-1" numberOfLines={1}>
                {live.connection === 'online'
                  ? `Cámara en línea · ${status?.changed_blocks ?? 0}/${status?.total_blocks ?? 0} zonas con cambio`
                  : live.connection === 'offline' ? `Cámara sin respuesta: ${live.lastError ?? ''}` : 'Conectando con la cámara…'}
              </Text>
            </View>
            <View className="flex-row items-center gap-space-xs bg-surface-container-highest px-space-xs py-1 rounded">
              <MaterialIcons name="security" size={12} color={isSystemArmed ? '#4edea3' : '#869397'} />
              <Text className={`font-label-caps text-label-caps uppercase ${isSystemArmed ? 'text-secondary' : 'text-outline'}`}>
                {isSystemArmed ? 'ARMADO' : 'DESARMADO'}
              </Text>
            </View>
          </View>

          {/* ── Video Viewport ──────────────────────────────────────────────── */}
          <View className="w-full aspect-video bg-surface-container-lowest rounded-xl overflow-hidden shadow-xl">
            {/* MJPEG vía WebView. key nueva (IP o reconexión) → WebView y socket nuevos */}
            <WebView
              key={`${streamUrl}#${reconnectCount}`}
              ref={webViewRef}
              injectedJavaScript={demo ? `window.setOnline && window.setOnline(${demoOnline});true;` : undefined}
              source={{ html: demo ? buildDemoHtml() : buildMjpegHtml(streamUrl) }}
              style={{ flex: 1, backgroundColor: '#0a0e17' }}
              onMessage={handleWebViewMessage}
              onError={handleWebViewError}
              onHttpError={handleWebViewError}
              scrollEnabled={false}
              bounces={false}
              javaScriptEnabled
              mixedContentMode="always"   // Allow http:// in WebView
              allowsInlineMediaPlayback
              mediaPlaybackRequiresUserAction={false}
            />

            {/* Connection overlay */}
            {connState !== 'live' && (
              <View
                className="absolute inset-0 bg-surface-container-lowest/90 items-center justify-center"
                pointerEvents="none"
              >
                <ActivityIndicator size="large" color="#4cd7f6" />
                <Text className="font-telemetry-sm text-telemetry-sm text-primary mt-space-sm uppercase tracking-wider">
                  {connLabel}
                </Text>
                {reconnectCount > 0 && (
                  <Text className="font-label-caps text-label-caps text-on-surface-variant mt-1">
                    Intento #{reconnectCount}
                  </Text>
                )}
              </View>
            )}

            {/* Top-left overlay: REC + FPS */}
            <View className="absolute top-2 left-2 flex-row items-center gap-space-xs bg-surface-container-lowest/80 px-space-xs py-1 rounded" pointerEvents="none">
              <View className="w-2 h-2 rounded-full bg-error" />
              <Text className="font-label-caps text-label-caps text-error tracking-wider uppercase">REC ●</Text>
              <Text className="font-telemetry-sm text-telemetry-sm text-on-surface">{fps} FPS</Text>
            </View>

            {/* Top-right overlay: signal */}
            <View className="absolute top-2 right-2 flex-row items-center gap-space-xs bg-surface-container-lowest/80 px-space-xs py-1 rounded" pointerEvents="none">
              <MaterialIcons name="wifi" size={13} color="#4edea3" />
              <Text className="font-telemetry-sm text-telemetry-sm text-secondary">{signal} dBm</Text>
            </View>

            {/* Bottom-right: MJPEG badge */}
            <View className="absolute bottom-2 right-2 bg-surface-container-lowest/85 px-space-xs py-1 rounded" pointerEvents="none">
              <Text className="font-label-caps text-label-caps text-primary uppercase">{demo ? 'DEMO' : 'MJPEG'}</Text>
            </View>

            {/* Bottom-left: camera model */}
            <View className="absolute bottom-2 left-2" pointerEvents="none">
              <Text className="font-label-caps text-label-caps text-outline uppercase tracking-wider">
                ESP32-CAM · {status?.ip ?? esp32Config.ip}
              </Text>
            </View>
          </View>

          {/* ── Telemetry Stats ─────────────────────────────────────────────── */}
          <View className="flex-row gap-space-xs w-full justify-between">
            <View className="flex-1 bg-surface-container-low rounded-xl p-space-sm shadow-sm">
              <View className="flex-row items-center justify-between">
                <Text className="font-label-caps text-label-caps text-on-surface-variant uppercase">FPS</Text>
                <MaterialIcons name="speed" size={14} color="#4cd7f6" />
              </View>
              <View className="mt-space-xs flex-row items-baseline gap-1">
                <Text className="font-telemetry-lg text-telemetry-lg text-primary">{fps}</Text>
                <Text className="font-telemetry-sm text-telemetry-sm text-on-surface-variant">fps</Text>
              </View>
            </View>

            <View className="flex-1 bg-surface-container-low rounded-xl p-space-sm shadow-sm mx-1">
              <View className="flex-row items-center justify-between">
                <Text className="font-label-caps text-label-caps text-on-surface-variant uppercase">Latencia</Text>
                <MaterialIcons name="timer" size={14} color="#4edea3" />
              </View>
              <View className="mt-space-xs flex-row items-baseline gap-1">
                <Text className="font-telemetry-lg text-telemetry-lg text-secondary">{latency}</Text>
                <Text className="font-telemetry-sm text-telemetry-sm text-on-surface-variant">ms</Text>
              </View>
            </View>

            <View className="flex-1 bg-surface-container-low rounded-xl p-space-sm shadow-sm">
              <View className="flex-row items-center justify-between">
                <Text className="font-label-caps text-label-caps text-on-surface-variant uppercase">Señal</Text>
                <MaterialIcons name="layers" size={14} color="#4cd7f6" />
              </View>
              <View className="mt-space-xs flex-row items-baseline gap-1">
                <Text className="font-telemetry-lg text-telemetry-lg text-on-surface">{signal}</Text>
                <Text className="font-telemetry-sm text-telemetry-sm text-secondary uppercase font-semibold">dBm</Text>
              </View>
            </View>
          </View>

          {/* ── Modo demo ────────────────────────────────────────────────────── */}
          {demo && (
            <View className="bg-surface-container-low rounded-xl p-space-md shadow-sm border border-primary/40">
              <View className="flex-row items-center gap-space-xs mb-space-xs">
                <MaterialCommunityIcons name="flask-outline" size={16} color="#4cd7f6" />
                <Text className="font-label-caps text-label-caps text-primary uppercase tracking-wider">
                  Modo demo · ESP32 simulado
                </Text>
              </View>
              <Text className="font-body-sm text-body-sm text-on-surface-variant mb-space-sm">
                El video y la cámara son simulados; el motor de vigilancia, las alertas y el correo por Gmail son los reales.
              </Text>
              <View className="flex-row gap-space-xs">
                <TouchableOpacity
                  onPress={handleSimulateIntrusion}
                  className="flex-1 bg-error/20 rounded-xl py-space-sm flex-row items-center justify-center gap-space-xs mr-1"
                >
                  <MaterialCommunityIcons name="walk" size={18} color="#ffb4ab" />
                  <Text className="font-label-caps text-label-caps text-error uppercase font-bold">Simular intrusión</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => setDemoOnline(!demoOnline)}
                  className="flex-1 bg-surface-container-highest rounded-xl py-space-sm flex-row items-center justify-center gap-space-xs ml-1"
                >
                  <MaterialIcons name={demoOnline ? 'power-off' : 'power'} size={18} color="#bcc9cd" />
                  <Text className="font-label-caps text-label-caps text-on-surface uppercase font-bold">
                    {demoOnline ? 'Desconectar cámara' : 'Reconectar cámara'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* ── Camera Controls ──────────────────────────────────────────────── */}
          <View className="flex-col mt-2 gap-space-xs">
            <Text className="font-label-caps text-label-caps text-outline uppercase tracking-wider px-space-xs mb-1">
              Controles Inmediatos
            </Text>
            <View className="flex-row gap-space-xs">
              <TouchableOpacity
                activeOpacity={0.8}
                onPress={() => toggle('flash')}
                disabled={busy !== null}
                className="flex-1 bg-surface-container-low p-space-sm rounded-xl flex-row items-center gap-space-sm shadow-sm mr-1"
              >
                <View className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${flashOn ? 'bg-primary/20' : 'bg-surface-container-highest'}`}>
                  <MaterialIcons name={flashOn ? 'flashlight-on' : 'flashlight-off'} size={20} color={flashOn ? '#4cd7f6' : '#bcc9cd'} />
                </View>
                <View className="flex-col flex-1">
                  <Text className="font-headline-sm text-headline-sm text-on-surface" numberOfLines={1}>Flash LED</Text>
                  <Text className={`font-label-caps text-label-caps uppercase ${flashOn ? 'text-primary font-bold' : 'text-on-surface-variant'}`}>
                    {flashOn ? 'Activo' : 'Apagado'}
                  </Text>
                </View>
              </TouchableOpacity>

              <TouchableOpacity
                activeOpacity={0.8}
                onPress={() => toggle('siren')}
                disabled={busy !== null}
                className={`flex-1 bg-surface-container-low p-space-sm rounded-xl flex-row items-center gap-space-sm shadow-sm ml-1 ${sirenOn ? 'border border-error/50' : ''}`}
              >
                <View className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${sirenOn ? 'bg-error/30' : 'bg-error/15'}`}>
                  <MaterialCommunityIcons name="alarm-light-outline" size={20} color="#ffb4ab" />
                </View>
                <View className="flex-col flex-1">
                  <Text className="font-headline-sm text-headline-sm text-error" numberOfLines={1}>Sirena Remota</Text>
                  <Text className={`font-label-caps text-label-caps uppercase ${sirenOn ? 'text-error font-bold' : 'text-on-surface-variant'}`}>
                    {sirenOn ? '🔴 ACTIVA' : 'Alarma Local'}
                  </Text>
                </View>
              </TouchableOpacity>
            </View>
          </View>

          {/* ── Mode Selector ────────────────────────────────────────────────── */}
          <View className="bg-surface-container-low rounded-xl p-space-md flex-col mt-2 shadow-md gap-space-md">
            <View className="flex-col">
              <Text className="font-label-caps text-label-caps text-on-surface-variant uppercase tracking-wider">
                Estado de Vigilancia
              </Text>
              <Text className={`font-headline-sm text-headline-sm font-bold mt-1 ${mode === 'away' ? 'text-secondary' : mode === 'home' ? 'text-primary' : 'text-outline'}`}>
                {MODE_LABELS[mode]}
              </Text>
              <Text className="font-telemetry-sm text-telemetry-sm text-on-surface-variant mt-1">
                {modeSourceLabel}
              </Text>
            </View>
            <View className="flex-row bg-surface-container-lowest p-1 rounded-xl">
              {(['disarmed', 'home', 'away'] as const).map((m) => {
                const isActive = mode === m;
                const labels = { disarmed: 'Desarmado', home: 'En Casa', away: 'Fuera Casa' };
                const icons = { disarmed: 'lock-open', home: 'shield-account', away: 'shield-check' };
                const activeBg = { disarmed: 'bg-surface-container-high', home: 'bg-primary', away: 'bg-secondary' };
                const activeTextColor = { disarmed: '#dfe2ef', home: '#003640', away: '#003824' };
                const inactiveTextColor = '#bcc9cd';
                return (
                  <TouchableOpacity
                    key={m}
                    onPress={() => handleSetMode(m)}
                    className={`flex-1 flex-col items-center justify-center py-2.5 rounded-lg ${isActive ? activeBg[m] : ''}`}
                  >
                    <MaterialCommunityIcons
                      name={icons[m] as any}
                      size={20}
                      color={isActive ? activeTextColor[m] : inactiveTextColor}
                    />
                    <Text
                      className={`font-label-caps text-label-caps text-center uppercase mt-1 ${isActive ? 'font-bold' : 'text-on-surface-variant'}`}
                      style={isActive ? { color: activeTextColor[m] } : undefined}
                    >
                      {labels[m]}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* ── ESP32 Connection Info ─────────────────────────────────────────── */}
          <View className="bg-surface-container-low rounded-xl p-space-md shadow-sm">
            <Text className="font-label-caps text-label-caps text-outline uppercase tracking-wider mb-space-sm">
              Conexión ESP32
            </Text>
            <View className="flex-row items-center justify-between">
              <Text className="font-telemetry-sm text-telemetry-sm text-on-surface-variant">IP Stream</Text>
              <Text className="font-telemetry-sm text-telemetry-sm text-primary">{streamUrl}</Text>
            </View>
            <View className="flex-row items-center justify-between mt-1">
              <Text className="font-telemetry-sm text-telemetry-sm text-on-surface-variant">Red</Text>
              <Text className="font-telemetry-sm text-telemetry-sm text-on-surface">
                {status ? (status.net === 'sta' ? 'Hotspot (STA)' : 'AP de rescate') : '--'}
                {status?.time_synced ? ' · hora NTP' : ''}
              </Text>
            </View>
            <View className="flex-row items-center justify-between mt-1">
              <Text className="font-telemetry-sm text-telemetry-sm text-on-surface-variant">Estado</Text>
              <View className="flex-row items-center gap-space-xs">
                <View className="w-2 h-2 rounded-full" style={{ backgroundColor: connColor }} />
                <Text className="font-telemetry-sm text-telemetry-sm" style={{ color: connColor }}>
                  {connLabel}
                </Text>
              </View>
            </View>
          </View>

        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
