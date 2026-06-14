import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import {
  getUserTelegramChatId,
  setUserTelegramChatId,
  sendTelegramMessage,
  isTelegramConfigured,
  getTelegramConnectUrl,
} from '@/lib/telegram';

// GET: return whether telegram is configured server-side, the user's saved chat id (if any),
// and a one-tap "Connect Telegram" deep link.
export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Sign in required' }, { status: 401 });
    }
    const chatId = await getUserTelegramChatId(userId);
    const connectUrl = await getTelegramConnectUrl(userId);
    return NextResponse.json({
      success: true,
      configured: isTelegramConfigured(),
      chatId: chatId ?? '',
      connectUrl,
    });
  } catch (e: any) {
    console.error('user/telegram GET error:', e);
    return NextResponse.json({ success: false, error: e?.message || 'Internal error' }, { status: 500 });
  }
}

// PUT: save (or clear with empty string) the user's chat id
export async function PUT(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Sign in required' }, { status: 401 });
    }
    const body = await req.json().catch(() => ({}));
    const chatId = typeof body?.chatId === 'string' ? body.chatId : '';
    const res = await setUserTelegramChatId(userId, chatId);
    if (!res.ok) {
      return NextResponse.json({ success: false, error: res.error }, { status: 400 });
    }
    return NextResponse.json({ success: true, chatId });
  } catch (e: any) {
    console.error('user/telegram PUT error:', e);
    return NextResponse.json({ success: false, error: e?.message || 'Internal error' }, { status: 500 });
  }
}

// POST: send a test message to the user's saved chat id
export async function POST() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Sign in required' }, { status: 401 });
    }
    if (!isTelegramConfigured()) {
      return NextResponse.json({ success: false, error: 'TELEGRAM_BOT_TOKEN not configured on the server' }, { status: 400 });
    }
    const chatId = await getUserTelegramChatId(userId);
    if (!chatId) {
      return NextResponse.json({ success: false, error: 'Save your Telegram chat id first' }, { status: 400 });
    }
    const result = await sendTelegramMessage({
      chatId,
      text: '🔔 <b>SignalStack test</b>\nTelegram alerts are wired up. You will receive crossover and RSI alerts here.',
      parseMode: 'HTML',
    });
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error || 'Send failed' }, { status: 502 });
    }
    return NextResponse.json({ success: true, message: 'Sent — check Telegram.' });
  } catch (e: any) {
    console.error('user/telegram POST error:', e);
    return NextResponse.json({ success: false, error: e?.message || 'Internal error' }, { status: 500 });
  }
}
