import { NextRequest, NextResponse } from 'next/server';
import { UniversalMarketDataSource } from '@/lib/dynamicMarketSource';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { query, exchangeFilter } = body;

    console.log('[search-symbols] POST body:', { query, queryLength: query?.length, exchangeFilter: exchangeFilter ?? 'ALL' });

    if (!query || query.length < 1) {
      console.log('[search-symbols] Rejected: empty query');
      return NextResponse.json({ success: false, error: 'Search query is required' }, { status: 400 });
    }

    const dataSource = new UniversalMarketDataSource();

    const filter = ['ALL', 'NSE', 'NFO', 'BSE'].includes(exchangeFilter) ? exchangeFilter : undefined;
    console.log('[search-symbols] Calling dataSource.searchSymbols:', query, filter);
    const results = await dataSource.searchSymbols(query, filter);
    console.log('[search-symbols] Results:', { count: results.length, symbols: results.map((r) => r.symbol).slice(0, 5) });

    return NextResponse.json({
      success: true,
      results,
      count: results.length,
    });
  } catch (error) {
    console.error('❌ [search-symbols] Error:', error);
    return NextResponse.json({ success: false, error: 'Failed to search symbols' }, { status: 500 });
  }
}
