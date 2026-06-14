import { NextRequest, NextResponse } from 'next/server';
import { fetchDaySummary } from '@/lib/daySummary';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { symbol, exchange = 'NSE' } = body;

    if (!symbol || typeof symbol !== 'string') {
      return NextResponse.json({ success: false, error: 'Symbol is required' }, { status: 400 });
    }

    const cleanSymbol = symbol.trim().toUpperCase();
    const exch = ['NSE', 'NFO', 'BSE'].includes(String(exchange)) ? (exchange as 'NSE' | 'NFO' | 'BSE') : 'NSE';

    const summary = await fetchDaySummary(cleanSymbol, exch);
    if (!summary) {
      return NextResponse.json({ success: false, error: `No data available for ${cleanSymbol}` }, { status: 200 });
    }

    return NextResponse.json({ success: true, data: summary });
  } catch (error) {
    console.error('❌ day-summary error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
