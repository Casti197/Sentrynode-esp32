/**
 * AlertsScreen
 *
 * Module 3 — Alert Log & Email Dispatch
 *
 * Displays:
 *   - Chronological list of all intrusion events
 *   - Alert type, timestamp, description, email delivery status
 *   - Foto de evidencia de cada evento (guardada en el teléfono)
 *   - Reintento manual del correo (el motor ya reintenta solo con backoff)
 *   - Alerta de prueba con la foto actual de la cámara
 *   - Clear all alerts
 */

import React, { useEffect, useCallback, useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView,
  Alert, Image, Modal, Pressable,
} from 'react-native';
import { useIsFocused } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons, MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import type { SecurityStore, AlertEvent } from '@/store/useSecurityStore';
import { loadEvidence } from '@/services/storage';

interface Props {
  store: SecurityStore;
}

// ─── Alert type config ────────────────────────────────────────────────────────

const ALERT_TYPE_CONFIG = {
  motion: {
    label: 'Movimiento Detectado',
    icon: 'motion-sensor' as const,
    color: '#ffb4ab',
    bgColor: 'bg-error/10',
  },
  manual_trigger: {
    label: 'Disparo Manual',
    icon: 'alarm-light' as const,
    color: '#4cd7f6',
    bgColor: 'bg-primary/10',
  },
  connection_lost: {
    label: 'Conexión Perdida',
    icon: 'wifi-off' as const,
    color: '#869397',
    bgColor: 'bg-surface-container-highest',
  },
};

// ─── Timestamp formatter ──────────────────────────────────────────────────────

function formatTimestamp(iso: string): { date: string; time: string; relative: string } {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffH = Math.floor(diffMin / 60);
  const diffD = Math.floor(diffH / 24);

  let relative: string;
  if (diffMin < 1) relative = 'Ahora mismo';
  else if (diffMin < 60) relative = `Hace ${diffMin} min`;
  else if (diffH < 24) relative = `Hace ${diffH} h`;
  else relative = `Hace ${diffD} día${diffD > 1 ? 's' : ''}`;

  const date = d.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return { date, time, relative };
}

// ─── Evidence image (se carga de AsyncStorage bajo demanda) ──────────────────

function EvidenceImage({ alertId, onOpen }: { alertId: string; onOpen: (uri: string) => void }) {
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    loadEvidence(alertId).then(v => { if (alive) setUri(v); });
    return () => { alive = false; };
  }, [alertId]);
  if (!uri) return null;
  return (
    <TouchableOpacity onPress={() => onOpen(uri)} className="mt-space-sm rounded-lg overflow-hidden">
      <Image source={{ uri }} style={{ width: '100%', aspectRatio: 4 / 3 }} resizeMode="cover" />
    </TouchableOpacity>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function AlertsScreen({ store }: Props) {
  const {
    alerts, clearAlerts, markAlertsRead, retryEmail, triggerTestAlert, isSystemArmed,
  } = store;
  const [viewer, setViewer] = useState<string | null>(null);
  const isFocused = useIsFocused();

  // Marcar como leídas mientras la pestaña está visible (también las que llegan estando aquí)
  useEffect(() => {
    if (isFocused) markAlertsRead();
  }, [isFocused, alerts.length, markAlertsRead]);

  // ── Resend email ───────────────────────────────────────────────────────────

  const handleResendEmail = useCallback(async (alert: AlertEvent) => {
    await retryEmail(alert.id);
  }, [retryEmail]);

  // ── Manual trigger test ────────────────────────────────────────────────────

  const handleManualTrigger = useCallback(() => {
    Alert.alert(
      'Alerta de prueba',
      'Se tomará una foto con la cámara y se enviarán la notificación y el correo.',
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Disparar', style: 'destructive', onPress: () => { triggerTestAlert(); } },
      ],
    );
  }, [triggerTestAlert]);

  // ── Clear all ──────────────────────────────────────────────────────────────

  const handleClearAll = useCallback(() => {
    if (alerts.length === 0) return;
    Alert.alert('Limpiar historial', `¿Eliminar ${alerts.length} alertas?`, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Eliminar todo', style: 'destructive', onPress: clearAlerts },
    ]);
  }, [alerts.length, clearAlerts]);

  // ── Alert card ─────────────────────────────────────────────────────────────

  const renderAlert = (alert: AlertEvent) => {
    const config = ALERT_TYPE_CONFIG[alert.type] ?? ALERT_TYPE_CONFIG.motion;
    const { date, time, relative } = formatTimestamp(alert.timestamp);

    return (
      <View key={alert.id} className={`rounded-xl p-space-md shadow-sm mb-space-sm border-l-4 ${config.bgColor} bg-surface-container-low`}
        style={{ borderLeftColor: config.color }}
      >
        <View className="flex-row items-start justify-between">
          <View className="flex-row items-center gap-space-sm flex-1">
            <View className="w-9 h-9 rounded-lg bg-surface-container-highest items-center justify-center shrink-0">
              <MaterialCommunityIcons name={config.icon} size={20} color={config.color} />
            </View>
            <View className="flex-1">
              <Text className="font-headline-sm text-headline-sm text-on-surface" style={{ color: config.color }}>
                {config.label}
              </Text>
              <Text className="font-telemetry-sm text-telemetry-sm text-on-surface-variant" numberOfLines={2}>
                {alert.description}
              </Text>
            </View>
          </View>
          <View className="items-end ml-space-sm">
            <Text className="font-label-caps text-label-caps text-on-surface-variant">{relative}</Text>
            {alert.emailSent ? (
              <View className="flex-row items-center gap-1 mt-1">
                <MaterialIcons name="mark-email-read" size={12} color="#4edea3" />
                <Text className="font-label-caps text-label-caps text-secondary uppercase">Email ✓</Text>
              </View>
            ) : (
              <View className="flex-row items-center gap-1 mt-1">
                <MaterialIcons name="email" size={12} color="#869397" />
                <Text className="font-label-caps text-label-caps text-outline uppercase">
                  {alert.emailAttempts > 0 ? `Email ✗ (${alert.emailAttempts})` : 'Email pendiente'}
                </Text>
              </View>
            )}
          </View>
        </View>

        {/* Timestamp detail */}
        <View className="flex-row items-center mt-space-sm gap-space-sm">
          <View className="flex-row items-center gap-space-xs">
            <MaterialIcons name="calendar-today" size={11} color="#869397" />
            <Text className="font-label-caps text-label-caps text-outline uppercase">{date}</Text>
          </View>
          <View className="flex-row items-center gap-space-xs">
            <MaterialIcons name="access-time" size={11} color="#869397" />
            <Text className="font-label-caps text-label-caps text-outline uppercase">{time}</Text>
          </View>
        </View>

        {/* Foto de evidencia */}
        {alert.hasImage && <EvidenceImage alertId={alert.id} onOpen={setViewer} />}

        {/* Error del último intento de correo */}
        {!alert.emailSent && alert.lastEmailError && (
          <Text className="font-telemetry-sm text-telemetry-sm text-error mt-space-xs" numberOfLines={2}>
            {alert.lastEmailError}
          </Text>
        )}

        {/* Actions */}
        {!alert.emailSent && alert.lastEmailError && (
          <TouchableOpacity
            onPress={() => handleResendEmail(alert)}
            className="mt-space-sm bg-primary/15 rounded-lg py-space-xs flex-row items-center justify-center gap-space-xs"
          >
            <MaterialIcons name="send" size={14} color="#4cd7f6" />
            <Text className="font-label-caps text-label-caps text-primary uppercase">Reenviar email</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  // ─── Render ────────────────────────────────────────────────────────────────

  const totalMotion = alerts.filter(a => a.type === 'motion').length;
  const totalEmailSent = alerts.filter(a => a.emailSent).length;

  return (
    <SafeAreaView className="flex-1 bg-surface">
      <StatusBar style="light" />

      {/* Header */}
      <View className="h-16 px-margin flex-row items-center justify-between bg-surface-container-lowest shadow-lg">
        <View className="flex-col">
          <Text className="font-headline-sm text-headline-sm text-on-surface tracking-tight leading-tight">
            Historial de Alertas
          </Text>
          <Text className="font-telemetry-sm text-telemetry-sm text-primary uppercase">
            {alerts.length} eventos registrados
          </Text>
        </View>
        <View className="flex-row gap-space-sm">
          <TouchableOpacity
            onPress={handleManualTrigger}
            className="bg-error/15 px-space-sm py-space-xs rounded-xl flex-row items-center gap-space-xs"
          >
            <MaterialCommunityIcons name="alarm-light-outline" size={16} color="#ffb4ab" />
            <Text className="font-label-caps text-label-caps text-error uppercase">Probar</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleClearAll}
            disabled={alerts.length === 0}
            className="bg-surface-container-low px-space-sm py-space-xs rounded-xl"
          >
            <MaterialIcons name="delete-outline" size={18} color={alerts.length > 0 ? '#bcc9cd' : '#31353f'} />
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        className="flex-1 bg-surface"
        contentContainerStyle={{ paddingBottom: 100, paddingTop: 16, paddingHorizontal: 16 }}
        showsVerticalScrollIndicator={false}
      >

        {/* ── Stats strip ──────────────────────────────────────────────────── */}
        <View className="flex-row gap-space-xs mb-space-md">
          <View className="flex-1 bg-surface-container-low rounded-xl p-space-sm items-center">
            <Text className="font-telemetry-lg text-telemetry-lg text-error">{totalMotion}</Text>
            <Text className="font-label-caps text-label-caps text-on-surface-variant uppercase">Intrusiones</Text>
          </View>
          <View className="flex-1 bg-surface-container-low rounded-xl p-space-sm items-center mx-1">
            <Text className="font-telemetry-lg text-telemetry-lg text-secondary">{totalEmailSent}</Text>
            <Text className="font-label-caps text-label-caps text-on-surface-variant uppercase">Emails Env.</Text>
          </View>
          <View className="flex-1 bg-surface-container-low rounded-xl p-space-sm items-center">
            <Text className={`font-telemetry-lg text-telemetry-lg ${isSystemArmed ? 'text-secondary' : 'text-outline'}`}>
              {isSystemArmed ? 'ON' : 'OFF'}
            </Text>
            <Text className="font-label-caps text-label-caps text-on-surface-variant uppercase">Armado</Text>
          </View>
        </View>

        {/* ── Alert list ────────────────────────────────────────────────────── */}
        {alerts.length === 0 ? (
          <View className="items-center py-space-xl">
            <MaterialCommunityIcons name="shield-check-outline" size={56} color="#3d494c" />
            <Text className="font-headline-md text-headline-md text-outline mt-space-md">
              Sin alertas
            </Text>
            <Text className="font-body-sm text-body-sm text-on-surface-variant mt-1 text-center">
              El sistema no ha detectado ninguna intrusión. El historial aparecerá aquí cuando se registren eventos.
            </Text>
          </View>
        ) : (
          alerts.map(renderAlert)
        )}
      </ScrollView>

      {/* Visor de foto a pantalla completa */}
      <Modal visible={!!viewer} transparent animationType="fade" onRequestClose={() => setViewer(null)}>
        <Pressable onPress={() => setViewer(null)} className="flex-1 bg-black items-center justify-center">
          {viewer && <Image source={{ uri: viewer }} style={{ width: '100%', aspectRatio: 4 / 3 }} resizeMode="contain" />}
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}
