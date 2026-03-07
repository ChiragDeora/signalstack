/**
 * Server-side persistence for push notification subscriptions in Supabase.
 * Survives process restarts so push alerts work after deploy without re-enabling.
 */

import { PushSubscriptionData } from './types';
import { getSupabaseAdmin } from './supabaseServer';

interface SubRow {
  endpoint: string;
  keys_p256dh: string;
  keys_auth: string;
  user_id?: string | null;
}

function rowToSub(row: SubRow): PushSubscriptionData {
  return {
    endpoint: row.endpoint,
    keys: {
      p256dh: row.keys_p256dh,
      auth: row.keys_auth,
    },
  };
}

export async function getAllPushSubscriptions(): Promise<PushSubscriptionData[]> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return [];
  const { data, error } = await supabase.from('push_subscriptions').select('endpoint, keys_p256dh, keys_auth');
  if (error) {
    console.warn('pushSubscriptionPersistence: read failed', error.message);
    return [];
  }
  return (data || []).map((row: SubRow) => rowToSub(row));
}

export async function savePushSubscription(sub: PushSubscriptionData, userId?: string | null): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  const row = {
    endpoint: sub.endpoint,
    keys_p256dh: sub.keys.p256dh,
    keys_auth: sub.keys.auth,
    user_id: userId ?? null,
  };
  const { error } = await supabase.from('push_subscriptions').upsert(row, { onConflict: 'endpoint' });
  if (error) console.warn('pushSubscriptionPersistence: save failed', error.message);
}

export async function removePushSubscription(endpoint: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  const { error } = await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
  if (error) console.warn('pushSubscriptionPersistence: remove failed', error.message);
}
