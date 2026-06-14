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
  const flags = ['overboughtCross', 'oversoldCross', 'thresholdBreach', 'centerlineCross', 'signalLineCross'] as const;
  for (const f of flags) {
    if (typeof s[f] !== 'boolean') {
      return { error: `rsi.signals.${f} must be a boolean` };
    }
  }
  if (!flags.some((f) => s[f] === true)) {
    return { error: 'At least one rsi.signals.* flag must be true when rsi.enabled = true' };
  }

  // signalLineLength is only required (and validated) when signalLineCross is on
  let signalLineLength: number | undefined;
  if (s.signalLineCross) {
    if (typeof r.signalLineLength === 'number' && Number.isFinite(r.signalLineLength)) {
      if (r.signalLineLength < 2 || r.signalLineLength > 200) {
        return { error: 'rsi.signalLineLength must be a number between 2 and 200 when signalLineCross is enabled' };
      }
      signalLineLength = r.signalLineLength;
    } else {
      signalLineLength = 14;
    }
  }

  // Optional RSI-specific timeframe — must be one of the allowed timeframes if set
  const validTimeframes = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
  let rsiTimeframe: string | undefined;
  if (r.timeframe != null) {
    if (typeof r.timeframe !== 'string' || !validTimeframes.includes(r.timeframe)) {
      return { error: `rsi.timeframe must be one of: ${validTimeframes.join(', ')}` };
    }
    rsiTimeframe = r.timeframe;
  }

  return {
    rsi: {
      enabled: true,
      period: r.period,
      overbought: r.overbought,
      oversold: r.oversold,
      ...(signalLineLength !== undefined ? { signalLineLength } : {}),
      ...(rsiTimeframe !== undefined ? { timeframe: rsiTimeframe } : {}),
      signals: {
        overboughtCross: !!s.overboughtCross,
        oversoldCross: !!s.oversoldCross,
        thresholdBreach: !!s.thresholdBreach,
        centerlineCross: !!s.centerlineCross,
        signalLineCross: !!s.signalLineCross,
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

    const emaAlertsOn = trackBullish !== false || trackBearish !== false;
    const { rsi: rsiConfig, error: rsiError } = validateRsi(rsi);
    if (rsiError) {
      return NextResponse.json({ success: false, error: rsiError }, { status: 400 });
    }
    const rsiOn = !!rsiConfig?.enabled;

    if (!symbol || !timeframe) {
      return NextResponse.json(
        { success: false, error: 'Need symbol and timeframe' },
        { status: 400 },
      );
    }
    if (!emaAlertsOn && !rsiOn) {
      return NextResponse.json(
        { success: false, error: 'Enable EMA crossover alerts, RSI alerts, or both' },
        { status: 400 },
      );
    }
    if (emaAlertsOn && (!emaPeriods || emaPeriods.length < 2)) {
      return NextResponse.json(
        { success: false, error: 'Need at least 2 EMA periods when EMA alerts are enabled' },
        { status: 400 },
      );
    }

    const periods = Array.isArray(emaPeriods) ? emaPeriods.map(Number).filter((n) => Number.isFinite(n)) : [];

    const config: WatchConfig = {
      userId,
      symbol: symbol.toUpperCase(),
      timeframe,
      emaPeriods: periods,
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
