/**
 * Tipos compartidos entre el store (UI) y el motor de monitoreo.
 * Viven aquí (y no en el store) para que el motor no dependa de React.
 */

export type SecurityMode = 'disarmed' | 'home' | 'away';

export interface Schedule {
  id: string;
  label: string;
  startTime: string; // "HH:MM"
  endTime: string;   // "HH:MM" (si es menor que startTime, cruza la medianoche)
  days: number[];    // 0=Dom … 6=Sáb (día en que EMPIEZA la franja)
  enabled: boolean;
  mode: SecurityMode;
}

/**
 * Selección manual del usuario. Manda sobre los horarios hasta que el
 * horario cambie de estado (empieza o termina una franja).
 */
export interface ManualOverride {
  mode: SecurityMode;
  scheduleModeAtSet: SecurityMode; // Lo que decía el horario cuando se eligió
  setAt: string;                   // ISO
}

export type AlertType = 'motion' | 'manual_trigger' | 'connection_lost';

export interface AlertEvent {
  id: string;
  timestamp: string;        // ISO — hora del evento (reloj NTP del ESP32 si está disponible)
  type: AlertType;
  description: string;
  hasImage: boolean;        // La foto se guarda aparte: @sentry/evidence/<id>
  emailSent: boolean;
  emailAttempts: number;
  nextEmailAttemptAt?: number; // ms epoch — backoff de reintentos
  lastEmailError?: string;
}

export interface EmailConfig {
  serviceId: string;       // EmailJS service ID
  templateId: string;      // EmailJS template ID
  publicKey: string;       // EmailJS public key
  privateKey: string;      // EmailJS private key (opcional, "accessToken")
  recipientEmail: string;
  senderName: string;
}

export interface Esp32Config {
  ip: string;              // IP que el hotspot le dio al ESP32 (la imprime el monitor serie)
  controlPort: number;     // 80 — API JSON
  streamPort: number;      // 81 — MJPEG
}

/** Respuesta de GET /status del firmware. */
export interface DeviceStatus {
  device: string;
  fw: number;
  mode: SecurityMode;
  armed: boolean;
  motion_seq: number;
  motion_detected: boolean;
  motion_uptime_ms: number;
  motion_epoch: number;
  changed_blocks: number;
  total_blocks: number;
  fps: number;
  rssi: number;
  ip: string;
  net: 'sta' | 'ap';
  uptime_ms: number;
  epoch: number;
  time_synced: boolean;
  streaming: boolean;
  stream_clients: number;
  flash: boolean;
  siren: boolean;
  free_heap: number;
  free_psram: number;
}

export type ConnectionState = 'idle' | 'connecting' | 'online' | 'offline';

export type ModeSource = 'manual' | 'schedule' | 'default';

export interface MonitorSnapshot {
  connection: ConnectionState;
  status: DeviceStatus | null;
  latencyMs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  effectiveMode: SecurityMode;
  modeSource: ModeSource;
  activeScheduleLabel: string | null;
  runner: 'foreground-service' | 'in-app' | 'stopped';
}
