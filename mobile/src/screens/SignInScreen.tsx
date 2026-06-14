import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import { useSignIn, useSSO } from '@clerk/clerk-expo';
import { useTheme } from '@/lib/theme';

// Warm up the browser on Android so the OAuth sheet opens faster.
function useWarmUpBrowser() {
  useEffect(() => {
    if (Platform.OS === 'web') return;
    void WebBrowser.warmUpAsync();
    return () => {
      void WebBrowser.coolDownAsync();
    };
  }, []);
}

export function SignInScreen() {
  useWarmUpBrowser();
  const t = useTheme();
  const { signIn, setActive, isLoaded } = useSignIn();
  const { startSSOFlow } = useSSO();
  const [emailAddress, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);

  const onSignIn = async () => {
    if (!isLoaded) return;
    setBusy(true);
    try {
      const attempt = await signIn.create({ identifier: emailAddress, password });
      if (attempt.status === 'complete') {
        await setActive({ session: attempt.createdSessionId });
      } else {
        Alert.alert('Sign in', 'Additional verification required. Continue in the web app first.');
      }
    } catch (e: any) {
      Alert.alert('Sign in failed', e?.errors?.[0]?.message || e?.message || 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  const onGoogleSignIn = async () => {
    setGoogleBusy(true);
    try {
      const { createdSessionId, setActive: setActiveSession } = await startSSOFlow({
        strategy: 'oauth_google',
        redirectUrl: AuthSession.makeRedirectUri({ scheme: 'signalstack', path: '/sso-callback' }),
      });
      if (createdSessionId && setActiveSession) {
        await setActiveSession({ session: createdSessionId });
      }
    } catch (e: any) {
      Alert.alert('Google sign-in failed', e?.errors?.[0]?.message || e?.message || 'Unknown error');
    } finally {
      setGoogleBusy(false);
    }
  };

  return (
    <View style={[styles.wrap, { backgroundColor: t.bg }]}>
      <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }]}>
        <Text style={[styles.title, { color: t.ink }]}>SignalStack</Text>
        <Text style={[styles.sub, { color: t.muted }]}>Sign in to your account</Text>

        <TextInput
          autoCapitalize="none"
          keyboardType="email-address"
          placeholder="Email"
          placeholderTextColor={t.muted}
          value={emailAddress}
          onChangeText={setEmail}
          style={[styles.input, { backgroundColor: t.surface2, color: t.ink, borderColor: t.border }]}
        />
        <TextInput
          secureTextEntry
          placeholder="Password"
          placeholderTextColor={t.muted}
          value={password}
          onChangeText={setPassword}
          style={[styles.input, { backgroundColor: t.surface2, color: t.ink, borderColor: t.border }]}
        />
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={onSignIn}
          disabled={busy}
          style={[styles.btn, { backgroundColor: t.accent, opacity: busy ? 0.6 : 1 }]}
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnTxt}>Sign in</Text>}
        </TouchableOpacity>

        <View style={styles.dividerRow}>
          <View style={[styles.dividerLine, { backgroundColor: t.border }]} />
          <Text style={[styles.dividerTxt, { color: t.muted }]}>or</Text>
          <View style={[styles.dividerLine, { backgroundColor: t.border }]} />
        </View>

        <TouchableOpacity
          activeOpacity={0.85}
          onPress={onGoogleSignIn}
          disabled={googleBusy}
          style={[styles.googleBtn, { backgroundColor: t.surface2, borderColor: t.border, opacity: googleBusy ? 0.6 : 1 }]}
        >
          {googleBusy ? (
            <ActivityIndicator color={t.ink} />
          ) : (
            <Text style={[styles.googleBtnTxt, { color: t.ink }]}>Continue with Google</Text>
          )}
        </TouchableOpacity>

        <Text style={[styles.hint, { color: t.muted }]}>
          Sign-up and password reset are handled in the web app at signalstack.app.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: 'center', padding: 24 },
  card: { padding: 22, borderRadius: 18, borderWidth: 1, gap: 12 },
  title: { fontSize: 28, fontWeight: '800' },
  sub: { fontSize: 13, marginBottom: 8 },
  input: { padding: 12, borderRadius: 10, borderWidth: 1, fontSize: 14 },
  btn: { padding: 14, borderRadius: 12, alignItems: 'center', marginTop: 8 },
  btnTxt: { color: '#fff', fontWeight: '700', fontSize: 15 },
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 },
  dividerLine: { flex: 1, height: 1 },
  dividerTxt: { fontSize: 12 },
  googleBtn: { padding: 14, borderRadius: 12, alignItems: 'center', borderWidth: 1 },
  googleBtnTxt: { fontWeight: '700', fontSize: 15 },
  hint: { fontSize: 11.5, lineHeight: 17, textAlign: 'center', marginTop: 8 },
});
