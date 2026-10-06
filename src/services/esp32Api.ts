/**
 * Cliente HTTP del firmware SentryNode.
 *
 * - Cada petición tiene timeout propio con AbortController (sin él, fetch puede
 *   quedarse colgado ~60 s si el ESP32 desaparece de la red).
 * - Los errores se clasifican para decidir si vale la pena reintentar.
 * - Los comandos (/mode, /flash, /siren) FIJAN un valor: son idempotentes,
 *   así que reintentarlos nunca deja el sistema en un estado distinto.
 */
import type { DeviceStatus, Esp32Config, SecurityMode } from './types';

export type Esp32ErrorKind = 'timeout' | 'network' | 'http' | 'invalid';

export class Esp32Error extends Error {
  constructor(public kind: Esp32ErrorKind, message: string, public status?: number) {
    super(message);
    this.name = 'Esp32Error';
  }
}

export const STATUS_TIMEOUT_MS = 2500;
export const COMMAND_TIMEOUT_MS = 3000;
export const IMAGE_TIMEOUT_MS = 6000;

export function controlUrl(cfg: Esp32Config): string {
  return `http://${cfg.ip}:${cfg.controlPort}`;
}

export function streamUrl(cfg: Esp32Config): string {
  return `http://${cfg.ip}:${cfg.streamPort}/stream`;
}

/** fetch con timeout y cancelación externa opcional. */
async function request(url: string, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener('abort', onExternalAbort);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'Cache-Control': 'no-cache' } });
    if (!res.ok) throw new Esp32Error('http', `HTTP ${res.status} en ${url}`, res.status);
    return res;
  } catch (e) {
    if (e instanceof Esp32Error) throw e;
    if (controller.signal.aborted) {
      throw new Esp32Error('timeout', `Sin respuesta en ${timeoutMs} ms`);
    }
    throw new Esp32Error('network', '¿El teléfono y el ESP32 están en la misma red?');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

function isDeviceStatus(x: any): x is DeviceStatus {
  return x && typeof x === 'object' &&
    typeof x.motion_seq === 'number' &&
    typeof x.uptime_ms === 'number' &&
    (x.mode === 'disarmed' || x.mode === 'home' || x.mode === 'away');
}

export async function getStatus(cfg: Esp32Config, signal?: AbortSignal): Promise<DeviceStatus> {
  const res = await request(`${controlUrl(cfg)}/status`, STATUS_TIMEOUT_MS, signal);
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Esp32Error('invalid', 'El ESP32 respondió algo que no es JSON');
  }
  if (!isDeviceStatus(data)) throw new Esp32Error('invalid', 'JSON de /status con forma inesperada');
  return data;
}

/** Reintenta solo fallas transitorias (timeout/red), con backoff exponencial. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 300): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const transient = e instanceof Esp32Error && (e.kind === 'timeout' || e.kind === 'network');
      if (!transient || i === attempts - 1) break;
      await new Promise(r => setTimeout(r, baseDelayMs * 2 ** i));
    }
  }
  throw lastError;
}

export function setDeviceMode(cfg: Esp32Config, mode: SecurityMode): Promise<void> {
  return withRetry(async () => {
    await request(`${controlUrl(cfg)}/mode?value=${mode}`, COMMAND_TIMEOUT_MS);
  });
}

export function setFlash(cfg: Esp32Config, on: boolean): Promise<void> {
  return withRetry(async () => {
    await request(`${controlUrl(cfg)}/flash?state=${on ? 1 : 0}`, COMMAND_TIMEOUT_MS);
  });
}

export function setSiren(cfg: Esp32Config, on: boolean): Promise<void> {
  return withRetry(async () => {
    await request(`${controlUrl(cfg)}/siren?state=${on ? 1 : 0}`, COMMAND_TIMEOUT_MS);
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Esp32Error('invalid', 'No se pudo leer la imagen'));
    reader.readAsDataURL(blob);
  });
}

async function fetchJpegDataUrl(url: string): Promise<string> {
  return withRetry(async () => {
    const res = await request(url, IMAGE_TIMEOUT_MS);
    const dataUrl = await blobToDataUrl(await res.blob());
    // Normalizar el MIME (algunos Android lo reportan como application/octet-stream)
    return dataUrl.replace(/^data:[^;]*;/, 'data:image/jpeg;');
  });
}

/** Foto del último evento de movimiento (320×240, ~10-15 KB). */
export function fetchEvidence(cfg: Esp32Config): Promise<string> {
  return fetchJpegDataUrl(`${controlUrl(cfg)}/motion.jpg?t=${Date.now()}`);
}

/** Foto actual (640×480). */
export function fetchSnapshot(cfg: Esp32Config): Promise<string> {
  return fetchJpegDataUrl(`${controlUrl(cfg)}/capture?t=${Date.now()}`);
}
