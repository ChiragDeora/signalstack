// ============================================
// POST /api/user/cleanup
// ============================================
// Account hygiene for the signed-in user. Does two things:
//
//   1. Dedupes user_config.symbols by case-insensitive symbol name.
//      When duplicates exist (e.g. "NIFTY 50" + "Nifty 50"), keeps the
//      entry whose emas_by_symbol[key] has the most EMAs configured.
//      Removes the loser from symbols, timeframe_by_symbol, and
//      emas_by_symbol.
//
//   2. Stops + deletes orphan watches — rows in the `watches` table
//      whose symbol no longer appears in user_config.symbols. These
//      accumulate when a user removed a symbol from the UI while it
//      was in an error state (the DELETE /api/monitor call is skipped
//      when local state thinks the watch isn't running).
//
// Returns a report. Safe to run multiple times.

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getSupabaseAdmin } from '@/lib/supabaseServer';
import { getOrCreateCrossoverService } from '@/lib/crossoverServiceSingleton';

interface SymbolEntry {
  symbol: string;
  name?: string;
  currency?: string;
  exchange?: string;
}

interface EmaEntry {
  id: number | string;
  color: string;
  period: number;
}

export async function POST() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Sign in required' }, { status: 401 });
    }

    const supabase = getSupabaseAdmin();
    if (!supabase) {
      return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 503 });
    }

    // ── Load current state ──
    const { data: cfg, error: cfgErr } = await supabase
      .from('user_config')
      .select('symbols, timeframe_by_symbol, emas_by_symbol')
      .eq('user_id', userId)
      .single();

    if (cfgErr && cfgErr.code !== 'PGRST116') {
      return NextResponse.json({ success: false, error: cfgErr.message }, { status: 500 });
    }

    const { data: watchRows, error: watchErr } = await supabase
      .from('watches')
      .select('symbol, timeframe')
      .eq('user_id', userId);

    if (watchErr) {
      return NextResponse.json({ success: false, error: watchErr.message }, { status: 500 });
    }

    const symbols: SymbolEntry[] = Array.isArray(cfg?.symbols) ? cfg.symbols : [];
    const tfBySymbol: Record<string, string> = (cfg?.timeframe_by_symbol as Record<string, string>) ?? {};
    const emasBySymbol: Record<string, EmaEntry[]> = (cfg?.emas_by_symbol as Record<string, EmaEntry[]>) ?? {};

    // ── (1) Dedupe symbols by case-insensitive name ──
    const seenKey = new Map<string, SymbolEntry>(); // key=lowercase symbol → kept entry
    const dropped: string[] = [];

    // First pass — group by lowercase key and pick the "best" representative
    const groups = new Map<string, SymbolEntry[]>();
    for (const s of symbols) {
      const k = (s.symbol || '').trim().toLowerCase();
      if (!k) continue;
      const arr = groups.get(k) ?? [];
      arr.push(s);
      groups.set(k, arr);
    }

    for (const [k, group] of groups) {
      if (group.length === 1) {
        seenKey.set(k, group[0]);
        continue;
      }
      // Pick the one with the most EMAs configured (more user investment).
      // Tie-break by keeping the first.
      let best = group[0];
      let bestEmaCount = (emasBySymbol[best.symbol]?.length) ?? 0;
      for (let i = 1; i < group.length; i++) {
        const c = group[i];
        const cnt = (emasBySymbol[c.symbol]?.length) ?? 0;
        if (cnt > bestEmaCount) {
          best = c;
          bestEmaCount = cnt;
        }
      }
      seenKey.set(k, best);
      for (const c of group) {
        if (c.symbol !== best.symbol) dropped.push(c.symbol);
      }
    }

    // Build the cleaned config
    const cleanedSymbols = Array.from(seenKey.values());
    const cleanedTfBySymbol: Record<string, string> = {};
    const cleanedEmasBySymbol: Record<string, EmaEntry[]> = {};
    for (const s of cleanedSymbols) {
      if (tfBySymbol[s.symbol] != null) cleanedTfBySymbol[s.symbol] = tfBySymbol[s.symbol];
      if (Array.isArray(emasBySymbol[s.symbol])) cleanedEmasBySymbol[s.symbol] = emasBySymbol[s.symbol];
    }

    // Persist cleaned user_config only if duplicates existed
    if (dropped.length > 0) {
      const { error: updateErr } = await supabase
        .from('user_config')
        .update({
          symbols: cleanedSymbols,
          timeframe_by_symbol: cleanedTfBySymbol,
          emas_by_symbol: cleanedEmasBySymbol,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId);
      if (updateErr) {
        return NextResponse.json({ success: false, error: updateErr.message }, { status: 500 });
      }
    }

    // ── (2) Find orphan watches and stop them ──
    const liveSymbolsLower = new Set(cleanedSymbols.map((s) => (s.symbol || '').toUpperCase()));
    const orphans = (watchRows ?? []).filter(
      (w) => !liveSymbolsLower.has((w.symbol || '').toUpperCase()),
    );

    const svc = await getOrCreateCrossoverService();
    const orphanResults: string[] = [];
    for (const o of orphans) {
      try {
        await svc.stopMonitoring(o.symbol, o.timeframe, userId);
        // stopMonitoring tears down the engine + emits status, but does NOT
        // delete the persisted row, so we also delete here.
        await supabase
          .from('watches')
          .delete()
          .eq('user_id', userId)
          .eq('symbol', (o.symbol || '').toUpperCase())
          .eq('timeframe', o.timeframe);
        orphanResults.push(`${o.symbol} (${o.timeframe})`);
      } catch (e: any) {
        console.warn(`[cleanup] failed to stop orphan ${o.symbol}:`, e?.message);
      }
    }

    return NextResponse.json({
      success: true,
      duplicatesRemoved: dropped,
      orphansStopped: orphanResults,
    });
  } catch (e: any) {
    console.error('[user/cleanup] error', e);
    return NextResponse.json({ success: false, error: e?.message || 'Internal error' }, { status: 500 });
  }
}
