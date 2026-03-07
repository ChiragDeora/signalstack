import { NextRequest, NextResponse } from 'next/server';
import { auth, currentUser } from '@clerk/nextjs/server';
import { getSupabaseAdmin } from '@/lib/supabaseServer';

export interface UserConfigPayload {
  symbols: Array<{ symbol: string; name?: string; currency: string; exchange?: string }>;
  timeframeBySymbol: Record<string, string>;
  emasBySymbol: Record<string, Array<{ id: number; period: number; color: string }>>;
  trackBullish: boolean;
  trackBearish: boolean;
  selectedSymbol: string | null;
}

// GET: fetch current user's config
export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      console.warn('[user/config] GET: no userId (sign in required)');
      return NextResponse.json({ success: false, error: 'Sign in required' }, { status: 401 });
    }
    const supabase = getSupabaseAdmin();
    if (!supabase) {
      console.error('[user/config] GET: Supabase not configured (missing SUPABASE_SERVICE_ROLE_KEY?)');
      return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 503 });
    }
    const { data, error } = await supabase
      .from('user_config')
      .select('symbols, timeframe_by_symbol, emas_by_symbol, track_bullish, track_bearish, selected_symbol, name, email')
      .eq('user_id', userId)
      .single();
    if (error && error.code !== 'PGRST116') {
      console.warn('user config GET failed', error.message);
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json({
        success: true,
        config: {
          symbols: [],
          timeframeBySymbol: {},
          emasBySymbol: {},
          trackBullish: true,
          trackBearish: true,
          selectedSymbol: null,
        },
      });
    }
    return NextResponse.json({
      success: true,
      config: {
        symbols: data.symbols ?? [],
        timeframeBySymbol: data.timeframe_by_symbol ?? {},
        emasBySymbol: data.emas_by_symbol ?? {},
        trackBullish: data.track_bullish !== false,
        trackBearish: data.track_bearish !== false,
        selectedSymbol: data.selected_symbol ?? null,
      },
    });
  } catch (e) {
    console.error('user config GET error', e);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

// PUT: upsert current user's config (includes name/email from Clerk for cross-check)
export async function PUT(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      console.warn('[user/config] PUT: no userId (sign in required)');
      return NextResponse.json({ success: false, error: 'Sign in required' }, { status: 401 });
    }
    let name: string | null = null;
    let email: string | null = null;
    let phone: string | null = null;
    try {
      const user = await currentUser();
      if (user) {
        name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || null;
        const u = user as { primaryEmailAddress?: { emailAddress?: string }; emailAddresses?: { emailAddress?: string }[]; primaryPhoneNumber?: { phoneNumber?: string } };
        email = u.primaryEmailAddress?.emailAddress ?? u.emailAddresses?.[0]?.emailAddress ?? null;
        phone = u.primaryPhoneNumber?.phoneNumber ?? null;
      }
      console.log('[user/config] Clerk name/email/phone:', { name, email, phone });
    } catch (e) {
      console.warn('[user/config] currentUser() failed, saving without name/email/phone:', (e as Error).message);
    }

    const body = (await req.json()) as UserConfigPayload;
    const supabase = getSupabaseAdmin();
    if (!supabase) {
      console.error('[user/config] PUT: Supabase not configured');
      return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 503 });
    }
    const row = {
      user_id: userId,
      name: name ?? null,
      email: email ?? null,
      phone: phone ?? null,
      symbols: body.symbols ?? [],
      timeframe_by_symbol: body.timeframeBySymbol ?? {},
      emas_by_symbol: body.emasBySymbol ?? {},
      track_bullish: body.trackBullish !== false,
      track_bearish: body.trackBearish !== false,
      selected_symbol: body.selectedSymbol ?? null,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('user_config').upsert(row, { onConflict: 'user_id' });
    if (error) {
      console.error('[user/config] PUT failed:', error.message, error.details);
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
    console.log('[user/config] PUT ok, user_id:', userId, 'symbols:', (body.symbols ?? []).length);
    return NextResponse.json({ success: true });
  } catch (e) {
    console.error('[user/config] PUT error', e);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
