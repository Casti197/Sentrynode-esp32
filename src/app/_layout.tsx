/**
 * src/app/_layout.tsx — Root Layout
 *
 * - Provee el store a todas las pantallas (contexto).
 * - Pide permiso de notificaciones (Android 13+ lo exige también para la
 *   notificación del Foreground Service).
 * - Arranca la vigilancia: Foreground Service en un development build, o
 *   sondeo dentro de la app en Expo Go.
 */
import '@/global';
import React, { useEffect, createContext, useContext } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { useSecurityStore, type SecurityStore } from '@/store/useSecurityStore';
import { initNotifications } from '@/services/notificationService';
import { startMonitoring } from '@/services/foregroundService';

const StoreContext = createContext<SecurityStore | null>(null);

export function useStore(): SecurityStore {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used inside RootLayout');
  return ctx;
}

export default function RootLayout() {
  const store = useSecurityStore();

  useEffect(() => {
    (async () => {
      await initNotifications();   // Primero el permiso, para que la notificación del FGS se vea
      await startMonitoring();
    })();
  }, []);

  return (
    <StoreContext.Provider value={store}>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false }} />
    </StoreContext.Provider>
  );
}
