/**
 * emailService — correo de alerta con foto adjunta.
 *
 * Dos proveedores, mismo contrato (sendAlertEmail → EmailResult):
 *
 *  1. Gmail API (principal). La app inicia sesión con tu cuenta de Google
 *     (OAuth 2.0, permiso gmail.send) y envía el correo DESDE tu Gmail con
 *     users.messages.send. No hay plantillas externas: el HTML se arma aquí.
 *     Necesita development build (módulo nativo de Google Sign-In).
 *
 *  2. EmailJS (respaldo, funciona en Expo Go). Envía con una plantilla de
 *     emailjs.com; la foto va como "Variable Attachment" llamada `snapshot`.
 *
 * En ambos casos el teléfono necesita internet (por eso el ESP32 va en el
 * hotspot y no en su propio AP).
 */
import type { EmailConfig } from './types';
import { emailLog, maskId } from './emailLog';
import { sendGmail } from './gmailService';
import { GoogleAuthError, getGmailAccessToken, invalidateGmailToken } from './googleAuth';

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

function missingFields(c: EmailConfig): string[] {
  if (c.provider === 'gmail') {
    return [!c.gmailAccount && 'inicio de sesión con Google', !c.recipientEmail && 'destinatario']
      .filter(Boolean) as string[];
  }
  return [
    !c.serviceId && 'Service ID', !c.templateId && 'Template ID',
    !c.publicKey && 'Public Key', !c.recipientEmail && 'destinatario',
  ].filter(Boolean) as string[];
}

export function isEmailConfigured(c: EmailConfig): boolean {
  return missingFields(c).length === 0;
}

export async function sendAlertEmail(config: EmailConfig, payload: AlertEmailPayload): Promise<EmailResult> {
  const label = translateAlertType(payload.type);
  const missing = missingFields(config);
  if (missing.length) {
    const where = config.provider === 'gmail' ? 'Gmail' : 'EmailJS';
    emailLog('warn', `No se envió "${label}": ${where} incompleto`, `Falta: ${missing.join(', ')}`);
    return { ok: false, error: `${where} no está configurado (falta ${missing.join(', ')})`, retryable: false };
  }
  return config.provider === 'gmail'
    ? sendWithGmail(config, payload, label)
    : sendWithEmailJS(config, payload, label);
}

// ─── Gmail API ────────────────────────────────────────────────────────────────

async function sendWithGmail(config: EmailConfig, p: AlertEmailPayload, label: string): Promise<EmailResult> {
  const photoKb = p.snapshotDataUrl ? Math.round(p.snapshotDataUrl.length / 1024) : 0;
  emailLog('info', `Enviando "${label}" por Gmail API a ${config.recipientEmail}`,
    `desde ${config.gmailAccount} · ${photoKb ? `foto ${photoKb} KB` : 'sin foto'}`);

  const message = {
    to: config.recipientEmail,
    fromName: config.senderName || 'SentryNode',
    fromEmail: config.gmailAccount,
    subject: `🚨 SentryNode: ${label}`,
    html: renderAlertHtml(p, label),
    attachment: p.snapshotDataUrl ? { filename: 'intruso.jpg', dataUrl: p.snapshotDataUrl } : null,
  };

  const t0 = Date.now();
  // Hasta 2 intentos: si Gmail responde 401 (token vencido), se pide uno nuevo y se repite
  for (let attempt = 1; attempt <= 2; attempt++) {
    let token: string;
    try {
      token = await getGmailAccessToken();
    } catch (e) {
      const err = e as GoogleAuthError;
      const retryable = err.code === 'other';
      emailLog('error', `Falló "${label}": sin token de Google`, err.message);
      return { ok: false, error: err.message, retryable };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMAIL_TIMEOUT_MS);
    try {
      const res = await sendGmail(token, message, controller.signal);
      const ms = Date.now() - t0;
      if (res.ok) {
        const id = /"id"\s*:\s*"([^"]+)"/.exec(res.body)?.[1];
        emailLog('success', `Enviado "${label}" ✓ por Gmail (HTTP ${res.status}, ${ms} ms)`,
          `Mensaje ${id ?? ''} en "Enviados" de ${config.gmailAccount}`);
        return { ok: true };
      }
      if (res.status === 401 && attempt === 1) {
        emailLog('warn', 'Gmail respondió 401: token vencido, pidiendo uno nuevo…');
        await invalidateGmailToken(token);
        continue;
      }
      const retryable = res.status === 429 || res.status >= 500;
      emailLog('error', `Falló "${label}": Gmail HTTP ${res.status} (${ms} ms)`, `${res.body}${gmailHint(res.status, res.body)}`);
      return { ok: false, error: `Gmail ${res.status}: ${res.body.slice(0, 160)}`, retryable };
    } catch (e) {
      const timedOut = controller.signal.aborted;
      const error = timedOut ? 'Timeout enviando el correo' : 'Sin internet en el teléfono';
      emailLog('error', `Falló "${label}": ${error}`, String(e));
      return { ok: false, error, retryable: true };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: 'Gmail rechazó el token dos veces', retryable: false };
}

function gmailHint(status: number, body: string): string {
  const b = body.toLowerCase();
  if (b.includes('has not been used') || b.includes('is disabled')) {
    return ' → Habilita "Gmail API" en Google Cloud (APIs y servicios → Biblioteca).';
  }
  if (status === 403 && b.includes('insufficient')) return ' → Falta el permiso gmail.send: cierra sesión y vuelve a entrar.';
  if (status === 403) return ' → Revisa que tu cuenta esté como "usuario de prueba" en la pantalla de consentimiento OAuth.';
  if (status === 400 && b.includes('invalid to')) return ' → El destinatario no es un correo válido.';
  if (status === 429) return ' → Límite de envíos de Gmail; se reintentará solo.';
  return '';
}

/** Cuerpo del correo (Gmail API no usa plantillas externas). */
function renderAlertHtml(p: AlertEmailPayload, label: string): string {
  const esc = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  return `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;background:#0f131c;color:#dfe2ef;border-radius:12px;overflow:hidden">
<div style="background:#690005;color:#ffdad6;padding:16px 20px">
<div style="font-size:12px;letter-spacing:1px">SENTRYNODE · ALERTA</div>
<div style="font-size:20px;font-weight:bold">${esc(label)}</div></div>
<div style="padding:20px">
<p style="margin:0 0 12px">${esc(p.description)}</p>
<p style="margin:0;line-height:1.7"><b>Hora:</b> ${esc(humanTime(p.timestamp))}<br>
<b>Modo:</b> ${esc(translateMode(p.mode))}<br><b>Cámara:</b> ${esc(p.esp32Ip)}</p>
<p style="margin:16px 0 0;color:#869397;font-size:13px">${p.snapshotDataUrl ? 'La foto del evento va adjunta (intruso.jpg).' : 'No se pudo obtener foto de la cámara.'}</p>
</div></div>`;
}

// ─── EmailJS (respaldo) ───────────────────────────────────────────────────────

async function sendWithEmailJS(config: EmailConfig, payload: AlertEmailPayload, label: string): Promise<EmailResult> {
  const templateParams: Record<string, string> = {
    to_email: config.recipientEmail,
    from_name: config.senderName || 'SentryNode',
    alert_timestamp: humanTime(payload.timestamp),
    alert_type: label,
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
  emailLog('info', `Enviando "${label}" por EmailJS a ${config.recipientEmail}`,
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
      emailLog('success', `Enviado "${label}" ✓ por EmailJS (HTTP ${res.status}, ${ms} ms)`,
        'EmailJS lo aceptó. Si no llega, revisa spam y el campo "To Email" del template.');
      return { ok: true };
    }
    const text = (await res.text()).slice(0, 200);
    // 4xx = configuración mala (no sirve reintentar). 429/5xx = transitorio.
    const retryable = res.status === 429 || res.status >= 500;
    emailLog('error', `Falló "${label}": HTTP ${res.status} (${ms} ms)`, `${text}${emailJsHint(res.status, text)}`);
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

function emailJsHint(status: number, text: string): string {
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

// ─── Comunes ──────────────────────────────────────────────────────────────────

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

function humanTime(iso: string): string {
  return new Date(iso).toLocaleString('es-CO', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
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
