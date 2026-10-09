/**
 * Envío por la Gmail API (users.messages.send).
 *
 * Gmail recibe el correo como un mensaje MIME (RFC 2822), el mismo formato que
 * usa cualquier cliente de correo:
 *
 *   multipart/mixed
 *   ├── text/html        cuerpo de la alerta
 *   └── image/jpeg       intruso.jpg (la evidencia del ESP32)
 *
 * Se usa el endpoint de "upload" con Content-Type message/rfc822: se manda el
 * MIME tal cual, sin envolverlo otra vez en base64url dentro de un JSON.
 */

const SEND_URL = 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Texto (UTF-8, con tildes y emojis) → base64. Sin depender de btoa/TextEncoder. */
export function utf8ToBase64(text: string): string {
  const bytes: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else {
      bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
  }
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] +
      (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') +
      (i + 2 < bytes.length ? B64[n & 63] : '=');
  }
  return out;
}

/** Las líneas MIME no deben pasar de 76 caracteres. */
function wrap76(b64: string): string {
  return b64.replace(/.{1,76}/g, '$&\r\n').trimEnd();
}

/** Asunto con tildes/emojis codificado según RFC 2047. */
function encodeHeader(text: string): string {
  return `=?UTF-8?B?${utf8ToBase64(text)}?=`;
}

export interface GmailMessage {
  to: string;
  fromName: string;
  fromEmail: string;       // La cuenta con la que se inició sesión (Gmail no deja falsificarla)
  subject: string;
  html: string;
  attachment?: { filename: string; dataUrl: string } | null;
}

export function buildMime(msg: GmailMessage): string {
  const boundary = `sentrynode_${Date.now().toString(36)}`;
  const lines = [
    `To: ${msg.to}`,
    `From: ${encodeHeader(msg.fromName)} <${msg.fromEmail}>`,
    `Subject: ${encodeHeader(msg.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(utf8ToBase64(msg.html)),
  ];
  if (msg.attachment) {
    const comma = msg.attachment.dataUrl.indexOf(',');
    const data = msg.attachment.dataUrl.slice(comma + 1);
    lines.push(
      `--${boundary}`,
      `Content-Type: image/jpeg; name="${msg.attachment.filename}"`,
      `Content-Disposition: attachment; filename="${msg.attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(data),
    );
  }
  lines.push(`--${boundary}--`, '');
  return lines.join('\r\n');
}

export interface GmailSendResult {
  status: number;
  ok: boolean;
  body: string;
}

export async function sendGmail(accessToken: string, msg: GmailMessage, signal?: AbortSignal): Promise<GmailSendResult> {
  const mime = buildMime(msg);
  const res = await fetch(SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'message/rfc822',
    },
    body: mime,
    signal,
  });
  const body = (await res.text()).slice(0, 400);
  return { status: res.status, ok: res.ok, body };
}
