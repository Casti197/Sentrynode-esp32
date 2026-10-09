/**
 * emailService — correo de alerta con foto adjunta, por la Gmail API.
 *
 * El correo sale DESDE tu Gmail con users.messages.send. El access token se
 * obtiene de una de dos formas:
 *  1. Cuenta fija (.env.local, lo normal): un refresh token autorizado una vez
 *     se cambia por access tokens sin pedir nada en el teléfono.
 *  2. Inicio de sesión con Google en el teléfono (development build).
 * No hay plantillas externas: el HTML se arma aquí.
 *
 * El teléfono necesita internet (por eso el ESP32 va en el hotspot y no en su
 * propio AP).
 */
import type { EmailConfig } from './types';
import { emailLog } from './emailLog';
import { sendGmail } from './gmailService';
import { GoogleAuthError, getGmailAccessToken, invalidateGmailToken } from './googleAuth';
import {
  FixedTokenError, fixedGmailSender, getFixedAccessToken, hasFixedGmailAccount, invalidateFixedToken,
} from './gmailFixedAuth';

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
  const hasAccount = hasFixedGmailAccount() || !!c.gmailAccount;
  return [!hasAccount && 'cuenta de Gmail (.env.local o inicio de sesión)', !c.recipientEmail && 'destinatario']
    .filter(Boolean) as string[];
}

export function isEmailConfigured(c: EmailConfig): boolean {
  return missingFields(c).length === 0;
}

export async function sendAlertEmail(config: EmailConfig, payload: AlertEmailPayload): Promise<EmailResult> {
  const label = translateAlertType(payload.type);
  const missing = missingFields(config);
  if (missing.length) {
    emailLog('warn', `No se envió "${label}": Gmail sin configurar`, `Falta: ${missing.join(', ')}`);
    return { ok: false, error: `Gmail no está configurado (falta ${missing.join(', ')})`, retryable: false };
  }
  return sendWithGmail(config, payload, label);
}

async function sendWithGmail(config: EmailConfig, p: AlertEmailPayload, label: string): Promise<EmailResult> {
  // Cuenta fija (.env.local) primero: no requiere iniciar sesión en el teléfono
  const fixed = hasFixedGmailAccount();
  const from = fixed ? fixedGmailSender() : config.gmailAccount;
  const photoKb = p.snapshotDataUrl ? Math.round(p.snapshotDataUrl.length / 1024) : 0;
  emailLog('info', `Enviando "${label}" por Gmail API a ${config.recipientEmail}`,
    `desde ${from}${fixed ? ' (cuenta fija)' : ''} · ${photoKb ? `foto ${photoKb} KB` : 'sin foto'}`);

  const message = {
    to: config.recipientEmail,
    fromName: config.senderName || 'SentryNode',
    fromEmail: from,
    subject: `🚨 SentryNode: ${label}`,
    html: renderAlertHtml(p, label),
    attachment: p.snapshotDataUrl ? { filename: 'intruso.jpg', dataUrl: p.snapshotDataUrl } : null,
  };

  const t0 = Date.now();
  // Hasta 2 intentos: si Gmail responde 401 (token vencido), se pide uno nuevo y se repite
  for (let attempt = 1; attempt <= 2; attempt++) {
    let token: string;
    try {
      token = fixed ? await getFixedAccessToken() : await getGmailAccessToken();
    } catch (e) {
      const retryable = e instanceof FixedTokenError ? e.retryable : (e as GoogleAuthError).code === 'other';
      const msg = (e as Error).message;
      emailLog('error', `Falló "${label}": sin token de Google`, msg);
      return { ok: false, error: msg, retryable };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMAIL_TIMEOUT_MS);
    try {
      const res = await sendGmail(token, message, controller.signal);
      const ms = Date.now() - t0;
      if (res.ok) {
        const id = /"id"\s*:\s*"([^"]+)"/.exec(res.body)?.[1];
        emailLog('success', `Enviado "${label}" ✓ por Gmail (HTTP ${res.status}, ${ms} ms)`,
          `Mensaje ${id ?? ''} en "Enviados" de ${from}`);
        return { ok: true };
      }
      if (res.status === 401 && attempt === 1) {
        emailLog('warn', 'Gmail respondió 401: token vencido, pidiendo uno nuevo…');
        if (fixed) invalidateFixedToken();
        else await invalidateGmailToken(token);
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

/** Cuerpo HTML del correo. */
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
