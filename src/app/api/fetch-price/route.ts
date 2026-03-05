import { NextRequest, NextResponse } from 'next/server';
import { UniversalMarketDataSource } from '@/lib/dynamicMarketSource';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { symbol, timeframe = '5m' } = body;

    if (!symbol || typeof symbol !== 'string') {
      return NextResponse.json({ success: false, error: 'Symbol is required' }, { status: 400 });
    }

    const cleanSymbol = symbol.trim().toUpperCase();

    const dataSource = new UniversalMarketDataSource(
      process.env.ALPHA_VANTAGE_API_KEY,
      process.env.NEXT_PUBLIC_FINNHUB_API_KEY,
    );

    const priceData = await dataSource.fetchTimeframeData(cleanSymbol, timeframe);

    if (priceData) {
      return NextResponse.json({
        success: true,
        data: priceData,
        timestamp: new Date().toISOString(),
      });
    }

    return NextResponse.json({
      success: false,
      error: `No data available for ${cleanSymbol}`,
    }, { status: 200 });
  } catch (error) {
    console.error('❌ fetch-price error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 },
    );
  }
}
