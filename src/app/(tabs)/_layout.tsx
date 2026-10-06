/**
 * src/app/(tabs)/_layout.tsx  — Tab Navigator Layout
 *
 * Pestañas de Expo Router. Tres rutas:
 *   index      → Streaming screen   (/)
 *   schedules  → Horarios screen
 *   alerts     → Alertas screen
 */

import React from 'react';
import { Tabs } from 'expo-router';
import { MaterialIcons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useStore } from '../_layout';

export default function TabsLayout() {
  const { unreadAlerts } = useStore();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: '#0a0e17',
          borderTopColor: '#1c1f29',
          borderTopWidth: 1,
          height: 64,
          paddingBottom: 8,
        },
        tabBarActiveTintColor: '#4cd7f6',
        tabBarInactiveTintColor: '#bcc9cd',
        tabBarLabelStyle: {
          fontFamily: 'monospace',
          fontSize: 9,
          fontWeight: '700',
          letterSpacing: 0.8,
          textTransform: 'uppercase',
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Streaming',
          tabBarIcon: ({ color, size }) => (
            <MaterialIcons name="videocam" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="schedules"
        options={{
          title: 'Horarios',
          tabBarIcon: ({ color, size }) => (
            <MaterialIcons name="schedule" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="alerts"
        options={{
          title: 'Alertas',
          tabBarBadge: unreadAlerts > 0 ? unreadAlerts : undefined,
          tabBarBadgeStyle: {
            backgroundColor: '#ffb4ab',
            color: '#690005',
            fontSize: 9,
            minWidth: 16,
            height: 16,
            lineHeight: 16,
          },
          tabBarIcon: ({ color, size }) => (
            <MaterialCommunityIcons name="shield-alert-outline" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
