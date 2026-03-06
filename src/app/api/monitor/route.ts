import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getOrCreateCrossoverService } from '@/lib/crossoverServiceSingleton';
import { WatchConfig } from '@/lib/types';
import { saveWatch, removeWatch } from '@/lib/watchPersistence';

// POST: Start monitoring a symbol (requires auth; segregates polls per user)
export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Sign in required' }, { status: 401 });
    }

    const body = await req.json();
    const { symbol, timeframe, emaPeriods, trackBullish, trackBearish, exchange, currency } = body;

    if (!symbol || !timeframe || !emaPeriods || emaPeriods.length < 2) {
      return NextResponse.json(
        { success: false, error: 'Need symbol, timeframe, and at least 2 EMA periods' },
        { status: 400 },
      );
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
