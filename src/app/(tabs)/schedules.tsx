/**
 * src/app/(tabs)/schedules.tsx
 * Route: /schedules  (Horarios tab)
 */
import React from 'react';
import SchedulesScreen from '@/screens/SchedulesScreen';
import { useStore } from '../_layout';

export default function SchedulesRoute() {
  return <SchedulesScreen store={useStore()} />;
}
