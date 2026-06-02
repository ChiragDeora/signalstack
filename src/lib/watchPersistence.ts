/**
 * Server-side persistence for watch configs in Supabase.
 * Survives process restarts so monitoring can auto-restore without the UI.
 */

import { WatchConfig, RsiConfig } from './types';
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
  rsi_config: RsiConfig | null;
}

function parseRsi(raw: unknown): RsiConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Partial<RsiConfig> & { signals?: Partial<RsiConfig['signals']> };
  if (!r.enabled) return undefined;
  if (typeof r.period !== 'number' || typeof r.overbought !== 'number' || typeof r.oversold !== 'number') {
    return undefined;
  }
  const s: Partial<RsiConfig['signals']> = r.signals ?? {};
  return {
    enabled: true,
    period: r.period,
    overbought: r.overbought,
    oversold: r.oversold,
    signals: {
      overboughtCross: !!s.overboughtCross,
      oversoldCross: !!s.oversoldCross,
      thresholdBreach: !!s.thresholdBreach,
      centerlineCross: !!s.centerlineCross,
    },
  };
}

function rowToConfig(row: WatchRow): WatchConfig {
  const cfg: WatchConfig = {
    userId: row.user_id,
    symbol: row.symbol,
    timeframe: row.timeframe,
    emaPeriods: Array.isArray(row.ema_periods) ? row.ema_periods : [],
    trackBullish: row.track_bullish !== false,
    trackBearish: row.track_bearish !== false,
    exchange: row.exchange || 'NSE',
    currency: row.currency || 'INR',
  };
  const rsi = parseRsi(row.rsi_config);
  if (rsi) cfg.rsi = rsi;
  return cfg;
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
    rsi_config: config.rsi?.enabled ? config.rsi : null,
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
