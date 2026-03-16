// ============================================
// Alert Store - Per-user alert history backed by Supabase
// ============================================
// In-memory cache for fast reads; Supabase for persistence across restarts.
// When userId is provided, alerts are scoped per-user.

import { CrossoverAlert } from './types';
import { getSupabaseAdmin } from './supabaseServer';

// In-memory cache: userId -> alerts (use '__global__' for unscoped alerts)
const alertCache: Map<string, CrossoverAlert[]> = new Map();
const MAX_ALERTS_PER_USER = 200;

function cacheKey(userId?: string): string {
  return userId || '__global__';
}

/**
 * Add an alert (in-memory + persist to Supabase).
 * userId is optional for backward compatibility but should always be provided.
 */
export function addAlert(alert: CrossoverAlert, userId?: string): void {
  const key = cacheKey(userId);
  const existing = alertCache.get(key) || [];
  existing.unshift(alert);
  if (existing.length > MAX_ALERTS_PER_USER) {
    existing.length = MAX_ALERTS_PER_USER;
  }
  alertCache.set(key, existing);
  console.log(`💾 Alert stored: ${alert.crossoverType} ${alert.symbol} [${userId ?? 'global'}] (total: ${existing.length})`);

  // Persist to Supabase asynchronously (don't block)
  persistAlert(alert, userId).catch((e) =>
    console.warn('[alertStore] Supabase persist failed:', (e as Error).message)
  );
}

/**
 * Get alerts for a user (returns from in-memory cache; falls back to Supabase on first call).
 */
export function getAlerts(userId?: string): CrossoverAlert[] {
  const key = cacheKey(userId);
  return alertCache.get(key) || [];
}

/**
 * Load alerts from Supabase into the in-memory cache (call once on first page load).
 * Returns the loaded alerts.
 */
export async function loadAlerts(userId: string): Promise<CrossoverAlert[]> {
  const key = cacheKey(userId);
  // If already cached, return
  if (alertCache.has(key)) return alertCache.get(key)!;

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    alertCache.set(key, []);
    return [];
  }

  try {
    const { data, error } = await supabase
      .from('alerts')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(MAX_ALERTS_PER_USER);

    if (error) {
      console.warn('[alertStore] loadAlerts failed:', error.message);
      alertCache.set(key, []);
      return [];
    }

    const alerts: CrossoverAlert[] = (data || []).map((row: any) => ({
      id: row.id,
      symbol: row.symbol,
      timeframe: row.timeframe,
      fastPeriod: row.fast_period,
      slowPeriod: row.slow_period,
      fastEmaValue: row.fast_ema_value,
      slowEmaValue: row.slow_ema_value,
      crossoverType: row.crossover_type,
      price: row.price,
      currency: row.currency,
      timestamp: row.timestamp,
      source: row.source,
    }));

    alertCache.set(key, alerts);
    console.log(`💾 Loaded ${alerts.length} alert(s) from Supabase for user ${userId}`);
    return alerts;
  } catch (e) {
    console.warn('[alertStore] loadAlerts error:', (e as Error).message);
    alertCache.set(key, []);
    return [];
  }
}

/**
 * Clear all alerts for a user.
 */
export async function clearAlerts(userId?: string): Promise<void> {
  const key = cacheKey(userId);
  alertCache.set(key, []);

  if (userId) {
    const supabase = getSupabaseAdmin();
    if (supabase) {
      const { error } = await supabase.from('alerts').delete().eq('user_id', userId);
      if (error) console.warn('[alertStore] clearAlerts failed:', error.message);
    }
  }
}

// ── Internal: persist a single alert to Supabase ──

async function persistAlert(alert: CrossoverAlert, userId?: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase || !userId) return;

  const row = {
    id: alert.id,
    user_id: userId,
    symbol: alert.symbol,
    timeframe: alert.timeframe,
    fast_period: alert.fastPeriod,
    slow_period: alert.slowPeriod,
    fast_ema_value: alert.fastEmaValue,
    slow_ema_value: alert.slowEmaValue,
    crossover_type: alert.crossoverType,
    price: alert.price,
    currency: alert.currency,
    timestamp: alert.timestamp,
    source: alert.source,
  };

  const { error } = await supabase.from('alerts').upsert(row, { onConflict: 'id' });
  if (error) {
    console.warn('[alertStore] persistAlert failed:', error.message);
  }
}
