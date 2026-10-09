/**
 * Registro de envíos de correo ([EMAIL] en la consola de Metro; panel en
 * Horarios → Alertas Email). Nunca se guardan claves ni tokens, solo cuentas
 * y resultados.
 */
import { createEventLog, type LogEntry, type LogLevel } from './eventLog';

export type EmailLogLevel = LogLevel;
export type EmailLogEntry = LogEntry;

export const emailEvents = createEventLog('EMAIL', '@sentry/emailLog');
export const emailLog = emailEvents.log;
export const getEmailLogs = emailEvents.get;
export const subscribeEmailLogs = emailEvents.subscribe;
export const clearEmailLogs = emailEvents.clear;
