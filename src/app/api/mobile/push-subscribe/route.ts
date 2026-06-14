import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { saveExpoPushToken, removeExpoPushToken } from '@/lib/expoPush';

// POST: register an Expo push token for the signed-in user
export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Sign in required' }, { status: 401 });
    }
    const body = await req.json().catch(() => ({}));
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    const platform = typeof body?.platform === 'string' ? body.platform : 'android';
    if (!token.startsWith('ExponentPushToken[') && !token.startsWith('ExpoPushToken[')) {
      return NextResponse.json({ success: false, error: 'Invalid Expo push token' }, { status: 400 });
    }
    await saveExpoPushToken(token, userId, platform);
    return NextResponse.json({ success: true });
  } catch (e: any) {
    console.error('mobile/push-subscribe POST error', e);
    return NextResponse.json({ success: false, error: e?.message || 'Internal error' }, { status: 500 });
  }
}

// DELETE: unregister a token
export async function DELETE(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Sign in required' }, { status: 401 });
    }
    const body = await req.json().catch(() => ({}));
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    if (!token) return NextResponse.json({ success: false, error: 'token required' }, { status: 400 });
    await removeExpoPushToken(token);
    return NextResponse.json({ success: true });
  } catch (e: any) {
    console.error('mobile/push-subscribe DELETE error', e);
    return NextResponse.json({ success: false, error: e?.message || 'Internal error' }, { status: 500 });
  }
}
