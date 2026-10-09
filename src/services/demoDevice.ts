/**
 * ESP32-CAM simulado (modo demo).
 *
 * Imita el firmware real: misma forma de /status, mismo contador motion_seq,
 * mismo comportamiento de /mode, /flash, /siren y /motion.jpg. Así el motor de
 * vigilancia (monitor.ts), las alertas y el correo por Gmail funcionan
 * exactamente igual que con la placa, pero sin hardware.
 *
 * Igual que el firmware, solo cuenta un evento si el sistema está armado.
 * También se puede "desconectar" para practicar el manejo de errores.
 */
import { DEMO_EVIDENCE_DATA_URL } from './demoImage';
import type { DeviceStatus, SecurityMode } from './types';

const LATENCY_MS = 40;              // Simula el tiempo de ida y vuelta por Wi-Fi
const BLOCKS = 48;

const state = {
  bootAt: Date.now(),
  mode: 'disarmed' as SecurityMode,
  motionSeq: 0,
  motionAt: 0,
  changedBlocks: 0,
  flash: false,
  siren: false,
  online: true,
};

type Listener = () => void;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach(fn => fn());

/** Para que la pantalla de video reaccione (intruso, cámara caída). */
export function subscribeDemo(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getDemoState() {
  return { online: state.online, lastMotionAt: state.motionAt, mode: state.mode };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Lanza el mismo tipo de error que fetch cuando la placa no responde. */
async function reachable(): Promise<void> {
  await sleep(LATENCY_MS);
  if (!state.online) throw new Error('demo-offline');
}

export async function demoStatus(): Promise<DeviceStatus> {
  await reachable();
  const now = Date.now();
  const uptime = now - state.bootAt;
  // Ruido de fondo: 0-1 zonas cambian aunque no haya nadie (como el sensor real)
  const idleNoise = Math.random() < 0.3 ? 1 : 0;
  const recent = state.motionAt && now - state.motionAt < 3000;
  return {
    device: 'sentrynode-demo',
    fw: 2,
    mode: state.mode,
    armed: state.mode !== 'disarmed',
    motion_seq: state.motionSeq,
    motion_detected: !!recent,
    motion_uptime_ms: state.motionAt ? state.motionAt - state.bootAt : 0,
    motion_epoch: state.motionAt ? Math.floor(state.motionAt / 1000) : 0,
    changed_blocks: recent ? state.changedBlocks : idleNoise,
    total_blocks: BLOCKS,
    fps: 14 + Math.random() * 2,
    rssi: -50 - Math.floor(Math.random() * 8),
    ip: 'demo',
    net: 'sta',
    uptime_ms: uptime,
    epoch: Math.floor(now / 1000),
    time_synced: true,
    streaming: true,
    stream_clients: 1,
    flash: state.flash,
    siren: state.siren,
    free_heap: 180000,
    free_psram: 3900000,
  };
}

export async function demoSetMode(mode: SecurityMode): Promise<void> {
  await reachable();
  state.mode = mode;
  if (mode === 'disarmed') state.siren = false;
  emit();
}

export async function demoSetFlash(on: boolean): Promise<void> {
  await reachable();
  state.flash = on;
  emit();
}

export async function demoSetSiren(on: boolean): Promise<void> {
  await reachable();
  state.siren = on;
  emit();
}

export async function demoEvidence(): Promise<string> {
  await reachable();
  if (!state.motionSeq) throw new Error('demo-no-evidence');
  return DEMO_EVIDENCE_DATA_URL;
}

export async function demoSnapshot(): Promise<string> {
  await reachable();
  return DEMO_EVIDENCE_DATA_URL;
}

/**
 * Simula que alguien pasa frente a la cámara. Devuelve false si el sistema
 * está desarmado (el firmware real tampoco cuenta eventos desarmado).
 */
export function simulateIntrusion(): boolean {
  emit();                                   // El video muestra la silueta igual
  if (state.mode === 'disarmed' || !state.online) return false;
  state.motionSeq += 1;
  state.motionAt = Date.now();
  state.changedBlocks = 6 + Math.floor(Math.random() * 10);
  return true;
}

/** Desenchufar / volver a enchufar la cámara (para practicar errores de red). */
export function setDemoOnline(online: boolean): void {
  state.online = online;
  if (online) {
    // Al "volver la luz" la placa reinicia: uptime y contador desde cero, igual que la real
    state.bootAt = Date.now();
    state.motionSeq = 0;
    state.motionAt = 0;
  }
  emit();
}
