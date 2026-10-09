/**
 * Panel de registro en vivo, reutilizable:
 *  - EmailLogPanel → cada intento de correo (enviando, enviado, error, reintentos).
 *  - DeviceLogPanel → conexión app ↔ ESP32 (conectado, perdido, reconectado,
 *    reinicios, sincronización de modo).
 */
import React, { useState, useSyncExternalStore } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import type { EventLog, LogLevel } from '@/services/eventLog';
import { emailEvents } from '@/services/emailLog';
import { deviceEvents } from '@/services/deviceLog';

type IconName = keyof typeof MaterialIcons.glyphMap;

const LEVEL_STYLE: Record<LogLevel, { icon: IconName; color: string }> = {
  info: { icon: 'info-outline', color: '#4cd7f6' },
  success: { icon: 'check-circle', color: '#4edea3' },
  warn: { icon: 'warning', color: '#ffd479' },
  error: { icon: 'error', color: '#ffb4ab' },
};

const COLLAPSED = 8;

interface Props {
  title: string;
  events: EventLog;
  emptyText: string;
  infoIcon?: IconName;
}

export function LogPanel({ title, events, emptyText, infoIcon }: Props) {
  const logs = useSyncExternalStore(events.subscribe, events.get);
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? logs : logs.slice(0, COLLAPSED);

  return (
    <View className="bg-surface-container-low rounded-xl p-space-md shadow-sm">
      <View className="flex-row items-center justify-between mb-space-sm">
        <Text className="font-label-caps text-label-caps text-outline uppercase tracking-wider">
          {title} ({logs.length})
        </Text>
        {logs.length > 0 && (
          <TouchableOpacity onPress={events.clear} className="flex-row items-center gap-1">
            <MaterialIcons name="delete-outline" size={14} color="#869397" />
            <Text className="font-label-caps text-label-caps text-outline uppercase">Limpiar</Text>
          </TouchableOpacity>
        )}
      </View>

      {logs.length === 0 ? (
        <Text className="font-body-sm text-body-sm text-on-surface-variant">
          {emptyText}
        </Text>
      ) : (
        visible.map(entry => {
          const st = LEVEL_STYLE[entry.level];
          const icon = entry.level === 'info' && infoIcon ? infoIcon : st.icon;
          const time = new Date(entry.at).toLocaleTimeString('es-CO', {
            hour: '2-digit', minute: '2-digit', second: '2-digit',
          });
          return (
            <View key={entry.id} className="flex-row gap-space-xs py-1.5 border-b border-surface-container-highest">
              <MaterialIcons name={icon} size={14} color={st.color} style={{ marginTop: 2 }} />
              <View className="flex-1">
                <Text className="font-telemetry-sm text-telemetry-sm" style={{ color: st.color }}>
                  {time}  {entry.message}
                </Text>
                {entry.detail ? (
                  <Text className="font-body-sm text-body-sm text-on-surface-variant" selectable>
                    {entry.detail}
                  </Text>
                ) : null}
              </View>
            </View>
          );
        })
      )}

      {logs.length > COLLAPSED && (
        <TouchableOpacity onPress={() => setExpanded(e => !e)} className="mt-space-sm items-center">
          <Text className="font-label-caps text-label-caps text-primary uppercase">
            {expanded ? 'Ver menos' : `Ver los ${logs.length}`}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

export function EmailLogPanel() {
  return (
    <LogPanel
      title="Registro de envíos"
      events={emailEvents}
      infoIcon="schedule-send"
      emptyText="Aún no hay intentos. Envía un correo de prueba o simula una intrusión."
    />
  );
}

export function DeviceLogPanel() {
  return (
    <LogPanel
      title="Registro de conexión"
      events={deviceEvents}
      infoIcon="router"
      emptyText="Aún no hay eventos. Se registran al conectar, perder o recuperar la conexión con el ESP32."
    />
  );
}
