/**
 * src/app/(tabs)/alerts.tsx
 * Route: /alerts  (Alertas tab)
 */
import React from 'react';
import AlertsScreen from '@/screens/AlertsScreen';
import { useStore } from '../_layout';

export default function AlertsRoute() {
  return <AlertsScreen store={useStore()} />;
}
