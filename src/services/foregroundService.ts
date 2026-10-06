/**
 * Foreground Service (Android) para que la vigilancia siga con la app en
 * segundo plano o con la pantalla apagada.
 *
 * ¿Por qué un Foreground Service y no BackgroundFetch / WorkManager?
 * Android congela los procesos en segundo plano y las tareas periódicas tienen
 * un mínimo de ~15 min. Un Foreground Service, en cambio, mantiene el proceso
 * vivo con una notificación persistente obligatoria, y el sistema no lo mata
 * salvo bajo presión de memoria extrema. Eso permite sondear cada 1.5 s.
 *
 * Tipo de servicio: `connectedDevice` (Android 14+ exige declarar el tipo).
 * Describe justo lo que hacemos: mantener comunicación con un dispositivo
 * externo (la cámara). `dataSync` tendría un límite de 6 h/día en Android 15.
 *
 * Implementación: react-native-background-actions, que arranca un servicio
 * nativo y ejecuta nuestra función JS como HeadlessJS en el mismo hilo JS.
 * Requiere un development build; en Expo Go el módulo nativo no existe y se
 * cae al modo "in-app" (solo vigila mientras la app está abierta).
 */
import { AppState, NativeModules, Platform } from 'react-native';
import { monitor } from './monitor';

type BackgroundServiceType = typeof import('react-native-background-actions').default;

let BackgroundService: BackgroundServiceType | null = null;
let started = false;

function loadNative(): BackgroundServiceType | null {
  if (BackgroundService) return BackgroundService;
  if (Platform.OS !== 'android' || !NativeModules.RNBackgroundActions) return null; // Expo Go / iOS
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    BackgroundService = require('react-native-background-actions').default;
  } catch {
    BackgroundService = null;
  }
  return BackgroundService;
}

export function isForegroundServiceAvailable(): boolean {
  return loadNative() !== null;
}

/** Arranca la vigilancia una sola vez (idempotente). */
export async function startMonitoring(): Promise<void> {
  if (started) return;
  started = true;
  const BS = loadNative();
  AppState.addEventListener('change', (state) => {
    if (state === 'active') monitor.pokeNow();   // Al volver a la app, consultar de inmediato
  });

  if (BS) {
    monitor.onSummaryChange = (summary) => {
      if (BS.isRunning()) BS.updateNotification({ taskDesc: summary }).catch(() => {});
    };
    try {
      await BS.start(
        () => monitor.run('foreground-service', () => BS.isRunning()),
        {
          taskName: 'SentryNodeMonitor',
          taskTitle: 'SentryNode vigilando',
          taskDesc: 'Conectando con la cámara…',
          taskIcon: { name: 'ic_launcher', type: 'mipmap' },
          color: '#4cd7f6',
          linkingURI: 'sentrynode://',
          foregroundServiceType: ['connectedDevice'],
        },
      );
      return;
    } catch (e) {
      // Ej.: Android 12+ no deja iniciar un FGS si la app ya está en segundo plano
      console.warn('[foregroundService] No se pudo iniciar; usando modo in-app:', e);
    }
  }

  // Fallback (Expo Go): el mismo motor, pero solo mientras la app esté abierta
  monitor.run('in-app', () => true);
}

export async function stopMonitoring(): Promise<void> {
  const BS = loadNative();
  if (BS?.isRunning()) await BS.stop();
  monitor.stop();
  started = false;
}
