/**
 * Panel "Registro de envíos": muestra cada intento de correo en vivo
 * (enviando, enviado, error con pista, reintentos programados).
 */
import React, { useState, useSyncExternalStore } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import {
  clearEmailLogs, getEmailLogs, subscribeEmailLogs, type EmailLogLevel,
} from '@/services/emailLog';

const LEVEL_STYLE: Record<EmailLogLevel, { icon: keyof typeof MaterialIcons.glyphMap; color: string }> = {
  info: { icon: 'schedule-send', color: '#4cd7f6' },
  success: { icon: 'check-circle', color: '#4edea3' },
  warn: { icon: 'warning', color: '#ffd479' },
  error: { icon: 'error', color: '#ffb4ab' },
};

const COLLAPSED = 8;

export function EmailLogPanel() {
  const logs = useSyncExternalStore(subscribeEmailLogs, getEmailLogs);
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? logs : logs.slice(0, COLLAPSED);

  return (
    <View className="bg-surface-container-low rounded-xl p-space-md shadow-sm">
      <View className="flex-row items-center justify-between mb-space-sm">
        <Text className="font-label-caps text-label-caps text-outline uppercase tracking-wider">
          Registro de envíos ({logs.length})
        </Text>
        {logs.length > 0 && (
          <TouchableOpacity onPress={clearEmailLogs} className="flex-row items-center gap-1">
            <MaterialIcons name="delete-outline" size={14} color="#869397" />
            <Text className="font-label-caps text-label-caps text-outline uppercase">Limpiar</Text>
          </TouchableOpacity>
        )}
      </View>

      {logs.length === 0 ? (
        <Text className="font-body-sm text-body-sm text-on-surface-variant">
          Aún no hay intentos. Envía un correo de prueba o simula una intrusión.
        </Text>
      ) : (
        visible.map(entry => {
          const st = LEVEL_STYLE[entry.level];
          const time = new Date(entry.at).toLocaleTimeString('es-CO', {
            hour: '2-digit', minute: '2-digit', second: '2-digit',
          });
          return (
            <View key={entry.id} className="flex-row gap-space-xs py-1.5 border-b border-surface-container-highest">
              <MaterialIcons name={st.icon} size={14} color={st.color} style={{ marginTop: 2 }} />
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
