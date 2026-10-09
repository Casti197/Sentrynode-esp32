/**
 * Motor de monitoreo (sin React).
 *
 * Es UNA sola cadena de sondeo que corre:
 *   - dentro del Foreground Service de Android (development build), o
 *   - dentro de la app mientras está abierta (Expo Go).
 *
 * Cada ciclo:
 *   1. GET /status con timeout de 2.5 s.
 *   2. Calcula el modo efectivo (manual u horario) y, si el ESP32 tiene otro,
 *      se lo envía (/mode es idempotente). Así se resincroniza tras un reinicio.
 *   3. Compara `motion_seq` con el último visto. Si subió → evento nuevo:
 *      descarga la foto, notifica, guarda la alerta y la encola para correo.
 *   4. Procesa la cola de correos pendientes (con reintentos y backoff).
 *
 * ¿Por qué un contador (motion_seq) y no un booleano "motion_detected"?
 * Un booleano dura poco: si el sondeo cae justo en el hueco, se pierde el
 * evento; y si dura varios sondeos, se cuenta dos veces. El contador no se
 * pierde ni se duplica: "hubo N eventos desde la última vez que pregunté".
 *
 * El sondeo usa setTimeout encadenado (no setInterval): el siguiente ciclo se
 * programa cuando termina el anterior, así nunca se acumulan peticiones si el
 * ESP32 responde lento.
 */
import {
  Esp32Error, fetchEvidence, fetchSnapshot, getStatus, setDeviceMode,
} from './esp32Api';
import { isEmailConfigured, sendAlertEmail } from './emailService';
import { deviceLog } from './deviceLog';
import { emailLog } from './emailLog';
import { sendAlertNotification, sendIntrusionAlert } from './notificationService';
import { computeEffectiveMode } from './schedule';
import {
  KEYS, MAX_ALERTS, MAX_ALERTS_WITH_IMAGE, loadAlerts, loadConfig, loadEvidence,
  loadLastSeq, removeEvidence, saveEvidence, saveJson, type PersistedConfig,
} from './storage';
import type { AlertEvent, AlertType, DeviceStatus, MonitorSnapshot, SecurityMode } from './types';

const POLL_ONLINE_MS = 1500;
const POLL_MAX_BACKOFF_MS = 10000;
const OFFLINE_AFTER_FAILURES = 2;
const CONNECTION_LOST_ALERT_MS = 45000;   // Armado y sin cámara por 45 s → alerta
const EMAIL_MAX_ATTEMPTS = 6;
const EMAIL_RETRY_BASE_MS = 20000;

const MODE_LABEL: Record<SecurityMode, string> = {
  disarmed: 'Desarmado',
  home: 'En Casa',
  away: 'Fuera de Casa',
};

const RUNNER_LABEL: Record<MonitorSnapshot['runner'], string> = {
  'foreground-service': 'servicio en segundo plano',
  'in-app': 'app abierta',
  stopped: 'detenido',
};

function signalLabel(rssi: number): string {
  if (rssi >= -60) return 'excelente';
  if (rssi >= -70) return 'buena';
  if (rssi >= -80) return 'regular';
  return 'débil';
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

type Listener = () => void;

class MonitorEngine {
  // ── Estado ──────────────────────────────────────────────────────────────
  private config: PersistedConfig | null = null;
  private alerts: AlertEvent[] = [];
  private lastSeq: number | null = null;
  private lastUptime: number | null = null;
  private offlineSince: number | null = null;
  /** Desde cuándo falla el sondeo (primer fallo), para medir cuánto duró el corte. */
  private failingSince: number | null = null;
  private connectedAt: number | null = null;
  private connectionLostAlerted = false;
  private emailBusy = false;
  private loaded: Promise<void> | null = null;

  private loopId = 0;                       // Identifica la cadena de sondeo vigente
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wake: (() => void) | null = null;
  private abort: AbortController | null = null;

  private snapshot: MonitorSnapshot = {
    connection: 'idle',
    status: null,
    latencyMs: null,
    lastError: null,
    consecutiveFailures: 0,
    effectiveMode: 'disarmed',
    modeSource: 'default',
    activeScheduleLabel: null,
    runner: 'stopped',
  };

  private listeners = new Set<Listener>();
  /** Lo registra foregroundService para actualizar la notificación persistente. */
  onSummaryChange: ((summary: string) => void) | null = null;
  private lastSummary = '';

  // ── API pública ─────────────────────────────────────────────────────────

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getSnapshot(): MonitorSnapshot { return this.snapshot; }
  getAlerts(): AlertEvent[] { return this.alerts; }
  getConfig(): PersistedConfig | null { return this.config; }

  /** Carga config, alertas y último seq desde el almacenamiento (una vez). */
  ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      this.loaded = (async () => {
        const [config, alerts, lastSeq] = await Promise.all([loadConfig(), loadAlerts(), loadLastSeq()]);
        this.config = config;
        this.alerts = alerts;
        this.lastSeq = lastSeq;
        this.refreshMode();
        this.emit();
      })();
    }
    return this.loaded;
  }

  /** La UI llama esto cuando el usuario cambia la configuración. */
  updateConfig(patch: Partial<PersistedConfig>): void {
    if (!this.config) return;
    const ipChanged = patch.esp32Config && (
      patch.esp32Config.ip !== this.config.esp32Config.ip ||
      patch.esp32Config.demo !== this.config.esp32Config.demo);
    this.config = { ...this.config, ...patch };
    if (ipChanged) {
      const c = patch.esp32Config!;
      deviceLog('info', 'Cambio de dispositivo',
        c.demo ? 'ahora: ESP32 simulado (modo demo)' : `ahora: ${c.ip} (control :${c.controlPort}, video :${c.streamPort})`);
      // Otro dispositivo: su contador no tiene relación con el anterior
      this.connectedAt = null;
      this.failingSince = null;
      this.lastSeq = null;
      this.lastUptime = null;
      this.snapshot = { ...this.snapshot, status: null, connection: 'connecting' };
    }
    this.refreshMode();
    this.emit();
    this.pokeNow();
  }

  /** Corre la cadena de sondeo hasta que shouldContinue() sea false. */
  async run(runner: MonitorSnapshot['runner'], shouldContinue: () => boolean): Promise<void> {
    await this.ensureLoaded();
    const myId = ++this.loopId;                // Una cadena nueva invalida a la anterior
    this.connectedAt = null;
    this.failingSince = null;
    this.setSnapshot({ runner, connection: 'connecting' });
    this.runningLogged = true;
    deviceLog('info', `Monitoreo iniciado (${RUNNER_LABEL[runner]})`,
      `buscando ${this.targetLabel()} cada ${POLL_ONLINE_MS / 1000} s`);

    while (shouldContinue() && myId === this.loopId) {
      const delay = await this.tick();
      if (!shouldContinue() || myId !== this.loopId) break;
      await new Promise<void>(resolve => {
        this.wake = resolve;
        this.timer = setTimeout(resolve, delay);
      });
      this.wake = null;
    }
    if (myId === this.loopId) {
      this.setSnapshot({ runner: 'stopped', connection: 'idle' });
      this.logStopped();
    }
  }

  private runningLogged = false;
  private logStopped(): void {
    if (!this.runningLogged) return;
    this.runningLogged = false;
    deviceLog('info', 'Monitoreo detenido', this.connectedAt
      ? `estuvo conectado ${formatDuration(Date.now() - this.connectedAt)}` : undefined);
    this.connectedAt = null;
  }

  /** Detiene la cadena actual y cancela la petición en curso. */
  stop(): void {
    this.logStopped();
    this.loopId++;
    this.abort?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
  }

  /** Adelanta el próximo ciclo (ej. al cambiar el modo o volver a primer plano). */
  pokeNow(): void {
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
  }

  async clearAlerts(): Promise<void> {
    await removeEvidence(this.alerts.filter(a => a.hasImage).map(a => a.id));
    this.alerts = [];
    await saveJson(KEYS.ALERTS, this.alerts);
    this.emit();
  }

  /** Reenvío manual: reinicia los intentos y procesa ya. */
  async retryEmail(id: string): Promise<void> {
    this.alerts = this.alerts.map(a =>
      a.id === id ? { ...a, emailAttempts: 0, nextEmailAttemptAt: 0, lastEmailError: undefined } : a);
    await saveJson(KEYS.ALERTS, this.alerts);
    this.emit();
    await this.processEmailQueue();
  }

  /** Alerta de prueba con la foto actual de la cámara. */
  async triggerTestAlert(): Promise<AlertEvent> {
    await this.ensureLoaded();
    let image: string | null = null;
    try {
      image = await fetchSnapshot(this.config!.esp32Config);
    } catch { /* sin cámara: igual se prueba notificación y correo */ }
    const alert = await this.addAlert('manual_trigger',
      `Alerta de prueba generada desde la app (modo ${MODE_LABEL[this.snapshot.effectiveMode]})`,
      new Date(), image);
    await sendAlertNotification({ title: '🧪 Alerta de prueba', body: alert.description });
    this.processEmailQueue();
    return alert;
  }

  // ── Ciclo de sondeo ─────────────────────────────────────────────────────

  /** Un ciclo. Devuelve cuántos ms esperar antes del siguiente. */
  private async tick(): Promise<number> {
    const cfg = this.config!;
    const effective = this.refreshMode();

    this.abort = new AbortController();
    const t0 = Date.now();
    let status: DeviceStatus;
    try {
      status = await getStatus(cfg.esp32Config, this.abort.signal);
    } catch (e) {
      return this.onPollFailure(e);
    } finally {
      this.abort = null;
    }

    // ── Conectado ──
    const latencyMs = Date.now() - t0;
    const justConnected = this.snapshot.connection !== 'online';
    if (justConnected) this.logConnected(status, latencyMs);
    this.failingSince = null;
    this.offlineSince = null;
    this.connectionLostAlerted = false;

    // ¿Se reinició el ESP32? Su uptime bajó → su contador volvió a 0.
    if (this.lastUptime !== null && status.uptime_ms < this.lastUptime) {
      deviceLog('warn', 'El ESP32 se reinició',
        `encendido hace ${formatDuration(status.uptime_ms)}; contador de movimiento reiniciado`);
      this.lastSeq = 0;
    }
    this.lastUptime = status.uptime_ms;

    // Primer contacto: tomar el contador actual como referencia (no alertar eventos viejos)
    if (this.lastSeq === null) {
      this.lastSeq = status.motion_seq;
      await saveJson(KEYS.LAST_SEQ, this.lastSeq);
    }

    // Sincronizar el modo del ESP32 con el modo efectivo de la app
    if (status.mode !== effective) {
      try {
        await setDeviceMode(cfg.esp32Config, effective);
        deviceLog('success', `Modo sincronizado: ${MODE_LABEL[effective]}`,
          `el ESP32 estaba en ${MODE_LABEL[status.mode]}`);
        status = { ...status, mode: effective, armed: effective !== 'disarmed' };
      } catch (e) {
        deviceLog('warn', `No se pudo enviar el modo ${MODE_LABEL[effective]}`,
          `${e instanceof Esp32Error ? e.message : String(e)} · se reintenta en el próximo ciclo`);
      }
    }

    this.setSnapshot({
      connection: 'online', status, latencyMs, lastError: null, consecutiveFailures: 0,
    });

    // ¿Eventos nuevos?
    if (status.motion_seq > this.lastSeq) {
      const newEvents = status.motion_seq - this.lastSeq;
      this.lastSeq = status.motion_seq;
      await saveJson(KEYS.LAST_SEQ, this.lastSeq);
      if (effective !== 'disarmed') await this.onIntrusion(status, newEvents);
    }

    this.processEmailQueue();       // No se espera: no frena el sondeo
    return POLL_ONLINE_MS;
  }

  private async onPollFailure(e: unknown): Promise<number> {
    const failures = this.snapshot.consecutiveFailures + 1;
    const message = e instanceof Esp32Error ? e.message : String(e);
    const offline = failures >= OFFLINE_AFTER_FAILURES;
    this.failingSince ??= Date.now();
    const prev = this.snapshot.connection;
    if (offline && prev !== 'offline') {
      deviceLog('error', prev === 'online' ? 'Se perdió la conexión con el ESP32' : 'No se encuentra el ESP32',
        `${this.targetLabel()} · ${message}`);
    }
    this.setSnapshot({
      consecutiveFailures: failures,
      lastError: message,
      connection: offline ? 'offline' : this.snapshot.connection,
    });

    if (offline) {
      this.offlineSince ??= Date.now();
      const armed = this.snapshot.effectiveMode !== 'disarmed';
      // Si alguien desconecta la cámara estando armado, eso también es una alerta
      if (armed && !this.connectionLostAlerted && Date.now() - this.offlineSince > CONNECTION_LOST_ALERT_MS) {
        this.connectionLostAlerted = true;
        const alert = await this.addAlert('connection_lost',
          'La cámara dejó de responder con el sistema armado (¿la desconectaron o se cayó el hotspot?)',
          new Date(this.offlineSince), null);
        await sendAlertNotification({ title: '📵 Cámara sin conexión', body: alert.description });
      }
    }
    this.processEmailQueue();
    // Backoff exponencial: 1.5 s, 3 s, 6 s, 10 s, 10 s…
    return Math.min(POLL_ONLINE_MS * 2 ** Math.max(0, failures - 1), POLL_MAX_BACKOFF_MS);
  }

  private targetLabel(): string {
    const c = this.config?.esp32Config;
    if (!c) return 'ESP32';
    return c.demo ? 'ESP32 simulado' : `${c.ip}:${c.controlPort}`;
  }

  /** Registro de la transición a "en línea" (primera conexión o reconexión). */
  private logConnected(status: DeviceStatus, latencyMs: number): void {
    const wasConnected = this.connectedAt !== null;
    const outage = this.failingSince ? Date.now() - this.failingSince : null;
    this.connectedAt = Date.now();

    const net = status.net === 'ap' ? 'red propia del ESP32 (AP)' : 'WiFi/hotspot (STA)';
    const detail = [
      `${status.device || 'ESP32'} fw ${status.fw} en ${status.ip}`,
      net,
      `señal ${status.rssi} dBm (${signalLabel(status.rssi)})`,
      `modo ${MODE_LABEL[status.mode]}`,
      `${latencyMs} ms`,
      status.time_synced ? 'hora NTP ok' : 'sin hora NTP',
    ].join(' · ');

    if (wasConnected || outage !== null) {
      deviceLog('success', `Reconectado al ESP32${outage !== null ? ` tras ${formatDuration(outage)} sin respuesta` : ''}`, detail);
    } else {
      deviceLog('success', 'Conectado al ESP32', detail);
    }
    if (status.rssi < -80) {
      deviceLog('warn', 'Señal WiFi débil', 'acerca la cámara al hotspot: pueden fallar el video y las alertas');
    }
    if (status.net === 'ap') {
      deviceLog('warn', 'El ESP32 está en modo AP (no encontró el hotspot)',
        'en esta red el teléfono no tiene internet: los correos esperarán en cola');
    }
  }

  private async onIntrusion(status: DeviceStatus, newEvents: number): Promise<void> {
    // Hora exacta del evento: reloj NTP del ESP32; si no hay, se reconstruye con su uptime
    const when = status.motion_epoch > 0
      ? new Date(status.motion_epoch * 1000)
      : new Date(Date.now() - Math.max(0, status.uptime_ms - status.motion_uptime_ms));

    let image: string | null = null;
    try {
      image = await fetchEvidence(this.config!.esp32Config);
    } catch (e) {
      deviceLog('warn', 'No se pudo descargar la foto de evidencia',
        e instanceof Esp32Error ? e.message : String(e));
    }

    const zones = status.total_blocks ? ` (${status.changed_blocks}/${status.total_blocks} zonas)` : '';
    const extra = newEvents > 1 ? ` · ${newEvents} eventos` : '';
    const alert = await this.addAlert('motion',
      `Movimiento detectado${zones}${extra} — modo ${MODE_LABEL[status.mode]}`, when, image);

    await sendIntrusionAlert({ timestamp: alert.timestamp, description: alert.description, mode: status.mode });
  }

  // ── Alertas y correo ────────────────────────────────────────────────────

  private async addAlert(type: AlertType, description: string, when: Date, image: string | null): Promise<AlertEvent> {
    const alert: AlertEvent = {
      id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: when.toISOString(),
      type,
      description,
      hasImage: !!image,
      emailSent: false,
      emailAttempts: 0,
    };
    if (image) await saveEvidence(alert.id, image);

    const all = [alert, ...this.alerts];
    // Guardar fotos solo de las más recientes para no llenar el almacenamiento
    const dropImages = all.slice(MAX_ALERTS_WITH_IMAGE).filter(a => a.hasImage);
    const dropped = all.slice(MAX_ALERTS);
    await removeEvidence([...dropImages, ...dropped].map(a => a.id));
    const dropIds = new Set(dropImages.map(a => a.id));
    this.alerts = all.slice(0, MAX_ALERTS).map(a => dropIds.has(a.id) ? { ...a, hasImage: false } : a);

    await saveJson(KEYS.ALERTS, this.alerts);
    this.emit();
    emailLog('info', `Alerta nueva en cola de correo: ${alert.type}`, image ? 'con foto de evidencia' : 'sin foto');
    return alert;
  }

  private async patchAlert(id: string, patch: Partial<AlertEvent>): Promise<void> {
    this.alerts = this.alerts.map(a => a.id === id ? { ...a, ...patch } : a);
    await saveJson(KEYS.ALERTS, this.alerts);
    this.emit();
  }

  /** Envía los correos pendientes, uno a la vez, con backoff entre reintentos. */
  private warnedNotConfigured = false;

  private async processEmailQueue(): Promise<void> {
    if (this.emailBusy || !this.config) return;
    if (!isEmailConfigured(this.config.emailConfig)) {
      const waiting = this.alerts.some(a => !a.emailSent && a.emailAttempts < EMAIL_MAX_ATTEMPTS);
      if (waiting && !this.warnedNotConfigured) {
        this.warnedNotConfigured = true;
        emailLog('warn', 'Hay alertas esperando correo, pero el envío no está configurado',
          'Configura .env.local (cuenta fija) o inicia sesión con Google en Horarios → Alertas Email');
      }
      return;
    }
    this.warnedNotConfigured = false;
    this.emailBusy = true;
    try {
      const now = Date.now();
      const pending = this.alerts.filter(a =>
        !a.emailSent && a.emailAttempts < EMAIL_MAX_ATTEMPTS && (a.nextEmailAttemptAt ?? 0) <= now);
      for (const alert of pending.reverse()) {   // Más antigua primero
        const image = alert.hasImage ? await loadEvidence(alert.id) : null;
        const result = await sendAlertEmail(this.config.emailConfig, {
          timestamp: alert.timestamp,
          type: alert.type,
          description: alert.description,
          mode: this.snapshot.effectiveMode,
          esp32Ip: this.config.esp32Config.ip,
          snapshotDataUrl: image,
        });
        if (result.ok) {
          await this.patchAlert(alert.id, { emailSent: true, lastEmailError: undefined });
        } else {
          const attempts = result.retryable ? alert.emailAttempts + 1 : EMAIL_MAX_ATTEMPTS;
          if (result.retryable && attempts < EMAIL_MAX_ATTEMPTS) {
            emailLog('warn', `Reintento ${attempts}/${EMAIL_MAX_ATTEMPTS - 1} programado`,
              `en ${Math.round(EMAIL_RETRY_BASE_MS * 2 ** (attempts - 1) / 1000)} s`);
          } else {
            emailLog('error', 'No se reintentará automáticamente',
              result.retryable ? 'Se agotaron los intentos' : 'Error de configuración: corrígela y usa "Reenviar email" en Alertas');
          }
          await this.patchAlert(alert.id, {
            emailAttempts: attempts,
            nextEmailAttemptAt: Date.now() + EMAIL_RETRY_BASE_MS * 2 ** (attempts - 1),
            lastEmailError: result.error,
          });
          if (result.retryable) break;   // Sin internet: no tiene sentido seguir con la cola
        }
      }
    } finally {
      this.emailBusy = false;
    }
  }

  // ── Modo efectivo ───────────────────────────────────────────────────────

  private refreshMode(): SecurityMode {
    if (!this.config) return 'disarmed';
    const eff = computeEffectiveMode(this.config.schedules, this.config.override);
    if (eff.overrideExpired) {
      // El horario cambió de estado: la selección manual deja de aplicar
      this.config = { ...this.config, override: null };
      saveJson(KEYS.OVERRIDE, null);
    }
    if (eff.mode !== this.snapshot.effectiveMode || eff.source !== this.snapshot.modeSource ||
        eff.activeScheduleLabel !== this.snapshot.activeScheduleLabel) {
      this.setSnapshot({
        effectiveMode: eff.mode, modeSource: eff.source, activeScheduleLabel: eff.activeScheduleLabel,
      });
    }
    return eff.mode;
  }

  // ── Notificación a suscriptores ─────────────────────────────────────────

  private setSnapshot(patch: Partial<MonitorSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit();
  }

  private emit(): void {
    this.listeners.forEach(fn => fn());
    const s = this.snapshot;
    const conn = s.connection === 'online' ? 'Cámara en línea'
      : s.connection === 'offline' ? 'Cámara sin conexión' : 'Conectando…';
    const summary = `${MODE_LABEL[s.effectiveMode]} · ${conn}`;
    if (summary !== this.lastSummary) {
      this.lastSummary = summary;
      this.onSummaryChange?.(summary);
    }
  }
}

/** Instancia única: la comparten la UI y el Foreground Service (mismo hilo JS). */
export const monitor = new MonitorEngine();
