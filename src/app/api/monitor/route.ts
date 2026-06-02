import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getOrCreateCrossoverService } from '@/lib/crossoverServiceSingleton';
import { WatchConfig, RsiConfig } from '@/lib/types';
import { saveWatch, removeWatch } from '@/lib/watchPersistence';

/**
 * Validate RSI config from request. Returns { rsi } on success or { error } on failure.
 * All fields are required when enabled. No defaults.
 */
function validateRsi(raw: unknown): { rsi?: RsiConfig; error?: string } {
  if (raw == null) return {};
  if (typeof raw !== 'object') return { error: 'rsi must be an object' };
  const r = raw as any;
  if (!r.enabled) return {}; // explicitly disabled

  if (typeof r.period !== 'number' || !Number.isFinite(r.period) || r.period < 2 || r.period > 200) {
    return { error: 'rsi.period must be a number between 2 and 200' };
  }
  if (typeof r.overbought !== 'number' || r.overbought <= 50 || r.overbought > 100) {
    return { error: 'rsi.overbought must be a number in (50, 100]' };
  }
  if (typeof r.oversold !== 'number' || r.oversold < 0 || r.oversold >= 50) {
    return { error: 'rsi.oversold must be a number in [0, 50)' };
  }
  const s = r.signals;
  if (!s || typeof s !== 'object') {
    return { error: 'rsi.signals object is required when rsi.enabled = true' };
  }
  const flags = ['overboughtCross', 'oversoldCross', 'thresholdBreach', 'centerlineCross'] as const;
  for (const f of flags) {
    if (typeof s[f] !== 'boolean') {
      return { error: `rsi.signals.${f} must be a boolean` };
    }
  }
  if (!flags.some((f) => s[f] === true)) {
    return { error: 'At least one rsi.signals.* flag must be true when rsi.enabled = true' };
  }

  return {
    rsi: {
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
    },
  };
}

// POST: Start monitoring a symbol (requires auth; segregates polls per user)
export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Sign in required' }, { status: 401 });
    }

    const body = await req.json();
    const { symbol, timeframe, emaPeriods, trackBullish, trackBearish, exchange, currency, rsi } = body;

    if (!symbol || !timeframe || !emaPeriods || emaPeriods.length < 2) {
      return NextResponse.json(
        { success: false, error: 'Need symbol, timeframe, and at least 2 EMA periods' },
        { status: 400 },
      );
    }

    const { rsi: rsiConfig, error: rsiError } = validateRsi(rsi);
    if (rsiError) {
      return NextResponse.json({ success: false, error: rsiError }, { status: 400 });
    }

    const config: WatchConfig = {
      userId,
      symbol: symbol.toUpperCase(),
      timeframe,
      emaPeriods: emaPeriods.map(Number),
      trackBullish: trackBullish !== false,
      trackBearish: trackBearish !== false,
      exchange: exchange || 'NSE',
      currency: currency || 'INR',
    };
    if (rsiConfig) config.rsi = rsiConfig;

    const svc = await getOrCreateCrossoverService();
    const result = await svc.startMonitoring(config);
    if (result.success) {
      await saveWatch(config).catch((e) => console.warn('Persist watch failed:', e?.message));
    }
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('❌ Monitor start error:', error);
    return NextResponse.json(
      { success: false, error: error?.message || 'Failed to start monitoring' },
      { status: 500 },
    );
  }
}

// DELETE: Stop monitoring a symbol (requires auth; scoped to user)
export async function DELETE(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Sign in required' }, { status: 401 });
    }

    const body = await req.json();
    const { symbol, timeframe } = body;

    if (!symbol) {
      return NextResponse.json(
        { success: false, error: 'Symbol is required' },
        { status: 400 },
      );
    }

    const svc = await getOrCreateCrossoverService();
    await svc.stopMonitoring(symbol, timeframe, userId);
    await removeWatch(userId, symbol, timeframe).catch((e) => console.warn('Persist remove watch failed:', e?.message));

    return NextResponse.json({
      success: true,
      message: `Stopped monitoring ${symbol}`,
    });
  } catch (error: any) {
    console.error('❌ Monitor stop error:', error);
    return NextResponse.json(
      { success: false, error: error?.message || 'Failed to stop monitoring' },
      { status: 500 },
    );
  }
}

// GET: Get monitoring status
export async function GET() {
  try {
    const svc = await getOrCreateCrossoverService();
    const info = svc.getMonitoringInfo();

    return NextResponse.json({
      success: true,
      ...info,
      uptime: process.uptime(),
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error?.message || 'Failed to get status' },
      { status: 500 },
    );
  }
}
