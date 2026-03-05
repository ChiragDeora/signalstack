import { NextResponse } from 'next/server';
import { getAngelOneSource } from '@/lib/angelOneSource';

// Called once by server.js after Next.js is ready to pre-warm Angel One login
// so the first user request doesn't pay the login cost.
export async function GET() {
  const angel = getAngelOneSource();
  if (!angel.isAvailable()) {
    return NextResponse.json({ ok: false, reason: 'Angel One credentials not configured' });
  }

  // Trigger a tiny search to force login + JWT creation.
  await angel.searchSymbols('RELIANCE');

  return NextResponse.json({ ok: true });
}
