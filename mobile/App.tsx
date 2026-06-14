/**
 * SignalStack mobile (Expo + React Native).
 * Talks to the existing Next.js backend — no engine duplication.
 * Auth: Clerk Expo. Push: Expo Notifications. Telegram: per-user chat id stored server-side.
 */
import React, { useEffect } from 'react';
import { View, Text } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { ClerkProvider, useAuth, SignedIn, SignedOut } from '@clerk/clerk-expo';
import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import { tokenCache } from '@/lib/tokenCache';
import { setAuthToken } from '@/lib/api';
import { ensureAlertChannel } from '@/lib/push';
import { HomeScreen } from '@/screens/HomeScreen';
import { SignInScreen } from '@/screens/SignInScreen';
import { useTheme } from '@/lib/theme';

// Required so the OAuth (Google) browser session can close and return to the app.
WebBrowser.maybeCompleteAuthSession();

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string | undefined>;
const CLERK_PUBLISHABLE_KEY = extra.clerkPublishableKey || '';

function AuthGate() {
  const { getToken, isSignedIn } = useAuth();
  const t = useTheme();
  useEffect(() => {
    let alive = true;
    (async () => {
      if (isSignedIn) {
        const tok = await getToken();
        if (alive) setAuthToken(tok || null);
      } else {
        setAuthToken(null);
      }
    })();
    return () => { alive = false; };
  }, [getToken, isSignedIn]);
  useEffect(() => { ensureAlertChannel().catch(() => {}); }, []);
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={['top', 'left', 'right']}>
      <SignedIn>
        <HomeScreen />
      </SignedIn>
      <SignedOut>
        <SignInScreen />
      </SignedOut>
    </SafeAreaView>
  );
}

export default function App() {
  if (!CLERK_PUBLISHABLE_KEY || CLERK_PUBLISHABLE_KEY.startsWith('REPLACE_')) {
    // Render a fail-fast view so devs notice before debugging deep issues.
    return (
      <SafeAreaProvider>
        <SafeAreaView style={{ flex: 1, padding: 32, justifyContent: 'center', backgroundColor: '#070a13' }}>
          <StatusBar style="auto" />
          <Text style={{ color: '#e6ecf6', fontSize: 18, fontWeight: '800', marginBottom: 8 }}>
            SignalStack
          </Text>
          <Text style={{ color: '#9aa6bb', lineHeight: 20 }}>
            Set <Text style={{ fontWeight: '700' }}>expo.extra.clerkPublishableKey</Text> in{' '}
            <Text style={{ fontFamily: 'Menlo' }}>app.json</Text> to your Clerk publishable key,
            then restart Expo.
          </Text>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }
  return (
    <SafeAreaProvider>
      <ClerkProvider tokenCache={tokenCache} publishableKey={CLERK_PUBLISHABLE_KEY}>
        <StatusBar style="auto" />
        <AuthGate />
      </ClerkProvider>
    </SafeAreaProvider>
  );
}
