/**
 * Registro de la conexión app ↔ ESP32 ([ESP32] en la consola de Metro; panel
 * en Horarios → ESP32): conexión, desconexión, reconexión, reinicios de la
 * placa, sincronización de modo y estado del video.
 */
import { createEventLog } from './eventLog';

export const deviceEvents = createEventLog('ESP32', '@sentry/deviceLog');
export const deviceLog = deviceEvents.log;
