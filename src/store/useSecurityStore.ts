/**
 * useSecurityStore — estado de la UI.
 *
 * La configuración (horarios, correo, ESP32, selección manual) se edita aquí y
 * se persiste en AsyncStorage. El estado "vivo" (conexión, telemetría,
 * alertas) lo produce el motor de monitoreo (services/monitor.ts) y la UI se
 * suscribe a él con useSyncExternalStore. Así la UI solo muestra; la lógica de
 * vigilancia vive fuera de React y puede correr en el Foreground Service.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { monitor } from '@/services/monitor';
import { scheduleModeAt } from '@/services/schedule';
import {
  DEFAULT_EMAIL_CONFIG, DEFAULT_ESP32_CONFIG, DEFAULT_SCHEDULES, KEYS, saveJson,
} from '@/services/storage';
import type {
  AlertEvent, EmailConfig, Esp32Config, ManualOverride, MonitorSnapshot, ModeSource,
  Schedule, SecurityMode,
} from '@/services/types';

export type {
  AlertEvent, EmailConfig, Esp32Config, Schedule, SecurityMode, MonitorSnapshot, ModeSource,
} from '@/services/types';

export interface SecurityStore {
  // Estado
  loaded: boolean;
  mode: SecurityMode;              // Modo efectivo (manual u horario)
  modeSource: ModeSource;
  activeScheduleLabel: string | null;
  isSystemArmed: boolean;
  schedules: Schedule[];
  alerts: AlertEvent[];
  unreadAlerts: number;
  emailConfig: EmailConfig;
  esp32Config: Esp32Config;
  live: MonitorSnapshot;

  // Acciones
  setMode: (mode: SecurityMode) => Promise<void>;
  addSchedule: (s: Omit<Schedule, 'id'>) => Promise<void>;
  updateSchedule: (id: string, updates: Partial<Schedule>) => Promise<void>;
  deleteSchedule: (id: string) => Promise<void>;
  clearAlerts: () => Promise<void>;
  retryEmail: (id: string) => Promise<void>;
  triggerTestAlert: () => Promise<void>;
  markAlertsRead: () => void;
  updateEmailConfig: (cfg: Partial<EmailConfig>) => Promise<void>;
  updateEsp32Config: (cfg: Partial<Esp32Config>) => Promise<void>;
}

const subscribe = (fn: () => void) => monitor.subscribe(fn);

export function useSecurityStore(): SecurityStore {
  const live = useSyncExternalStore(subscribe, () => monitor.getSnapshot());
  const alerts = useSyncExternalStore(subscribe, () => monitor.getAlerts());

  const [loaded, setLoaded] = useState(false);
  const [schedules, setSchedules] = useState<Schedule[]>(DEFAULT_SCHEDULES);
  const [emailConfig, setEmailConfig] = useState<EmailConfig>(DEFAULT_EMAIL_CONFIG);
  const [esp32Config, setEsp32Config] = useState<Esp32Config>(DEFAULT_ESP32_CONFIG);
  const [readCount, setReadCount] = useState(0);

  // Cargar la configuración persistida (el motor la carga una sola vez)
  useEffect(() => {
    monitor.ensureLoaded().then(() => {
      const cfg = monitor.getConfig()!;
      setSchedules(cfg.schedules);
      setEmailConfig(cfg.emailConfig);
      setEsp32Config(cfg.esp32Config);
      setReadCount(monitor.getAlerts().length);
      setLoaded(true);
    });
  }, []);

  // ── Modo ──────────────────────────────────────────────────────────────────
  const setMode = useCallback(async (mode: SecurityMode) => {
    const cfg = monitor.getConfig();
    if (!cfg) return;
    const override: ManualOverride = {
      mode,
      scheduleModeAtSet: scheduleModeAt(cfg.schedules, new Date()).mode,
      setAt: new Date().toISOString(),
    };
    monitor.updateConfig({ override });          // El motor lo envía al ESP32 en el próximo ciclo
    await saveJson(KEYS.OVERRIDE, override);
  }, []);

  // ── Horarios ──────────────────────────────────────────────────────────────
  const commitSchedules = useCallback(async (next: Schedule[]) => {
    setSchedules(next);
    monitor.updateConfig({ schedules: next });
    await saveJson(KEYS.SCHEDULES, next);
  }, []);

  const addSchedule = useCallback(async (s: Omit<Schedule, 'id'>) => {
    await commitSchedules([...schedules, { ...s, id: `schedule-${Date.now()}` }]);
  }, [schedules, commitSchedules]);

  const updateSchedule = useCallback(async (id: string, updates: Partial<Schedule>) => {
    await commitSchedules(schedules.map(s => (s.id === id ? { ...s, ...updates } : s)));
  }, [schedules, commitSchedules]);

  const deleteSchedule = useCallback(async (id: string) => {
    await commitSchedules(schedules.filter(s => s.id !== id));
  }, [schedules, commitSchedules]);

  // ── Configuración ─────────────────────────────────────────────────────────
  const updateEmailConfig = useCallback(async (patch: Partial<EmailConfig>) => {
    const next = { ...emailConfig, ...patch };
    setEmailConfig(next);
    monitor.updateConfig({ emailConfig: next });
    await saveJson(KEYS.EMAIL_CFG, next);
  }, [emailConfig]);

  const updateEsp32Config = useCallback(async (patch: Partial<Esp32Config>) => {
    const next = { ...esp32Config, ...patch };
    setEsp32Config(next);
    monitor.updateConfig({ esp32Config: next });
    await saveJson(KEYS.ESP32_CFG, next);
  }, [esp32Config]);

  // ── Alertas ───────────────────────────────────────────────────────────────
  const clearAlerts = useCallback(async () => {
    await monitor.clearAlerts();
    setReadCount(0);
  }, []);
  const retryEmail = useCallback((id: string) => monitor.retryEmail(id), []);
  const triggerTestAlert = useCallback(async () => { await monitor.triggerTestAlert(); }, []);
  const markAlertsRead = useCallback(() => setReadCount(monitor.getAlerts().length), []);

  return {
    loaded,
    mode: live.effectiveMode,
    modeSource: live.modeSource,
    activeScheduleLabel: live.activeScheduleLabel,
    isSystemArmed: live.effectiveMode !== 'disarmed',
    schedules,
    alerts,
    unreadAlerts: Math.max(0, alerts.length - readCount),
    emailConfig,
    esp32Config,
    live,
    setMode,
    addSchedule,
    updateSchedule,
    deleteSchedule,
    clearAlerts,
    retryEmail,
    triggerTestAlert,
    markAlertsRead,
    updateEmailConfig,
    updateEsp32Config,
  };
}
