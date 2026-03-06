import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getOrCreateCrossoverService } from '@/lib/crossoverServiceSingleton';

/**
 * GET: Return current EMA values and warmup progress for a symbol+timeframe.
 * Used as a polling fallback when Socket.IO doesn't deliver (e.g. mobile networks, deploy without WS).
 * Query: symbol, timeframe. Auth optional; when signed in, returns status for that user's watch.
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const symbol = searchParams.get('symbol')?.toUpperCase();
    const timeframe = searchParams.get('timeframe') || '5m';

    if (!symbol) {
      return NextResponse.json(
        { error: 'Missing symbol' },
        { status: 400 }
      );
    }

    const { userId } = await auth();
    const svc = await getOrCreateCrossoverService();
    const status = svc.getEmaStatus(symbol, timeframe, userId ?? undefined);

    if (!status) {
      return NextResponse.json(
        { emas: {}, warmupProgress: {}, message: 'Not monitoring this symbol or warmup not started' },
        { status: 200 }
      );
    }

    return NextResponse.json({
      emas: status.emas,
      warmupProgress: status.warmupProgress,
    });
  } catch (e) {
    console.error('ema-status error:', e);
    return NextResponse.json(
      { error: 'Failed to get EMA status' },
      { status: 500 }
    );
  }
}
