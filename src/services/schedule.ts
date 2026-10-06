/**
 * Lógica de franjas horarias. Funciones puras (sin React, sin red), así se
 * pueden usar igual desde la UI y desde el Foreground Service.
 */
import type { ManualOverride, ModeSource, Schedule, SecurityMode } from './types';

const MODE_PRIORITY: Record<SecurityMode, number> = { disarmed: 0, home: 1, away: 2 };

export function isValidTime(hhmm: string): boolean {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  return !!m && Number(m[1]) < 24 && Number(m[2]) < 60;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** ¿La franja está activa en `now`? Maneja franjas que cruzan la medianoche. */
export function isScheduleActive(s: Schedule, now: Date): boolean {
  if (!s.enabled || !isValidTime(s.startTime) || !isValidTime(s.endTime)) return false;
  const start = toMinutes(s.startTime);
  const end = toMinutes(s.endTime);
  const minutes = now.getHours() * 60 + now.getMinutes();
  const today = now.getDay();
  const yesterday = (today + 6) % 7;

  if (start === end) return false;
  if (start < end) {
    return s.days.includes(today) && minutes >= start && minutes < end;
  }
  // Cruza la medianoche (ej. 22:00 → 07:00): el "día" es el día en que empieza.
  return (s.days.includes(today) && minutes >= start) ||
         (s.days.includes(yesterday) && minutes < end);
}

/** Modo que dicta el horario ahora. Si hay varias franjas activas, gana la más estricta. */
export function scheduleModeAt(schedules: Schedule[], now: Date): { mode: SecurityMode; label: string | null } {
  let best: Schedule | null = null;
  for (const s of schedules) {
    if (isScheduleActive(s, now) && (!best || MODE_PRIORITY[s.mode] > MODE_PRIORITY[best.mode])) {
      best = s;
    }
  }
  return best ? { mode: best.mode, label: best.label } : { mode: 'disarmed', label: null };
}

export interface EffectiveMode {
  mode: SecurityMode;
  source: ModeSource;
  activeScheduleLabel: string | null;
  /** true si el horario cambió de estado y la selección manual ya no aplica. */
  overrideExpired: boolean;
}

/**
 * Regla: la selección manual manda hasta que el horario cambie de estado.
 * Ej.: si a las 9:00 (franja "away" activa) el usuario desarma, queda desarmado
 * hasta las 18:00, cuando termina la franja; desde ahí vuelve a mandar el horario.
 */
export function computeEffectiveMode(
  schedules: Schedule[],
  override: ManualOverride | null,
  now: Date = new Date(),
): EffectiveMode {
  const sched = scheduleModeAt(schedules, now);
  if (override) {
    if (override.scheduleModeAtSet === sched.mode) {
      return { mode: override.mode, source: 'manual', activeScheduleLabel: sched.label, overrideExpired: false };
    }
    return { mode: sched.mode, source: sched.label ? 'schedule' : 'default', activeScheduleLabel: sched.label, overrideExpired: true };
  }
  return { mode: sched.mode, source: sched.label ? 'schedule' : 'default', activeScheduleLabel: sched.label, overrideExpired: false };
}
