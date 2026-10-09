/**
 * Inicio de sesión con Google para usar la Gmail API.
 *
 * Flujo OAuth 2.0 (lo maneja Google Play Services en el teléfono):
 *  1. El usuario toca "Iniciar sesión con Google" y acepta el permiso
 *     "Enviar correo en tu nombre" (scope gmail.send). Es el ÚNICO permiso que
 *     pedimos: la app no puede leer ni borrar correos.
 *  2. Google entrega un access token de corta duración (~1 h). Cuando vence,
 *     getTokens() pide otro en silencio, sin mostrar nada al usuario. Por eso
 *     el Foreground Service puede enviar correos en segundo plano.
 *
 * Usa un módulo nativo (@react-native-google-signin/google-signin), así que
 * solo funciona en un development build. En Expo Go no existe y la app cae
 * a EmailJS.
 *
 * Requisito en Google Cloud: un cliente OAuth de tipo Android con el paquete
 * com.unisabana.sentrynode y la huella SHA-1 del certificado con el que se
 * firmó la app (ver README).
 */
import { isRunningInExpoGo } from 'expo';
import Constants from 'expo-constants';

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

type GoogleModule = typeof import('@react-native-google-signin/google-signin');

let mod: GoogleModule | null | undefined;
let configured = false;

function google(): GoogleModule | null {
  if (mod !== undefined) return mod;
  if (isRunningInExpoGo()) return (mod = null);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('@react-native-google-signin/google-signin') as GoogleModule;
  } catch {
    mod = null;
  }
  return mod;
}

function ensureConfigured(g: GoogleModule) {
  if (configured) return;
  const webClientId = Constants.expoConfig?.extra?.googleWebClientId as string | undefined;
  g.GoogleSignin.configure({
    scopes: [GMAIL_SEND_SCOPE],
    ...(webClientId ? { webClientId } : {}),
  });
  configured = true;
}

export class GoogleAuthError extends Error {
  constructor(public code: 'unavailable' | 'not_signed_in' | 'cancelled' | 'config' | 'other', message: string) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

export function isGoogleSignInAvailable(): boolean {
  return google() !== null;
}

/** Traduce los errores nativos más comunes a algo accionable. */
function explain(e: any): GoogleAuthError {
  const g = google();
  const code = String(e?.code ?? '');
  if (g && code === g.statusCodes.SIGN_IN_CANCELLED) return new GoogleAuthError('cancelled', 'Inicio de sesión cancelado');
  if (g && code === g.statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
    return new GoogleAuthError('other', 'Google Play Services no está disponible o está desactualizado');
  }
  if (code === '10' || /DEVELOPER_ERROR/i.test(String(e?.message))) {
    return new GoogleAuthError('config',
      'DEVELOPER_ERROR: en Google Cloud falta el cliente OAuth Android con el paquete com.unisabana.sentrynode y la SHA-1 de esta compilación');
  }
  return new GoogleAuthError('other', String(e?.message ?? e));
}

/** Abre la ventana de Google. Devuelve el correo de la cuenta o null si se canceló. */
export async function signInWithGoogle(): Promise<string | null> {
  const g = google();
  if (!g) {
    throw new GoogleAuthError('unavailable',
      'Gmail API necesita un development build (npx expo run:android). En Expo Go usa EmailJS.');
  }
  ensureConfigured(g);
  try {
    await g.GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const res = await g.GoogleSignin.signIn();
    if (res.type !== 'success') return null;
    // Si la cuenta ya existía sin el permiso de Gmail, pedirlo aparte
    if (!res.data.scopes?.includes(GMAIL_SEND_SCOPE)) {
      const added = await g.GoogleSignin.addScopes({ scopes: [GMAIL_SEND_SCOPE] });
      if (!added || added.type !== 'success') {
        throw new GoogleAuthError('cancelled', 'No se concedió el permiso para enviar correo');
      }
    }
    return res.data.user.email;
  } catch (e) {
    if (e instanceof GoogleAuthError) throw e;
    throw explain(e);
  }
}

export async function signOutGoogle(): Promise<void> {
  const g = google();
  if (!g) return;
  ensureConfigured(g);
  try { await g.GoogleSignin.signOut(); } catch { /* ya estaba fuera */ }
}

/**
 * Access token vigente con permiso gmail.send. Si no hay sesión en memoria
 * (p. ej. la app se reinició), la recupera en silencio.
 */
export async function getGmailAccessToken(): Promise<string> {
  const g = google();
  if (!g) throw new GoogleAuthError('unavailable', 'Gmail API no disponible en Expo Go');
  ensureConfigured(g);
  try {
    if (!g.GoogleSignin.getCurrentUser()) {
      const silent = await g.GoogleSignin.signInSilently();
      if (silent.type !== 'success') {
        throw new GoogleAuthError('not_signed_in', 'No hay sesión de Google: inicia sesión en Horarios → Alertas Email');
      }
    }
    const { accessToken } = await g.GoogleSignin.getTokens();
    return accessToken;
  } catch (e) {
    if (e instanceof GoogleAuthError) throw e;
    const g2 = google();
    if (g2 && String((e as any)?.code) === g2.statusCodes.SIGN_IN_REQUIRED) {
      throw new GoogleAuthError('not_signed_in', 'La sesión de Google venció: vuelve a iniciar sesión');
    }
    throw explain(e);
  }
}

/** Un token que Gmail rechazó (401) se descarta para que getTokens() pida otro. */
export async function invalidateGmailToken(token: string): Promise<void> {
  const g = google();
  if (!g) return;
  try { await g.GoogleSignin.clearCachedAccessToken(token); } catch { /* nada */ }
}
