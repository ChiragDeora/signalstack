import { NextResponse } from 'next/server';
import { getDhanSource } from '@/lib/dhanSource';

// Called once by server.js after Next.js is ready to pre-load the scrip master
// so the first user search doesn't have to wait for the CSV download.
export async function GET() {
  const dhan = getDhanSource();
  if (!dhan.isAvailable()) {
    return NextResponse.json({ ok: false, reason: 'Dhan credentials not configured' });
  }

  // Trigger a dummy search — this loads + caches the scrip master
  await dhan.searchSymbols('NIFTY');

  return NextResponse.json({ ok: true });
}
