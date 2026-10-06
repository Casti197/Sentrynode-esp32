/**
 * notificationService
 *
 * Expo Go compatibility layer for expo-notifications.
 *
 * ROOT CAUSE (SDK 53+):
 *   expo-notifications/build/DevicePushTokenAutoRegistration.fx.js calls
 *   addPushTokenListener() at module top level, which calls warnOfExpoGoPushUsage(),
 *   which throws new Error() on Android Expo Go.
 *   A static `import * as Notifications from 'expo-notifications'` triggers this
 *   throw BEFORE any try/catch can intercept it, crashing the entire module graph.
 *
 * FIX:
 *   Use dynamic require() inside each function, guarded by isRunningInExpoGo().
 *   When running in Expo Go on Android, all functions become silent no-ops.
 *   In a development build or production build, full functionality is available.
 */

import { isRunningInExpoGo } from 'expo';
import { Platform } from 'react-native';

export const ALERT_CHANNEL_ID = 'sentry-alerts';

// ─── Safe dynamic loader ──────────────────────────────────────────────────────

function getNotifications(): any | null {
  if (isRunningInExpoGo() && Platform.OS === 'android') {
    // Cannot use expo-notifications on Android Expo Go — return null no-op guard
    return null;
  }
  try {
    // Dynamic require so the module is never statically imported at the top level.
    // This prevents DevicePushTokenAutoRegistration.fx.js from executing on load.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-notifications');
  } catch {
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Crea el canal de alertas (Android) y pide permiso de notificaciones
 * (en Android 13+ también lo necesita la notificación del Foreground Service).
 * No-op in Expo Go on Android.
 */
export async function initNotifications(): Promise<boolean> {
  const N = getNotifications();
  if (!N) return false;

  try {
    N.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });

    if (Platform.OS === 'android') {
      await N.setNotificationChannelAsync(ALERT_CHANNEL_ID, {
        name: 'Alertas de Intrusión',
        importance: N.AndroidImportance.MAX,
        lockscreenVisibility: N.AndroidNotificationVisibility.PUBLIC,
        sound: 'default',
        vibrationPattern: [0, 500, 250, 500],
        showBadge: true,
        description: 'Alertas críticas de detección de movimiento',
      });
    }

    const { status: existingStatus } = await N.getPermissionsAsync();
    if (existingStatus === 'granted') return true;

    const { status } = await N.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowBadge: true,
        allowSound: true,
        allowCriticalAlerts: true,
      },
    });
    return status === 'granted';
  } catch (e) {
    console.warn('[notificationService] initNotifications error:', e);
    return false;
  }
}

/**
 * Notificación inmediata de alerta (canal de máxima prioridad).
 * No-op en Expo Go para Android.
 */
export async function sendAlertNotification(params: {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}): Promise<string> {
  const N = getNotifications();
  if (!N) return '';
  try {
    return await N.scheduleNotificationAsync({
      content: {
        title: params.title,
        body: params.body,
        data: params.data ?? {},
        sound: 'default',
        priority: N.AndroidNotificationPriority?.MAX,
        ...(Platform.OS === 'android' && { channelId: ALERT_CHANNEL_ID }),
      },
      trigger: null,
    });
  } catch (e) {
    console.warn('[notificationService] sendAlertNotification error:', e);
    return '';
  }
}

export function sendIntrusionAlert(params: { timestamp: string; description: string; mode: string }): Promise<string> {
  return sendAlertNotification({
    title: '🚨 INTRUSIÓN DETECTADA',
    body: `${params.description}\n${new Date(params.timestamp).toLocaleString('es-CO')}`,
    data: { type: 'intrusion', ...params },
  });
}
