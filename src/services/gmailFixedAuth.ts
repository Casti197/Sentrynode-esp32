/**
 * Gmail API con CUENTA FIJA (sin iniciar sesión en el teléfono).
 *
 * Tu cuenta se autoriza UNA vez desde el PC (OAuth 2.0 Playground) y Google
 * entrega un "refresh token". La app lo guarda y, cada vez que va a enviar,
 * lo cambia por un access token de ~1 hora:
 *
 *   POST https://oauth2.googleapis.com/token
 *        grant_type=refresh_token & client_id & client_secret & refresh_token
 *   ← { access_token, expires_in }
 *
 * Así no hay pantallas de Google en el teléfono: el correo sale directo desde
 * tu Gmail, también en segundo plano.
 *
 * Las credenciales vienen de `.env.local` (no se sube a GitHub):
 *   EXPO_PUBLIC_GMAIL_CLIENT_ID=...
 *   EXPO_PUBLIC_GMAIL_CLIENT_SECRET=...
 *   EXPO_PUBLIC_GMAIL_REFRESH_TOKEN=...
 *   EXPO_PUBLIC_GMAIL_SENDER=tu_correo@gmail.com
 * Expo las incrusta en el código al empaquetar (las variables EXPO_PUBLIC_*
 * quedan dentro de la app). Para un proyecto de clase está bien; en una app
 * pública el token viviría en un servidor, no en el teléfono.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const creds = {
  clientId: process.env.EXPO_PUBLIC_GMAIL_CLIENT_ID ?? '',
  clientSecret: process.env.EXPO_PUBLIC_GMAIL_CLIENT_SECRET ?? '',
  refreshToken: process.env.EXPO_PUBLIC_GMAIL_REFRESH_TOKEN ?? '',
  sender: process.env.EXPO_PUBLIC_GMAIL_SENDER ?? '',
};

let cached: { token: string; expiresAt: number } | null = null;

export function hasFixedGmailAccount(): boolean {
  return !!(creds.clientId && creds.clientSecret && creds.refreshToken && creds.sender);
}

export function fixedGmailSender(): string {
  return creds.sender;
}

export class FixedTokenError extends Error {
  constructor(message: string, public retryable: boolean) {
    super(message);
    this.name = 'FixedTokenError';
  }
}

/** Access token vigente; lo renueva si faltan menos de 60 s para que venza. */
export async function getFixedAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

  const body = [
    ['grant_type', 'refresh_token'],
    ['client_id', creds.clientId],
    ['client_secret', creds.clientSecret],
    ['refresh_token', creds.refreshToken],
  ].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (e) {
    throw new FixedTokenError(
      `Sin internet para pedir el token a Google (${String((e as Error)?.message ?? e)}). ` +
      '¿El teléfono está en una red sin salida a internet, como el AP del ESP32?', true);
  }

  const text = await res.text();
  if (!res.ok) {
    if (text.includes('invalid_grant')) {
      throw new FixedTokenError(
        'invalid_grant: el refresh token venció o fue revocado. En modo "Prueba" dura 7 días: ' +
        'genera uno nuevo en OAuth Playground (o publica la app en Google Cloud).', false);
    }
    if (text.includes('invalid_client') || text.includes('unauthorized_client')) {
      throw new FixedTokenError(
        'invalid_client: el Client ID o el Client Secret de .env.local no coinciden con el refresh token.', false);
    }
    throw new FixedTokenError(`Google ${res.status}: ${text.slice(0, 160)}`, res.status >= 500);
  }

  const data = JSON.parse(text) as { access_token: string; expires_in: number };
  cached = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

/** Si Gmail rechaza el token (401), se descarta para pedir otro. */
export function invalidateFixedToken(): void {
  cached = null;
}
