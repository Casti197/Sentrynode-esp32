/**
 * src/app/(tabs)/index.tsx
 * Route: /  (Streaming tab)
 */
import React from 'react';
import StreamingScreen from '@/screens/StreamingScreen';
import { useStore } from '../_layout';

export default function StreamingRoute() {
  return <StreamingScreen store={useStore()} />;
}
