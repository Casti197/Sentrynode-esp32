/**
 * SchedulesScreen
 *
 * Module 3 — Automated Surveillance Scheduling
 *
 * Allows the user to:
 *   - View and toggle scheduled arming windows
 *   - Add new schedules (start/end time, days of week, security mode)
 *   - Edit / delete existing schedules
 *   - Configure ESP32 connection parameters
 *   - Configure the Gmail alert recipient (Gmail API)
 */

import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView,
  Modal, TextInput, Switch, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons, MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import type { SecurityStore, Schedule, SecurityMode } from '@/store/useSecurityStore';
import { sendTestEmail } from '@/services/emailService';
import { fetchSnapshot, getStatus } from '@/services/esp32Api';
import { isValidTime } from '@/services/schedule';
import { EmailLogPanel } from '@/screens/EmailLogPanel';
import { isGoogleSignInAvailable, signInWithGoogle, signOutGoogle } from '@/services/googleAuth';
import { fixedGmailSender, hasFixedGmailAccount } from '@/services/gmailFixedAuth';
import { emailLog } from '@/services/emailLog';

interface Props {
  store: SecurityStore;
}

const DAY_LABELS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

// ─── Blank schedule template ──────────────────────────────────────────────────

function blankSchedule(): Omit<Schedule, 'id'> {
  return {
    label: '',
    startTime: '08:00',
    endTime: '18:00',
    days: [1, 2, 3, 4, 5],
    enabled: true,
    mode: 'away',
  };
}

// ─── Time input helper (HH:MM string) ────────────────────────────────────────

function formatTime(raw: string): string {
  const cleaned = raw.replace(/\D/g, '').slice(0, 4);
  if (cleaned.length <= 2) return cleaned;
  return `${cleaned.slice(0, 2)}:${cleaned.slice(2)}`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function SchedulesScreen({ store }: Props) {
  const {
    schedules, addSchedule, updateSchedule, deleteSchedule,
    emailConfig, updateEmailConfig,
    esp32Config, updateEsp32Config,
    mode, setMode, modeSource, activeScheduleLabel,
  } = store;
  const [esp32Test, setEsp32Test] = useState<string | null>(null);

  const [modalVisible, setModalVisible] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);
  const [draft, setDraft] = useState<Omit<Schedule, 'id'>>(blankSchedule());
  const [activeTab, setActiveTab] = useState<'schedules' | 'email' | 'esp32'>('schedules');
  const [testEmailStatus, setTestEmailStatus] = useState<'idle' | 'sending' | 'ok' | 'fail'>('idle');

  // ── Modal helpers ──────────────────────────────────────────────────────────

  const openNewSchedule = () => {
    setEditingSchedule(null);
    setDraft(blankSchedule());
    setModalVisible(true);
  };

  const openEditSchedule = (s: Schedule) => {
    setEditingSchedule(s);
    setDraft({ label: s.label, startTime: s.startTime, endTime: s.endTime, days: [...s.days], enabled: s.enabled, mode: s.mode });
    setModalVisible(true);
  };

  const saveSchedule = async () => {
    if (!draft.label.trim()) {
      Alert.alert('Campo requerido', 'Ingresa un nombre para el horario.');
      return;
    }
    if (!isValidTime(draft.startTime) || !isValidTime(draft.endTime)) {
      Alert.alert('Hora inválida', 'Usa el formato HH:MM de 24 horas (ej. 07:30, 22:00).');
      return;
    }
    if (draft.startTime === draft.endTime) {
      Alert.alert('Franja vacía', 'La hora de inicio y la de fin no pueden ser iguales.');
      return;
    }
    if (draft.days.length === 0) {
      Alert.alert('Campo requerido', 'Selecciona al menos un día.');
      return;
    }
    if (editingSchedule) {
      await updateSchedule(editingSchedule.id, draft);
    } else {
      await addSchedule(draft);
    }
    setModalVisible(false);
  };

  const confirmDelete = (id: string, label: string) => {
    Alert.alert('Eliminar horario', `¿Eliminar "${label}"?`, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Eliminar', style: 'destructive', onPress: () => deleteSchedule(id) },
    ]);
  };

  const toggleDay = (day: number) => {
    setDraft(prev => ({
      ...prev,
      days: prev.days.includes(day) ? prev.days.filter(d => d !== day) : [...prev.days, day].sort(),
    }));
  };

  // ── Test email ─────────────────────────────────────────────────────────────

  const handleTestEmail = async () => {
    setTestEmailStatus('sending');
    let photo: string | null = null;
    try { photo = await fetchSnapshot(esp32Config); } catch { /* prueba sin foto */ }
    const result = await sendTestEmail(emailConfig, photo);
    setTestEmailStatus(result.ok ? 'ok' : 'fail');
    if (!result.ok) Alert.alert('No se envió', result.error);
    else if (!photo) Alert.alert('Enviado sin foto', 'El correo salió, pero la cámara no respondió para adjuntar la foto.');
    setTimeout(() => setTestEmailStatus('idle'), 3000);
  };

  // ── Gmail API: iniciar / cerrar sesión con Google ──────────────────────────

  const [googleBusy, setGoogleBusy] = useState(false);
  const googleAvailable = isGoogleSignInAvailable();

  const handleGoogleSignIn = async () => {
    setGoogleBusy(true);
    try {
      const email = await signInWithGoogle();
      if (email) {
        await updateEmailConfig({ gmailAccount: email });
        emailLog('success', `Sesión de Google iniciada: ${email}`, 'Permiso gmail.send concedido');
      }
    } catch (e: any) {
      emailLog('error', 'No se pudo iniciar sesión con Google', e?.message ?? String(e));
      Alert.alert('Google', e?.message ?? String(e));
    } finally {
      setGoogleBusy(false);
    }
  };

  const handleGoogleSignOut = async () => {
    await signOutGoogle();
    await updateEmailConfig({ gmailAccount: '' });
    emailLog('info', 'Sesión de Google cerrada');
  };

  // ── Test ESP32 ─────────────────────────────────────────────────────────────

  const handleTestEsp32 = async () => {
    setEsp32Test('Probando…');
    try {
      const st = await getStatus(esp32Config);
      setEsp32Test(`✓ Conectado · ${st.net === 'sta' ? 'hotspot' : 'AP'} · RSSI ${st.rssi} dBm · modo ${st.mode} · ${st.fps.toFixed(1)} fps`);
    } catch (e: any) {
      setEsp32Test(`✗ ${e?.message ?? 'Error'}`);
    }
  };

  // ── Schedule card ──────────────────────────────────────────────────────────

  const renderScheduleCard = (schedule: Schedule) => {
    const activeDayLabels = schedule.days.map(d => DAY_LABELS[d]).join(', ');
    const modeColor = schedule.mode === 'away' ? '#4edea3' : schedule.mode === 'home' ? '#4cd7f6' : '#869397';
    const modeLabel = schedule.mode === 'away' ? 'Fuera Casa' : schedule.mode === 'home' ? 'En Casa' : 'Desarmado';

    return (
      <View key={schedule.id} className="bg-surface-container-low rounded-xl p-space-md shadow-sm mb-space-sm">
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-space-sm flex-1">
            <View className="w-8 h-8 rounded-lg bg-surface-container-highest items-center justify-center">
              <MaterialIcons name="schedule" size={18} color="#4cd7f6" />
            </View>
            <View className="flex-1">
              <Text className="font-headline-sm text-headline-sm text-on-surface" numberOfLines={1}>
                {schedule.label}
              </Text>
              <Text className="font-telemetry-sm text-telemetry-sm text-on-surface-variant">
                {schedule.startTime} — {schedule.endTime}
              </Text>
            </View>
          </View>
          <Switch
            value={schedule.enabled}
            onValueChange={(v) => updateSchedule(schedule.id, { enabled: v })}
            trackColor={{ false: '#31353f', true: '#4edea3' }}
            thumbColor={schedule.enabled ? '#003824' : '#869397'}
          />
        </View>

        <View className="flex-row items-center justify-between mt-space-sm">
          <Text className="font-label-caps text-label-caps text-on-surface-variant uppercase">
            {activeDayLabels}
          </Text>
          <View className="flex-row items-center gap-space-xs" style={{ borderColor: modeColor, borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
            <MaterialCommunityIcons name="shield-check" size={11} color={modeColor} />
            <Text className="font-label-caps text-label-caps uppercase" style={{ color: modeColor }}>
              {modeLabel}
            </Text>
          </View>
        </View>

        <View className="flex-row gap-space-xs mt-space-sm">
          <TouchableOpacity
            onPress={() => openEditSchedule(schedule)}
            className="flex-1 bg-surface-container-highest rounded-lg py-2 items-center flex-row justify-center gap-space-xs"
          >
            <MaterialIcons name="edit" size={14} color="#4cd7f6" />
            <Text className="font-label-caps text-label-caps text-primary uppercase">Editar</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => confirmDelete(schedule.id, schedule.label)}
            className="flex-1 bg-error/10 rounded-lg py-2 items-center flex-row justify-center gap-space-xs"
          >
            <MaterialIcons name="delete-outline" size={14} color="#ffb4ab" />
            <Text className="font-label-caps text-label-caps text-error uppercase">Eliminar</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView className="flex-1 bg-surface">
      <StatusBar style="light" />

      {/* Header */}
      <View className="h-16 px-margin flex-row items-center justify-between bg-surface-container-lowest shadow-lg">
        <View className="flex-col">
          <Text className="font-headline-sm text-headline-sm text-on-surface tracking-tight leading-tight">
            Automatización
          </Text>
          <Text className="font-telemetry-sm text-telemetry-sm text-primary uppercase">
            Horarios & Configuración
          </Text>
        </View>
        <TouchableOpacity
          onPress={openNewSchedule}
          className="bg-primary/20 px-space-sm py-space-xs rounded-xl flex-row items-center gap-space-xs"
        >
          <MaterialIcons name="add" size={18} color="#4cd7f6" />
          <Text className="font-label-caps text-label-caps text-primary uppercase">Nuevo</Text>
        </TouchableOpacity>
      </View>

      {/* Tabs */}
      <View className="flex-row bg-surface-container-low mx-margin mt-space-sm rounded-xl p-1">
        {(['schedules', 'email', 'esp32'] as const).map((tab) => {
          const labels = { schedules: 'Horarios', email: 'Alertas Email', esp32: 'ESP32' };
          const isActive = activeTab === tab;
          return (
            <TouchableOpacity
              key={tab}
              onPress={() => setActiveTab(tab)}
              className={`flex-1 py-2 rounded-lg items-center ${isActive ? 'bg-surface-container-highest' : ''}`}
            >
              <Text className={`font-label-caps text-label-caps uppercase ${isActive ? 'text-primary' : 'text-on-surface-variant'}`}>
                {labels[tab]}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <ScrollView
        className="flex-1 bg-surface"
        contentContainerStyle={{ paddingBottom: 100, paddingTop: 16, paddingHorizontal: 16 }}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Schedules Tab ──────────────────────────────────────────────────── */}
        {activeTab === 'schedules' && (
          <View className="gap-space-xs">
            {/* Quick manual arm */}
            <View className="bg-surface-container-low rounded-xl p-space-md shadow-md mb-space-md">
              <Text className="font-label-caps text-label-caps text-outline uppercase tracking-wider mb-1">
                Activación Manual
              </Text>
              <Text className="font-body-sm text-body-sm text-on-surface-variant mb-space-sm">
                {modeSource === 'manual'
                  ? 'Manual activo: manda hasta que empiece o termine la próxima franja.'
                  : modeSource === 'schedule' ? `Mandando el horario "${activeScheduleLabel}".` : 'Ninguna franja activa ahora.'}
              </Text>
              <View className="flex-row bg-surface-container-lowest p-1 rounded-xl">
                {(['disarmed', 'home', 'away'] as const).map((m) => {
                  const isActive = mode === m;
                  const labels = { disarmed: 'Desarmado', home: 'En Casa', away: 'Fuera' };
                  const activeBg = { disarmed: 'bg-surface-container-high', home: 'bg-primary', away: 'bg-secondary' };
                  const activeColor = { disarmed: '#dfe2ef', home: '#003640', away: '#003824' };
                  return (
                    <TouchableOpacity
                      key={m}
                      onPress={() => setMode(m)}
                      className={`flex-1 flex-col items-center justify-center py-2.5 rounded-lg ${isActive ? activeBg[m] : ''}`}
                    >
                      <Text
                        className={`font-label-caps text-label-caps text-center uppercase ${isActive ? 'font-bold' : 'text-on-surface-variant'}`}
                        style={isActive ? { color: activeColor[m] } : undefined}
                      >
                        {labels[m]}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {/* Schedule list */}
            {schedules.length === 0 ? (
              <View className="items-center py-space-xl">
                <MaterialIcons name="schedule" size={40} color="#3d494c" />
                <Text className="font-headline-sm text-headline-sm text-outline mt-space-sm">
                  Sin horarios configurados
                </Text>
                <Text className="font-body-sm text-body-sm text-on-surface-variant mt-1 text-center">
                  {'Toca "+ Nuevo" para programar una franja horaria de vigilancia'}
                </Text>
              </View>
            ) : (
              schedules.map(renderScheduleCard)
            )}
          </View>
        )}

        {/* ── Email Config Tab ──────────────────────────────────────────────── */}
        {activeTab === 'email' && (
          <View className="gap-space-sm">
            <View className="bg-surface-container-low rounded-xl p-space-md shadow-sm">
              <Text className="font-label-caps text-label-caps text-outline uppercase tracking-wider mb-space-sm">
                Envío de alertas por correo
              </Text>

              <View className="mb-space-md">
                  <Text className="font-body-sm text-body-sm text-on-surface-variant mb-space-sm leading-relaxed">
                    La app envía el correo desde tu cuenta de Gmail (OAuth 2.0, solo permiso de enviar). No usa plantillas externas.
                  </Text>
                  {hasFixedGmailAccount() ? (
                    <View className="flex-row items-center gap-space-xs bg-surface-container-highest rounded-xl p-space-sm">
                      <MaterialIcons name="verified-user" size={18} color="#4edea3" />
                      <View className="flex-1">
                        <Text className="font-telemetry-sm text-telemetry-sm text-on-surface" numberOfLines={1}>
                          {fixedGmailSender()}
                        </Text>
                        <Text className="font-label-caps text-label-caps text-secondary uppercase">
                          Cuenta fija · sin inicio de sesión
                        </Text>
                      </View>
                    </View>
                  ) : (<>
                  {!googleAvailable && (
                    <Text className="font-body-sm text-body-sm text-error mb-space-sm">
                      Estás en Expo Go: el inicio de sesión con Google necesita un development build. Usa la cuenta fija (.env.local).
                    </Text>
                  )}
                  {emailConfig.gmailAccount ? (
                    <View className="flex-row items-center justify-between bg-surface-container-highest rounded-xl p-space-sm">
                      <View className="flex-row items-center gap-space-xs flex-1">
                        <MaterialIcons name="verified-user" size={18} color="#4edea3" />
                        <Text className="font-telemetry-sm text-telemetry-sm text-on-surface flex-1" numberOfLines={1}>
                          {emailConfig.gmailAccount}
                        </Text>
                      </View>
                      <TouchableOpacity onPress={handleGoogleSignOut} className="px-space-sm py-1">
                        <Text className="font-label-caps text-label-caps text-error uppercase">Cerrar sesión</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <TouchableOpacity
                      onPress={handleGoogleSignIn}
                      disabled={googleBusy || !googleAvailable}
                      className={`rounded-xl py-space-sm items-center flex-row justify-center gap-space-sm ${googleAvailable ? 'bg-primary/20' : 'bg-surface-container-highest'}`}
                    >
                      <MaterialCommunityIcons name="google" size={18} color={googleAvailable ? '#4cd7f6' : '#869397'} />
                      <Text className={`font-label-caps text-label-caps uppercase font-bold ${googleAvailable ? 'text-primary' : 'text-outline'}`}>
                        {googleBusy ? 'Abriendo Google…' : 'Iniciar sesión con Google'}
                      </Text>
                    </TouchableOpacity>
                  )}
                  </>)}
              </View>

              {[
                { key: 'recipientEmail', label: 'Email Destinatario', placeholder: 'propietario@email.com' },
                { key: 'senderName', label: 'Nombre Remitente', placeholder: 'SentryNode' },
              ].map(({ key, label, placeholder }) => (
                <View key={key} className="mb-space-sm">
                  <Text className="font-label-caps text-label-caps text-on-surface-variant uppercase mb-1">
                    {label}
                  </Text>
                  <TextInput
                    value={(emailConfig as any)[key]}
                    onChangeText={(v) => updateEmailConfig({ [key]: v } as any)}
                    placeholder={placeholder}
                    placeholderTextColor="#3d494c"
                    autoCapitalize="none"
                    autoCorrect={false}
                    className="bg-surface-container-highest rounded-lg px-space-sm py-space-sm text-on-surface font-telemetry-sm text-telemetry-sm"
                    style={{ color: '#dfe2ef', fontFamily: 'monospace' }}
                  />
                </View>
              ))}

              <TouchableOpacity
                onPress={handleTestEmail}
                disabled={testEmailStatus === 'sending'}
                className={`mt-space-sm rounded-xl py-space-sm items-center flex-row justify-center gap-space-sm ${
                  testEmailStatus === 'ok' ? 'bg-secondary/20' :
                  testEmailStatus === 'fail' ? 'bg-error/20' :
                  'bg-primary/20'
                }`}
              >
                <MaterialIcons
                  name={testEmailStatus === 'ok' ? 'check-circle' : testEmailStatus === 'fail' ? 'error' : 'send'}
                  size={16}
                  color={testEmailStatus === 'ok' ? '#4edea3' : testEmailStatus === 'fail' ? '#ffb4ab' : '#4cd7f6'}
                />
                <Text className={`font-label-caps text-label-caps uppercase font-bold ${
                  testEmailStatus === 'ok' ? 'text-secondary' :
                  testEmailStatus === 'fail' ? 'text-error' :
                  'text-primary'
                }`}>
                  {testEmailStatus === 'sending' ? 'Enviando...' :
                   testEmailStatus === 'ok' ? 'Email enviado ✓' :
                   testEmailStatus === 'fail' ? 'Error — verifica config' :
                   'Enviar email de prueba'}
                </Text>
              </TouchableOpacity>
            </View>

            <EmailLogPanel />
          </View>
        )}

        {/* ── ESP32 Config Tab ──────────────────────────────────────────────── */}
        {activeTab === 'esp32' && (
          <View className="gap-space-sm">
            <View className="bg-surface-container-low rounded-xl p-space-md shadow-sm">
              <Text className="font-label-caps text-label-caps text-outline uppercase tracking-wider mb-space-sm">
                Conexión con el ESP32-CAM
              </Text>
              <Text className="font-body-sm text-body-sm text-on-surface-variant mb-space-md leading-relaxed">
                El ESP32 se conecta al hotspot de este celular. Su IP aparece en el monitor serie
                (115200 baudios) al arrancar. Si no encuentra el hotspot, crea la red “SentryNode-XXXX” y queda en 192.168.4.1.
              </Text>

              {/* Modo demo: ESP32 simulado para practicar sin la placa */}
              <View className="flex-row items-center justify-between bg-surface-container-highest rounded-xl p-space-sm mb-space-md">
                <View className="flex-1 mr-space-sm">
                  <Text className="font-headline-sm text-headline-sm text-on-surface">Modo demo</Text>
                  <Text className="font-body-sm text-body-sm text-on-surface-variant">
                    Simula el ESP32 dentro de la app. El correo por Gmail sí se envía de verdad.
                  </Text>
                </View>
                <Switch
                  value={esp32Config.demo}
                  onValueChange={(v) => updateEsp32Config({ demo: v })}
                  trackColor={{ false: '#31353f', true: '#4cd7f6' }}
                  thumbColor={esp32Config.demo ? '#003640' : '#869397'}
                />
              </View>

              {!esp32Config.demo && [
                { key: 'ip', label: 'Dirección IP del ESP32', placeholder: '10.xx.xx.xx' },
                { key: 'controlPort', label: 'Puerto de control (API)', placeholder: '80' },
                { key: 'streamPort', label: 'Puerto de video (MJPEG)', placeholder: '81' },
              ].map(({ key, label, placeholder }) => {
                const numeric = key !== 'ip';
                return (
                  <View key={key} className="mb-space-sm">
                    <Text className="font-label-caps text-label-caps text-on-surface-variant uppercase mb-1">
                      {label}
                    </Text>
                    <TextInput
                      defaultValue={String((esp32Config as any)[key])}
                      onEndEditing={(e) => {
                        const v = e.nativeEvent.text.trim();
                        if (numeric) {
                          const n = parseInt(v, 10);
                          updateEsp32Config({ [key]: n > 0 && n < 65536 ? n : key === 'streamPort' ? 81 : 80 } as any);
                        } else if (/^[\w.-]+$/.test(v)) {
                          updateEsp32Config({ ip: v });
                        } else {
                          Alert.alert('IP inválida', 'Escribe solo la IP, ej. 10.42.0.57');
                        }
                      }}
                      placeholder={placeholder}
                      placeholderTextColor="#3d494c"
                      keyboardType={numeric ? 'numeric' : 'decimal-pad'}
                      autoCapitalize="none"
                      autoCorrect={false}
                      className="bg-surface-container-highest rounded-lg px-space-sm py-space-sm"
                      style={{ color: '#dfe2ef', fontFamily: 'monospace', fontSize: 13 }}
                    />
                  </View>
                );
              })}

              <TouchableOpacity
                onPress={handleTestEsp32}
                className="mt-space-xs bg-primary/20 rounded-xl py-space-sm items-center flex-row justify-center gap-space-sm"
              >
                <MaterialIcons name="wifi-tethering" size={16} color="#4cd7f6" />
                <Text className="font-label-caps text-label-caps uppercase font-bold text-primary">Probar conexión</Text>
              </TouchableOpacity>
              {esp32Test && (
                <Text className="font-telemetry-sm text-telemetry-sm text-on-surface-variant mt-space-sm">{esp32Test}</Text>
              )}

              <View className="bg-surface-container-highest rounded-xl p-space-sm mt-space-sm">
                <Text className="font-label-caps text-label-caps text-outline uppercase mb-space-xs">
                  Endpoints del ESP32
                </Text>
                {[
                  { label: 'Stream MJPEG (:81)', path: '/stream' },
                  { label: 'Foto del evento', path: '/motion.jpg' },
                  { label: 'Captura foto', path: '/capture' },
                  { label: 'Estado / telemetría', path: '/status' },
                  { label: 'Control Flash', path: '/flash?state=1' },
                  { label: 'Control Sirena', path: '/siren?state=1' },
                  { label: 'Cambiar modo', path: '/mode?value=away' },
                ].map(({ label, path }) => (
                  <View key={path} className="flex-row items-center justify-between mb-1">
                    <Text className="font-body-sm text-body-sm text-on-surface-variant">{label}</Text>
                    <Text className="font-telemetry-sm text-telemetry-sm text-primary">{path}</Text>
                  </View>
                ))}
              </View>
            </View>
          </View>
        )}
      </ScrollView>

      {/* ── Add/Edit Schedule Modal ────────────────────────────────────────── */}
      <Modal
        visible={modalVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setModalVisible(false)}
      >
        <View className="flex-1 bg-surface-container-lowest/80 justify-end">
          <View className="bg-surface-container-low rounded-t-2xl p-margin" style={{ maxHeight: '90%' }}>
            <View className="flex-row items-center justify-between mb-space-md">
              <Text className="font-headline-md text-headline-md text-on-surface">
                {editingSchedule ? 'Editar Horario' : 'Nuevo Horario'}
              </Text>
              <TouchableOpacity onPress={() => setModalVisible(false)}>
                <MaterialIcons name="close" size={24} color="#bcc9cd" />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false}>
              {/* Name */}
              <Text className="font-label-caps text-label-caps text-on-surface-variant uppercase mb-1">Nombre</Text>
              <TextInput
                value={draft.label}
                onChangeText={(v) => setDraft(p => ({ ...p, label: v }))}
                placeholder="Ej: Horario Nocturno"
                placeholderTextColor="#3d494c"
                className="bg-surface-container-highest rounded-lg px-space-sm py-space-sm mb-space-md"
                style={{ color: '#dfe2ef' }}
              />

              {/* Times */}
              <View className="flex-row gap-space-sm mb-space-md">
                <View className="flex-1">
                  <Text className="font-label-caps text-label-caps text-on-surface-variant uppercase mb-1">Inicio (HH:MM)</Text>
                  <TextInput
                    value={draft.startTime}
                    onChangeText={(v) => setDraft(p => ({ ...p, startTime: formatTime(v) }))}
                    placeholder="08:00"
                    placeholderTextColor="#3d494c"
                    keyboardType="numeric"
                    maxLength={5}
                    className="bg-surface-container-highest rounded-lg px-space-sm py-space-sm"
                    style={{ color: '#dfe2ef', fontFamily: 'monospace' }}
                  />
                </View>
                <View className="flex-1">
                  <Text className="font-label-caps text-label-caps text-on-surface-variant uppercase mb-1">Fin (HH:MM)</Text>
                  <TextInput
                    value={draft.endTime}
                    onChangeText={(v) => setDraft(p => ({ ...p, endTime: formatTime(v) }))}
                    placeholder="18:00"
                    placeholderTextColor="#3d494c"
                    keyboardType="numeric"
                    maxLength={5}
                    className="bg-surface-container-highest rounded-lg px-space-sm py-space-sm"
                    style={{ color: '#dfe2ef', fontFamily: 'monospace' }}
                  />
                </View>
              </View>

              {/* Days */}
              <Text className="font-label-caps text-label-caps text-on-surface-variant uppercase mb-space-sm">Días</Text>
              <View className="flex-row flex-wrap gap-space-xs mb-space-md">
                {DAY_LABELS.map((label, idx) => {
                  const active = draft.days.includes(idx);
                  return (
                    <TouchableOpacity
                      key={idx}
                      onPress={() => toggleDay(idx)}
                      className={`px-space-sm py-space-xs rounded-lg ${active ? 'bg-primary' : 'bg-surface-container-highest'}`}
                    >
                      <Text className={`font-label-caps text-label-caps uppercase ${active ? 'text-on-primary' : 'text-on-surface-variant'}`}>
                        {label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Mode */}
              <Text className="font-label-caps text-label-caps text-on-surface-variant uppercase mb-space-sm">Modo de Seguridad</Text>
              <View className="flex-row bg-surface-container-lowest p-1 rounded-xl mb-space-md">
                {(['disarmed', 'home', 'away'] as SecurityMode[]).map((m) => {
                  const labels = { disarmed: 'Desarmado', home: 'En Casa', away: 'Fuera' };
                  const isActive = draft.mode === m;
                  return (
                    <TouchableOpacity
                      key={m}
                      onPress={() => setDraft(p => ({ ...p, mode: m }))}
                      className={`flex-1 py-2.5 rounded-lg items-center ${isActive ? (m === 'away' ? 'bg-secondary' : m === 'home' ? 'bg-primary' : 'bg-surface-container-high') : ''}`}
                    >
                      <Text className={`font-label-caps text-label-caps uppercase ${isActive ? (m === 'away' ? 'text-on-secondary' : m === 'home' ? 'text-on-primary' : 'text-on-surface') : 'text-on-surface-variant'}`}>
                        {labels[m]}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Enabled toggle */}
              <View className="flex-row items-center justify-between mb-space-xl">
                <Text className="font-headline-sm text-headline-sm text-on-surface">Activar horario</Text>
                <Switch
                  value={draft.enabled}
                  onValueChange={(v) => setDraft(p => ({ ...p, enabled: v }))}
                  trackColor={{ false: '#31353f', true: '#4edea3' }}
                  thumbColor={draft.enabled ? '#003824' : '#869397'}
                />
              </View>

              {/* Save */}
              <TouchableOpacity
                onPress={saveSchedule}
                className="bg-primary rounded-xl py-space-md items-center mb-space-md"
              >
                <Text className="font-headline-sm text-headline-sm text-on-primary font-bold">
                  {editingSchedule ? 'Guardar cambios' : 'Crear horario'}
                </Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}
