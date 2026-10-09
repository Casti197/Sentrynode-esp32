/**
 * Registro de envíos de correo.
 *
 * Cada intento queda en dos lugares:
 *  - la terminal de `npx expo start` (console.log con el prefijo [EMAIL]);
 *  - una lista persistente (últimos 100) que se ve en Horarios → Alertas Email.
 *
 * Nunca se guardan las claves de EmailJS, solo IDs abreviados.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export type EmailLogLevel = 'info' | 'success' | 'error' | 'warn';

export interface EmailLogEntry {
  id: string;
  at: string;               // ISO
  level: EmailLogLevel;
  message: string;
  detail?: string;
}

const KEY = '@sentry/emailLog';
const MAX = 100;

let entries: EmailLogEntry[] = [];
let loaded = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach(fn => fn());
}

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    // Las entradas que llegaron antes de cargar quedan arriba
    if (raw) entries = [...entries, ...(JSON.parse(raw) as EmailLogEntry[])].slice(0, MAX);
    emit();
  } catch { /* registro best-effort */ }
}
ensureLoaded();

export function emailLog(level: EmailLogLevel, message: string, detail?: string): void {
  const entry: EmailLogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    at: new Date().toISOString(),
    level,
    message,
    detail,
  };
  const line = `[EMAIL] ${message}${detail ? ` — ${detail}` : ''}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  entries = [entry, ...entries].slice(0, MAX);
  emit();
  AsyncStorage.setItem(KEY, JSON.stringify(entries)).catch(() => {});
}

export function getEmailLogs(): EmailLogEntry[] {
  return entries;
}

export function subscribeEmailLogs(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function clearEmailLogs(): Promise<void> {
  entries = [];
  emit();
  await AsyncStorage.removeItem(KEY);
}

/** "service_abc123xyz" → "service_a…xyz": suficiente para verificar sin exponer la clave. */
export function maskId(id: string): string {
  if (!id) return '(vacío)';
  return id.length <= 10 ? id : `${id.slice(0, 9)}…${id.slice(-3)}`;
}
