/**
 * Expo notifications — request permission, fetch the Expo push token, and
 * register it with the SignalStack backend so server-side alerts arrive on
 * this device.
 */
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { api } from './api';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function ensureAlertChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('alerts', {
    name: 'SignalStack alerts',
    importance: Notifications.AndroidImportance.HIGH,
    sound: 'default',
    vibrationPattern: [0, 200, 100, 200],
    lightColor: '#1f6dff',
  });
}

export async function registerForPushAndSync(): Promise<string | null> {
  if (!Device.isDevice) return null; // simulators can't receive push
  await ensureAlertChannel();
  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== 'granted') {
    const req = await Notifications.requestPermissionsAsync();
    status = req.status;
  }
  if (status !== 'granted') return null;
  const projectId = (Constants.expoConfig?.extra as Record<string, unknown> | undefined)?.eas as
    | { projectId?: string }
    | undefined;
  const tokenResponse = await Notifications.getExpoPushTokenAsync(
    projectId?.projectId ? { projectId: projectId.projectId } : undefined,
  );
  const token = tokenResponse.data;
  if (!token) return null;
  try {
    await api.post('/api/mobile/push-subscribe', { token, platform: Platform.OS });
  } catch (e) {
    console.warn('push register failed', e);
  }
  return token;
}

export async function unregisterPush(token: string): Promise<void> {
  try {
    await api.delete('/api/mobile/push-subscribe', { data: { token } });
  } catch (e) {
    console.warn('push unregister failed', e);
  }
}
