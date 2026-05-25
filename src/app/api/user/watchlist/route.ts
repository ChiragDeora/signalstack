import { NextRequest, NextResponse } from 'next/server';
import { auth, currentUser } from '@clerk/nextjs/server';
import {
  addWatchlistSymbol,
  ensureProfile,
  removeWatchlistSymbol,
} from '@/lib/profilePersistence';

async function clerkProfileFields(): Promise<{ name: string | null; email: string | null }> {
  try {
    const user = await currentUser();
    if (!user) return { name: null, email: null };
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || null;
    const u = user as {
      primaryEmailAddress?: { emailAddress?: string };
      emailAddresses?: { emailAddress?: string }[];
    };
    const email =
      u.primaryEmailAddress?.emailAddress ?? u.emailAddresses?.[0]?.emailAddress ?? null;
    return { name, email };
  } catch {
    return { name: null, email: null };
  }
}

// POST: add one symbol to watchlist immediately (survives rapid add/remove)
export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Sign in required' }, { status: 401 });
    }
    const body = await req.json();
    const symbol = (body?.symbol as string)?.trim();
    if (!symbol) {
      return NextResponse.json({ success: false, error: 'symbol required' }, { status: 400 });
    }
    const { name, email } = await clerkProfileFields();
    await ensureProfile(userId, { name, email });
    await addWatchlistSymbol(userId, symbol);
    return NextResponse.json({ success: true });
  } catch (e) {
    console.error('[user/watchlist] POST error', e);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE: remove one symbol from watchlist
export async function DELETE(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Sign in required' }, { status: 401 });
    }
    const symbol =
      req.nextUrl.searchParams.get('symbol')?.trim() ||
      ((await req.json().catch(() => ({}))) as { symbol?: string })?.symbol?.trim();
    if (!symbol) {
      return NextResponse.json({ success: false, error: 'symbol required' }, { status: 400 });
    }
    await removeWatchlistSymbol(userId, symbol);
    return NextResponse.json({ success: true });
  } catch (e) {
    console.error('[user/watchlist] DELETE error', e);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
