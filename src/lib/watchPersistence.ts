/**
 * Server-side persistence for watch configs in Supabase.
 * Survives process restarts so monitoring can auto-restore without the UI.
 */

import { WatchConfig } from './types';
import { getSupabaseAdmin } from './supabaseServer';

interface WatchRow {
  id: string;
  user_id: string;
  symbol: string;
  timeframe: string;
  ema_periods: number[];
  track_bullish: boolean;
  track_bearish: boolean;
  exchange: string;
  currency: string;
}

function rowToConfig(row: WatchRow): WatchConfig {
  return {
    userId: row.user_id,
    symbol: row.symbol,
    timeframe: row.timeframe,
    emaPeriods: Array.isArray(row.ema_periods) ? row.ema_periods : [],
    trackBullish: row.track_bullish !== false,
    trackBearish: row.track_bearish !== false,
    exchange: row.exchange || 'NSE',
    currency: row.currency || 'INR',
  };
}

export async function getAllWatches(): Promise<WatchConfig[]> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return [];
  const { data, error } = await supabase.from('watches').select('*');
  if (error) {
    console.warn('watchPersistence: getAllWatches failed', error.message);
    return [];
  }
  return (data || []).map((row: WatchRow) => rowToConfig(row));
}

export async function getWatchesByUser(userId: string): Promise<WatchConfig[]> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('watches')
    .select('*')
    .eq('user_id', userId);
  if (error) {
    console.warn('watchPersistence: getWatchesByUser failed', error.message);
    return [];
  }
  return (data || []).map((row: WatchRow) => rowToConfig(row));
}

export async function saveWatch(config: WatchConfig): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  const userId = config.userId ?? '';
  const row = {
    user_id: userId,
    symbol: (config.symbol || '').toUpperCase(),
    timeframe: config.timeframe || '',
    ema_periods: config.emaPeriods || [],
    track_bullish: config.trackBullish !== false,
    track_bearish: config.trackBearish !== false,
    exchange: config.exchange || 'NSE',
    currency: config.currency || 'INR',
  };
  const { error } = await supabase.from('watches').upsert(row, {
    onConflict: 'user_id,symbol,timeframe',
  });
  if (error) {
    console.error('[watchPersistence] saveWatch failed:', error.message, error.details);
  }
}

export async function removeWatch(userId: string, symbol: string, timeframe?: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  const upper = (symbol || '').toUpperCase();
  let q = supabase.from('watches').delete().eq('user_id', userId).eq('symbol', upper);
  if (timeframe != null) q = q.eq('timeframe', timeframe);
  const { error } = await q;
  if (error) console.warn('watchPersistence: removeWatch failed', error.message);
}
