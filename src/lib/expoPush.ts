/**
 * Expo push notifications for the React Native (Android) app.
 * Stores tokens per Clerk user; sends via the public Expo Push API.
 * Docs: https://docs.expo.dev/push-notifications/sending-notifications/
 */

import { getSupabaseAdmin } from './supabaseServer';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  channelId?: string;
  priority?: 'default' | 'normal' | 'high';
  sound?: 'default' | null;
}

export async function saveExpoPushToken(token: string, userId: string, platform?: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase || !token || !userId) return;
  const { error } = await supabase
    .from('expo_push_tokens')
    .upsert(
      { token, user_id: userId, platform: platform || null, updated_at: new Date().toISOString() },
      { onConflict: 'token' },
    );
  if (error) console.warn('[expoPush] saveExpoPushToken failed:', error.message);
}

export async function removeExpoPushToken(token: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase || !token) return;
  const { error } = await supabase.from('expo_push_tokens').delete().eq('token', token);
  if (error) console.warn('[expoPush] removeExpoPushToken failed:', error.message);
}

export async function getExpoPushTokensForUser(userId: string): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  if (!supabase || !userId) return [];
  const { data, error } = await supabase
    .from('expo_push_tokens')
    .select('token')
    .eq('user_id', userId);
  if (error) {
    console.warn('[expoPush] getExpoPushTokensForUser failed:', error.message);
    return [];
  }
  return (data || []).map((r: { token: string }) => r.token).filter(Boolean);
}

/**
 * Send Expo push messages in a single batch request.
 * Returns the set of tokens that should be invalidated (DeviceNotRegistered etc.).
 */
export async function sendExpoPush(messages: ExpoPushMessage[]): Promise<{ invalidTokens: string[] }> {
  if (messages.length === 0) return { invalidTokens: [] };
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'accept-encoding': 'gzip, deflate',
        'content-type': 'application/json',
      },
      body: JSON.stringify(messages),
    });
    const json = (await res.json().catch(() => ({}))) as { data?: Array<{ status?: string; details?: { error?: string } }> };
    const invalid: string[] = [];
    const items = json.data || [];
    items.forEach((item, idx) => {
      if (item?.status === 'error') {
        const err = item.details?.error;
        if (err === 'DeviceNotRegistered' || err === 'InvalidCredentials') {
          const tok = messages[idx]?.to;
          if (tok) invalid.push(tok);
        }
      }
    });
    return { invalidTokens: invalid };
  } catch (e: any) {
    console.warn('[expoPush] sendExpoPush error:', e?.message || e);
    return { invalidTokens: [] };
  }
}

export async function pushCrossoverToUser(
  userId: string,
  alert: {
    symbol: string;
    timeframe: string;
    crossoverType: 'bullish' | 'bearish';
    fastPeriod: number;
    slowPeriod: number;
    price: number;
    id: string;
  },
): Promise<void> {
  const tokens = await getExpoPushTokensForUser(userId);
  if (tokens.length === 0) return;
  const emoji = alert.crossoverType === 'bullish' ? '📈' : '📉';
  const dir = alert.crossoverType === 'bullish' ? 'Bullish' : 'Bearish';
  const messages: ExpoPushMessage[] = tokens.map((to) => ({
    to,
    title: `${emoji} ${dir} Crossover: ${alert.symbol}`,
    body: `EMA(${alert.fastPeriod}) crossed ${alert.crossoverType === 'bullish' ? 'above' : 'below'} EMA(${alert.slowPeriod}) at ₹${alert.price}`,
    data: { kind: 'crossover', symbol: alert.symbol, id: alert.id },
    channelId: 'alerts',
    priority: 'high',
    sound: 'default',
  }));
  const { invalidTokens } = await sendExpoPush(messages);
  for (const t of invalidTokens) await removeExpoPushToken(t);
}

export async function pushRsiToUser(
  userId: string,
  alert: {
    symbol: string;
    timeframe: string;
    signalType: 'overboughtCross' | 'oversoldCross' | 'thresholdBreach' | 'centerlineCross' | 'signalLineCross';
    direction: 'bullish' | 'bearish';
    rsiValue: number;
    period: number;
    price: number;
    id: string;
  },
): Promise<void> {
  const tokens = await getExpoPushTokensForUser(userId);
  if (tokens.length === 0) return;
  const emoji = alert.direction === 'bullish' ? '📈' : '📉';
  const labelMap: Record<string, string> = {
    overboughtCross: 'Overbought cross',
    oversoldCross: 'Oversold cross',
    thresholdBreach: 'Threshold breach',
    centerlineCross: 'Centerline (50) cross',
    signalLineCross: 'Signal line cross',
  };
  const label = labelMap[alert.signalType] ?? alert.signalType;
  const messages: ExpoPushMessage[] = tokens.map((to) => ({
    to,
    title: `${emoji} RSI ${label}: ${alert.symbol}`,
    body: `RSI(${alert.period}) = ${alert.rsiValue} (${alert.direction}) at ₹${alert.price}`,
    data: { kind: 'rsi', symbol: alert.symbol, id: alert.id },
    channelId: 'alerts',
    priority: 'high',
    sound: 'default',
  }));
  const { invalidTokens } = await sendExpoPush(messages);
  for (const t of invalidTokens) await removeExpoPushToken(t);
}
