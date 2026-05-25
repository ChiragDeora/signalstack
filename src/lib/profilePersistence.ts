/**
 * Profiles, watchlist, and ema_settings — durable storage for the symbol list
 * and default EMAs (survives concurrent CRUD and debounced UI saves).
 */

import { getSupabaseAdmin } from './supabaseServer';

const DEFAULT_EMAS: [number, number, number, number] = [10, 20, 50, 200];

export interface EmaSettingsRow {
  ema_1: number;
  ema_2: number;
  ema_3: number;
  ema_4: number;
}

export interface SymbolMeta {
  symbol: string;
  name?: string;
  currency: string;
  exchange?: string;
}

export async function ensureProfile(
  userId: string,
  opts?: { name?: string | null; email?: string | null },
): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  const row = {
    user_id: userId,
    name: opts?.name ?? null,
    email: opts?.email ?? null,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('profiles').upsert(row, { onConflict: 'user_id' });
  if (error) console.warn('[profilePersistence] ensureProfile failed:', error.message);
}

export async function getWatchlistSymbols(userId: string): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('watchlist')
    .select('symbol')
    .eq('user_id', userId)
    .order('symbol');
  if (error) {
    console.warn('[profilePersistence] getWatchlistSymbols failed:', error.message);
    return [];
  }
  return (data || []).map((r: { symbol: string }) => (r.symbol || '').toUpperCase());
}

export async function addWatchlistSymbol(userId: string, symbol: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  const sym = (symbol || '').toUpperCase();
  if (!sym) return;
  await ensureProfile(userId);
  const { error } = await supabase.from('watchlist').upsert(
    { user_id: userId, symbol: sym },
    { onConflict: 'user_id,symbol', ignoreDuplicates: true },
  );
  if (error) console.warn('[profilePersistence] addWatchlistSymbol failed:', error.message);
}

export async function removeWatchlistSymbol(userId: string, symbol: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  const sym = (symbol || '').toUpperCase();
  const { error } = await supabase.from('watchlist').delete().eq('user_id', userId).eq('symbol', sym);
  if (error) console.warn('[profilePersistence] removeWatchlistSymbol failed:', error.message);
}

/** Replace watchlist rows to match the current symbol list (full sync). */
export async function syncWatchlist(userId: string, symbols: string[]): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  await ensureProfile(userId);
  const upper = [...new Set(symbols.map((s) => (s || '').toUpperCase()).filter(Boolean))];

  const { data: existing, error: listErr } = await supabase
    .from('watchlist')
    .select('symbol')
    .eq('user_id', userId);
  if (listErr) {
    console.warn('[profilePersistence] syncWatchlist list failed:', listErr.message);
    return;
  }
  const existingSet = new Set((existing || []).map((r: { symbol: string }) => (r.symbol || '').toUpperCase()));
  const targetSet = new Set(upper);

  const toRemove = [...existingSet].filter((s) => !targetSet.has(s));
  if (toRemove.length > 0) {
    const { error } = await supabase.from('watchlist').delete().eq('user_id', userId).in('symbol', toRemove);
    if (error) console.warn('[profilePersistence] syncWatchlist delete failed:', error.message);
  }

  if (upper.length > 0) {
    const rows = upper.map((symbol) => ({ user_id: userId, symbol }));
    const { error } = await supabase.from('watchlist').upsert(rows, {
      onConflict: 'user_id,symbol',
      ignoreDuplicates: true,
    });
    if (error) console.warn('[profilePersistence] syncWatchlist upsert failed:', error.message);
  }
}

export async function getEmaSettings(userId: string): Promise<EmaSettingsRow | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('ema_settings')
    .select('ema_1, ema_2, ema_3, ema_4')
    .eq('user_id', userId)
    .single();
  if (error && error.code !== 'PGRST116') {
    console.warn('[profilePersistence] getEmaSettings failed:', error.message);
    return null;
  }
  return data as EmaSettingsRow | null;
}

export async function saveEmaSettings(userId: string, periods: [number, number, number, number]): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  await ensureProfile(userId);
  const [ema_1, ema_2, ema_3, ema_4] = periods;
  const { error } = await supabase.from('ema_settings').upsert(
    {
      user_id: userId,
      ema_1,
      ema_2,
      ema_3,
      ema_4,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
  if (error) console.warn('[profilePersistence] saveEmaSettings failed:', error.message);
}

export function defaultEmaSettings(): EmaSettingsRow {
  const [ema_1, ema_2, ema_3, ema_4] = DEFAULT_EMAS;
  return { ema_1, ema_2, ema_3, ema_4 };
}

export function emaSettingsToPeriods(row: EmaSettingsRow): number[] {
  return [row.ema_1, row.ema_2, row.ema_3, row.ema_4];
}

export function extractEmaSettingsFromBySymbol(
  emasBySymbol: Record<string, Array<{ period: number }>>,
): [number, number, number, number] | null {
  for (const arr of Object.values(emasBySymbol)) {
    if (arr && arr.length >= 2) {
      const sorted = [...arr].sort((a, b) => a.period - b.period);
      const periods = sorted.map((e) => e.period);
      while (periods.length < 4) {
        periods.push(DEFAULT_EMAS[periods.length] ?? 200);
      }
      return [periods[0], periods[1], periods[2], periods[3]];
    }
  }
  return null;
}

/** Merge watchlist (symbol list) with user_config JSON metadata. */
export function mergeSymbolsFromWatchlist(
  watchlistSymbols: string[],
  configSymbols: SymbolMeta[],
): SymbolMeta[] {
  const metaBySymbol = new Map(
    (configSymbols || []).map((s) => [(s.symbol || '').toUpperCase(), s]),
  );
  return watchlistSymbols.map((sym) => {
    const meta = metaBySymbol.get(sym);
    return meta
      ? { ...meta, symbol: sym, exchange: meta.exchange || 'NSE' }
      : { symbol: sym, currency: 'INR', exchange: 'NSE' };
  });
}
