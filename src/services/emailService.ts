/**
 * emailService — correo de alerta vía la API REST de EmailJS (HTTPS + JSON).
 *
 * Funciona porque el teléfono está en el hotspot (tiene datos móviles). Si el
 * teléfono estuviera conectado al AP del ESP32, no habría internet.
 *
 * CONFIGURACIÓN EN emailjs.com (una sola vez):
 *  1. Account → Security → activar "Allow EmailJS API for non-browser
 *     applications" (si no, la API responde 403 a apps móviles).
 *  2. En el template, pestaña Attachments → "Add Attachment" → tipo
 *     "Variable Attachment", parámetro `snapshot`, nombre `intruso.jpg`,
 *     content type `image/jpeg`.
 *  3. Variables del template: {{to_email}}, {{from_name}}, {{alert_timestamp}},
 *     {{alert_type}}, {{alert_description}}, {{security_mode}}, {{esp32_ip}}.
 *     En "To Email" del template pon {{to_email}}.
 *
 * La foto viaja como data URL base64 (~15 KB). El plan gratuito de EmailJS
 * limita el tamaño de la petición, por eso el firmware genera la evidencia a
 * 320×240 con más compresión en vez de mandar el frame VGA completo.
 */
import type { EmailConfig } from './types';
import { emailLog, maskId } from './emailLog';

const EMAILJS_API = 'https://api.emailjs.com/api/v1.0/email/send';
const EMAIL_TIMEOUT_MS = 15000;

export interface AlertEmailPayload {
  timestamp: string;    // ISO
  type: string;
  description: string;
  mode: string;
  esp32Ip: string;
  snapshotDataUrl?: string | null;
}

export type EmailResult =
  | { ok: true }
  | { ok: false; error: string; retryable: boolean };

export function isEmailConfigured(c: EmailConfig): boolean {
  return !!(c.serviceId && c.templateId && c.publicKey && c.recipientEmail);
}

export async function sendAlertEmail(config: EmailConfig, payload: AlertEmailPayload): Promise<EmailResult> {
  const label = translateAlertType(payload.type);
  if (!isEmailConfigured(config)) {
    const missing = [
      !config.serviceId && 'Service ID', !config.templateId && 'Template ID',
      !config.publicKey && 'Public Key', !config.recipientEmail && 'destinatario',
    ].filter(Boolean).join(', ');
    emailLog('warn', `No se envió "${label}": EmailJS incompleto`, `Falta: ${missing}`);
    return { ok: false, error: `EmailJS no está configurado (falta ${missing})`, retryable: false };
  }

  const humanTime = new Date(payload.timestamp).toLocaleString('es-CO', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  const templateParams: Record<string, string> = {
    to_email: config.recipientEmail,
    from_name: config.senderName || 'SentryNode',
    alert_timestamp: humanTime,
    alert_type: translateAlertType(payload.type),
    alert_description: payload.description,
    security_mode: translateMode(payload.mode),
    esp32_ip: payload.esp32Ip,
  };
  if (payload.snapshotDataUrl) templateParams.snapshot = payload.snapshotDataUrl;

  const body: Record<string, unknown> = {
    service_id: config.serviceId,
    template_id: config.templateId,
    user_id: config.publicKey,
    template_params: templateParams,
  };
  if (config.privateKey) body.accessToken = config.privateKey;

  const json = JSON.stringify(body);
  const photoKb = payload.snapshotDataUrl ? Math.round(payload.snapshotDataUrl.length / 1024) : 0;
  emailLog('info', `Enviando "${label}" a ${config.recipientEmail}`,
    `service ${maskId(config.serviceId)} · template ${maskId(config.templateId)} · ` +
    `${photoKb ? `foto ${photoKb} KB` : 'sin foto'} · petición ${Math.round(json.length / 1024)} KB`);

  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMAIL_TIMEOUT_MS);
  try {
    const res = await fetch(EMAILJS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: json,
      signal: controller.signal,
    });
    const ms = Date.now() - t0;
    if (res.ok) {
      emailLog('success', `Enviado "${label}" ✓ (HTTP ${res.status}, ${ms} ms)`,
        'EmailJS lo aceptó. Si no llega, revisa spam y el campo "To Email" del template.');
      return { ok: true };
    }
    const text = (await res.text()).slice(0, 200);
    // 4xx = configuración mala (no sirve reintentar). 429/5xx = transitorio.
    const retryable = res.status === 429 || res.status >= 500;
    emailLog('error', `Falló "${label}": HTTP ${res.status} (${ms} ms)`, `${text}${hintFor(res.status, text)}`);
    return { ok: false, error: `EmailJS ${res.status}: ${text}`, retryable };
  } catch (e) {
    const timedOut = controller.signal.aborted;
    const error = timedOut ? 'Timeout enviando el correo' : 'Sin internet en el teléfono';
    emailLog('error', `Falló "${label}": ${error}`,
      timedOut ? `Sin respuesta en ${EMAIL_TIMEOUT_MS / 1000} s` : `${String(e)} · ¿el teléfono tiene datos o Wi-Fi con internet?`);
    return { ok: false, error, retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

export function sendTestEmail(config: EmailConfig, snapshotDataUrl?: string | null): Promise<EmailResult> {
  return sendAlertEmail(config, {
    timestamp: new Date().toISOString(),
    type: 'test',
    description: 'Correo de prueba de SentryNode. Si lo recibes (con la foto adjunta), la configuración es correcta.',
    mode: 'away',
    esp32Ip: '-',
    snapshotDataUrl,
  });
}

/** Pista según el error típico de EmailJS. */
function hintFor(status: number, text: string): string {
  const t = text.toLowerCase();
  if (status === 403 && t.includes('non-browser')) {
    return ' → Activa "Allow EmailJS API for non-browser applications" en Account → Security.';
  }
  if (status === 403) return ' → Revisa la Public Key o, si activaste strict mode, la Private Key.';
  if (t.includes('template')) return ' → Template ID incorrecto.';
  if (t.includes('service')) return ' → Service ID incorrecto o servicio de Gmail desconectado.';
  if (status === 413 || t.includes('size') || t.includes('large')) return ' → Adjunto demasiado grande para tu plan.';
  if (status === 429) return ' → Límite de envíos de EmailJS; se reintentará solo.';
  return '';
}

function translateAlertType(type: string): string {
  const map: Record<string, string> = {
    motion: 'Movimiento Detectado',
    manual_trigger: 'Disparo Manual',
    connection_lost: 'Cámara sin conexión',
    test: 'Prueba de Sistema',
  };
  return map[type] ?? type;
}

function translateMode(mode: string): string {
  const map: Record<string, string> = {
    disarmed: 'Desarmado',
    home: 'En Casa (Perimétrico)',
    away: 'Fuera de Casa (Máxima)',
  };
  return map[mode] ?? mode;
}
