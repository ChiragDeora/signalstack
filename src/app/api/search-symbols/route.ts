import { NextRequest, NextResponse } from 'next/server';
import { UniversalMarketDataSource } from '@/lib/dynamicMarketSource';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { query } = body;

    if (!query || query.length < 1) {
      return NextResponse.json({ success: false, error: 'Search query is required' }, { status: 400 });
    }

    const dataSource = new UniversalMarketDataSource(
      process.env.ALPHA_VANTAGE_API_KEY,
      process.env.NEXT_PUBLIC_FINNHUB_API_KEY,
    );

    const results = await dataSource.searchSymbols(query);

    return NextResponse.json({
      success: true,
      results,
      count: results.length,
    });
  } catch (error) {
    console.error('❌ Symbol search error:', error);
    return NextResponse.json({ success: false, error: 'Failed to search symbols' }, { status: 500 });
  }
}
