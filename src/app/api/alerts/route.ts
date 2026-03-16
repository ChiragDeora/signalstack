import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { loadAlerts, clearAlerts } from '@/lib/alertStore';

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Sign in required' }, { status: 401 });
    }

    // Load from Supabase if not yet in cache, otherwise return cached
    const alerts = await loadAlerts(userId);
    return NextResponse.json({
      success: true,
      alerts: alerts.slice(0, 100),
      count: alerts.length,
    });
  } catch (e) {
    console.error('alerts GET error', e);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Sign in required' }, { status: 401 });
    }

    await clearAlerts(userId);
    return NextResponse.json({ success: true, message: 'Alert history cleared' });
  } catch (e) {
    console.error('alerts DELETE error', e);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
