/**
 * Persistencia (AsyncStorage). Tanto la UI como el motor de monitoreo leen y
 * escriben aquí, porque el motor puede correr dentro del Foreground Service
 * sin que la UI esté montada.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {
  AlertEvent, EmailConfig, Esp32Config, ManualOverride, Schedule,
} from './types';

export const KEYS = {
  SCHEDULES: '@sentry/schedules',
  OVERRIDE: '@sentry/override',
  ALERTS: '@sentry/alerts.v2',
  EMAIL_CFG: '@sentry/emailConfig',
  ESP32_CFG: '@sentry/esp32Config.v2',
  LAST_SEQ: '@sentry/lastMotionSeq',
  EVIDENCE: (id: string) => `@sentry/evidence/${id}`,
};

export const MAX_ALERTS = 50;
export const MAX_ALERTS_WITH_IMAGE = 15; // Las fotos ocupan ~15 KB c/u en base64

export const DEFAULT_EMAIL_CONFIG: EmailConfig = {
  serviceId: '',
  templateId: '',
  publicKey: '',
  privateKey: '',
  recipientEmail: 'alejocastiblan2007@gmail.com',
  senderName: 'SentryNode',
};

export const DEFAULT_ESP32_CONFIG: Esp32Config = {
  ip: '192.168.4.1',   // AP de rescate; con el hotspot cámbiala por la IP que muestra el ESP32
  controlPort: 80,
  streamPort: 81,
};

export const DEFAULT_SCHEDULES: Schedule[] = [
  {
    id: 'default-1',
    label: 'Horario Laboral',
    startTime: '08:00',
    endTime: '18:00',
    days: [1, 2, 3, 4, 5],
    enabled: true,
    mode: 'away',
  },
  {
    id: 'default-2',
    label: 'Noche',
    startTime: '22:00',
    endTime: '07:00',
    days: [0, 1, 2, 3, 4, 5, 6],
    enabled: false,
    mode: 'home',
  },
];

export interface PersistedConfig {
  schedules: Schedule[];
  override: ManualOverride | null;
  emailConfig: EmailConfig;
  esp32Config: Esp32Config;
}

function parse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function loadConfig(): Promise<PersistedConfig> {
  const [s, o, e, d] = await AsyncStorage.multiGet([
    KEYS.SCHEDULES, KEYS.OVERRIDE, KEYS.EMAIL_CFG, KEYS.ESP32_CFG,
  ]);
  return {
    schedules: parse(s[1], DEFAULT_SCHEDULES),
    override: parse<ManualOverride | null>(o[1], null),
    emailConfig: { ...DEFAULT_EMAIL_CONFIG, ...parse(e[1], {}) },
    esp32Config: { ...DEFAULT_ESP32_CONFIG, ...parse(d[1], {}) },
  };
}

export async function saveJson(key: string, value: unknown): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(value));
}

export async function loadAlerts(): Promise<AlertEvent[]> {
  return parse(await AsyncStorage.getItem(KEYS.ALERTS), [] as AlertEvent[]);
}

export async function loadLastSeq(): Promise<number | null> {
  return parse<number | null>(await AsyncStorage.getItem(KEYS.LAST_SEQ), null);
}

export async function saveEvidence(id: string, dataUrl: string): Promise<void> {
  await AsyncStorage.setItem(KEYS.EVIDENCE(id), dataUrl);
}

export async function loadEvidence(id: string): Promise<string | null> {
  return AsyncStorage.getItem(KEYS.EVIDENCE(id));
}

export async function removeEvidence(ids: string[]): Promise<void> {
  if (ids.length) await AsyncStorage.multiRemove(ids.map(KEYS.EVIDENCE));
}
