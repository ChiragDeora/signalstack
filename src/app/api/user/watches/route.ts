import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getWatchesByUser } from '@/lib/watchPersistence';

// GET: list current user's monitored watches (for UI restore)
export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      console.warn('[user/watches] GET: no userId');
      return NextResponse.json({ success: false, error: 'Sign in required' }, { status: 401 });
    }
    const watches = await getWatchesByUser(userId);
    return NextResponse.json({
      success: true,
      watches: watches.map((w) => ({
        symbol: w.symbol,
        timeframe: w.timeframe,
        emaPeriods: w.emaPeriods,
        trackBullish: w.trackBullish,
        trackBearish: w.trackBearish,
        exchange: w.exchange,
        currency: w.currency,
        rsi: w.rsi,
      })),
    });
  } catch (e) {
    console.error('user watches GET error', e);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
