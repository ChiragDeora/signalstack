import { NextRequest, NextResponse } from 'next/server';
import { UniversalMarketDataSource } from '@/lib/dynamicMarketSource';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { symbol, exchange = 'NSE' } = body;

    if (!symbol || typeof symbol !== 'string') {
      return NextResponse.json({ success: false, error: 'Symbol is required' }, { status: 400 });
    }

    const cleanSymbol = symbol.trim().toUpperCase();
    const exch = ['NSE', 'NFO', 'BSE'].includes(String(exchange)) ? (exchange as 'NSE' | 'NFO' | 'BSE') : 'NSE';

    const dataSource = new UniversalMarketDataSource(
      process.env.ALPHA_VANTAGE_API_KEY,
      process.env.NEXT_PUBLIC_FINNHUB_API_KEY,
    );

    const ltpData = await dataSource.fetchLTP(cleanSymbol, exch);

    if (ltpData) {
      return NextResponse.json({
        success: true,
        data: ltpData,
        symbol: cleanSymbol,
        exchange: exch,
        timestamp: new Date().toISOString(),
      });
    }

    return NextResponse.json({
      success: false,
      error: `No LTP data for ${cleanSymbol} on ${exch}`,
    }, { status: 200 });
  } catch (error) {
    console.error('❌ ltp route error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 },
    );
  }
}
