/**
 * Registro de eventos reutilizable (correo, conexión con el ESP32, …).
 *
 * Cada evento queda en dos lugares:
 *  - la terminal de `npx expo start` (console.log con un prefijo, ej. [ESP32]);
 *  - una lista persistente (últimos 100) que se muestra en la app.
 *
 * Los niveles 'error' se imprimen con console.warn: son fallos esperados que
 * la app ya maneja; console.error abriría la pantalla roja de React Native.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export type LogLevel = 'info' | 'success' | 'error' | 'warn';

export interface LogEntry {
  id: string;
  at: string;               // ISO
  level: LogLevel;
  message: string;
  detail?: string;
}

export interface EventLog {
  log: (level: LogLevel, message: string, detail?: string) => void;
  get: () => LogEntry[];
  subscribe: (fn: () => void) => () => void;
  clear: () => Promise<void>;
}

const MAX = 100;

export function createEventLog(prefix: string, storageKey: string): EventLog {
  let entries: LogEntry[] = [];
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach(fn => fn());

  // Cargar lo guardado; lo que llegue antes de terminar queda arriba
  AsyncStorage.getItem(storageKey)
    .then(raw => {
      if (raw) entries = [...entries, ...(JSON.parse(raw) as LogEntry[])].slice(0, MAX);
      emit();
    })
    .catch(() => { /* registro best-effort */ });

  return {
    log(level, message, detail) {
      const entry: LogEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        at: new Date().toISOString(),
        level,
        message,
        detail,
      };
      const line = `[${prefix}] ${message}${detail ? ` — ${detail}` : ''}`;
      if (level === 'error') console.warn(`✖ ${line}`);
      else if (level === 'warn') console.warn(line);
      else console.log(line);

      entries = [entry, ...entries].slice(0, MAX);
      emit();
      AsyncStorage.setItem(storageKey, JSON.stringify(entries)).catch(() => {});
    },
    get: () => entries,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async clear() {
      entries = [];
      emit();
      await AsyncStorage.removeItem(storageKey);
    },
  };
}
