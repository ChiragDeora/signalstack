import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert, Linking } from 'react-native';
import { Bell, Send, Check, X, LogOut } from 'lucide-react-native';
import { useAuth } from '@clerk/clerk-expo';
import { useTheme } from '@/lib/theme';
import { api } from '@/lib/api';
import { registerForPushAndSync, unregisterPush } from '@/lib/push';

export function ToolsScreen() {
  const t = useTheme();
  const { signOut } = useAuth();
  const [pushToken, setPushToken] = useState<string | null>(null);
  const [tgChatId, setTgChatId] = useState('');
  const [tgConfigured, setTgConfigured] = useState(false);
  const [tgConnectUrl, setTgConnectUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadTelegram = () => {
    api.get<{ success: boolean; configured?: boolean; chatId?: string; connectUrl?: string | null }>('/api/user/telegram')
      .then((r) => {
        if (r.data.success) {
          setTgConfigured(!!r.data.configured);
          setTgChatId(r.data.chatId || '');
          setTgConnectUrl(r.data.connectUrl || null);
        }
      })
      .catch(() => { /* noop */ });
  };

  useEffect(() => { loadTelegram(); }, []);

  // While not yet connected, poll so the screen updates once /start is sent in Telegram.
  useEffect(() => {
    if (tgChatId || !tgConnectUrl) return;
    const interval = setInterval(loadTelegram, 4000);
    return () => clearInterval(interval);
  }, [tgChatId, tgConnectUrl]);

  const enablePush = async () => {
    setBusy(true);
    const t = await registerForPushAndSync();
    setBusy(false);
    if (!t) Alert.alert('Push', 'Could not register. Notifications permission required and a real device.');
    else { setPushToken(t); Alert.alert('Push', 'Enabled on this device.'); }
  };
  const disablePushNow = async () => {
    if (!pushToken) return;
    await unregisterPush(pushToken);
    setPushToken(null);
  };
  const saveTg = async () => {
    setBusy(true);
    try {
      const r = await api.put<{ success: boolean; error?: string }>('/api/user/telegram', { chatId: tgChatId.trim() });
      Alert.alert('Telegram', r.data.success ? 'Saved.' : r.data.error || 'Failed');
    } catch (e: any) { Alert.alert('Telegram', e?.response?.data?.error || 'Failed'); }
    setBusy(false);
  };
  const testTg = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ success: boolean; error?: string }>('/api/user/telegram');
      Alert.alert('Telegram', r.data.success ? 'Sent — check Telegram.' : r.data.error || 'Failed');
    } catch (e: any) { Alert.alert('Telegram', e?.response?.data?.error || 'Failed'); }
    setBusy(false);
  };
  const disconnectTg = async () => {
    setBusy(true);
    try {
      const r = await api.put<{ success: boolean; error?: string }>('/api/user/telegram', { chatId: '' });
      if (r.data.success) setTgChatId('');
      else Alert.alert('Telegram', r.data.error || 'Failed');
    } catch (e: any) { Alert.alert('Telegram', e?.response?.data?.error || 'Failed'); }
    setBusy(false);
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
      <Text style={{ color: t.ink, fontSize: 18, fontWeight: '800', marginBottom: 4 }}>Tools</Text>

      <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }]}>
        <View style={styles.row}><Bell size={16} color={t.ink} /><Text style={[styles.title, { color: t.ink }]}>Push notifications</Text></View>
        <Text style={{ color: t.muted, fontSize: 12, marginTop: 4 }}>Receive crossover and RSI alerts on this device.</Text>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
          <TouchableOpacity onPress={enablePush} disabled={busy} style={[styles.btn, { backgroundColor: t.accent }]}>
            <Text style={styles.btnTxt}>{pushToken ? 'Re-register' : 'Enable on this device'}</Text>
          </TouchableOpacity>
          {pushToken && (
            <TouchableOpacity onPress={disablePushNow} disabled={busy} style={[styles.btn, { backgroundColor: t.bear }]}>
              <Text style={styles.btnTxt}>Disable</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }]}>
        <View style={styles.row}><Send size={16} color={t.ink} /><Text style={[styles.title, { color: t.ink }]}>Telegram alerts</Text></View>
        {!tgConfigured && (
          <Text style={{ color: t.bear, fontSize: 11, marginTop: 6 }}>Server bot not configured.</Text>
        )}

        {tgChatId ? (
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, alignItems: 'center' }}>
            <Text style={{ color: t.bull, fontWeight: '700', fontSize: 13 }}>✅ Connected</Text>
            <TouchableOpacity onPress={testTg} disabled={busy || !tgConfigured} style={[styles.btn, { backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border, flexDirection: 'row', alignItems: 'center', gap: 6 }]}>
              <Send size={14} color={t.ink} /><Text style={[styles.btnTxt, { color: t.ink }]}>Test</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={disconnectTg} disabled={busy} style={[styles.btn, { backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border, flexDirection: 'row', alignItems: 'center', gap: 6 }]}>
              <X size={14} color={t.bear} /><Text style={[styles.btnTxt, { color: t.bear }]}>Disconnect</Text>
            </TouchableOpacity>
          </View>
        ) : tgConnectUrl ? (
          <>
            <TouchableOpacity onPress={() => Linking.openURL(tgConnectUrl)} style={[styles.btn, { backgroundColor: t.accent, flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, alignSelf: 'flex-start' }]}>
              <Send size={14} color="#fff" /><Text style={styles.btnTxt}>Connect Telegram</Text>
            </TouchableOpacity>
            <Text style={{ color: t.muted, fontSize: 11, marginTop: 10, lineHeight: 16 }}>
              Tap Connect Telegram, then press Start in the chat that opens — we link it to
              your account automatically, no chat id to find.
            </Text>
          </>
        ) : (
          <Text style={{ color: t.muted, fontSize: 11, marginTop: 10 }}>
            {tgConfigured ? 'Bot username unavailable right now — reopen this screen in a moment.' : 'Set TELEGRAM_BOT_TOKEN on the server to enable Telegram alerts.'}
          </Text>
        )}

        <View style={{ marginTop: 14, borderTopWidth: 1, borderTopColor: t.border, paddingTop: 10 }}>
          <Text style={{ color: t.muted, fontSize: 10.5, fontWeight: '700', marginBottom: 8 }}>ADVANCED: ENTER CHAT ID MANUALLY</Text>
          <TextInput
            inputMode="numeric"
            value={tgChatId}
            onChangeText={(v) => setTgChatId(v.replace(/[^\d-]/g, ''))}
            placeholder="Your Telegram chat id (e.g. 123456789)"
            placeholderTextColor={t.muted}
            style={[styles.input, { color: t.ink, backgroundColor: t.surface2, borderColor: t.border }]}
          />
          <TouchableOpacity onPress={saveTg} disabled={busy} style={[styles.btn, { backgroundColor: t.accent, flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, alignSelf: 'flex-start' }]}>
            <Check size={14} color="#fff" /><Text style={styles.btnTxt}>Save</Text>
          </TouchableOpacity>
        </View>
      </View>

      <TouchableOpacity onPress={() => signOut()} style={[styles.btn, { backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }]}>
        <LogOut size={16} color={t.bear} />
        <Text style={[styles.btnTxt, { color: t.bear }]}>Sign out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  card: { padding: 14, borderRadius: 14, borderWidth: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { fontSize: 14, fontWeight: '700' },
  input: { padding: 12, borderRadius: 10, borderWidth: 1, fontFamily: 'Menlo', fontSize: 13 },
  btn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10 },
  btnTxt: { color: '#fff', fontWeight: '700' },
});
