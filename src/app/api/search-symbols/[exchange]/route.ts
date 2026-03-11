import { NextRequest, NextResponse } from 'next/server';
import { UniversalMarketDataSource } from '@/lib/dynamicMarketSource';

const EXCHANGES = ['NSE', 'NFO', 'BSE'] as const;
type Exchange = (typeof EXCHANGES)[number];

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ exchange: string }> }
) {
  try {
    const { exchange: exchangeParam } = await params;
    const exchange = exchangeParam?.toUpperCase() as Exchange;
    if (!EXCHANGES.includes(exchange)) {
      return NextResponse.json(
        { success: false, error: `Exchange must be one of: ${EXCHANGES.join(', ')}` },
        { status: 400 }
      );
    }

    const body = await req.json();
    const { query } = body;

    if (!query || typeof query !== 'string' || query.trim().length < 1) {
      return NextResponse.json({ success: false, error: 'Search query is required' }, { status: 400 });
    }

    const dataSource = new UniversalMarketDataSource();
    const results = await dataSource.searchSymbols(query.trim(), exchange);

    return NextResponse.json({
      success: true,
      results,
      exchange,
      count: results.length,
    });
  } catch (error) {
    console.error('❌ [search-symbols/[exchange]] Error:', error);
    return NextResponse.json({ success: false, error: 'Failed to search symbols' }, { status: 500 });
  }
}
