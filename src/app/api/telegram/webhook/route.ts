import { NextRequest, NextResponse } from 'next/server';
import { sendTelegramMessage, setUserTelegramChatId, disconnectTelegramByChatId } from '@/lib/telegram';

interface TelegramUpdate {
  message?: {
    chat?: { id?: number | string };
    text?: string;
  };
}

const WELCOME =
  "👋 I'm the SignalStack alerts bot.\n\n" +
  'Open the SignalStack app → tap the gear icon → "Telegram alerts" → "Connect Telegram" ' +
  'to link this chat to your account.';

const CONNECTED =
  '✅ <b>Connected!</b>\n' +
  'You will now receive your EMA crossover and RSI alerts in this chat.\n' +
  'Send /stop to disconnect.';

const DISCONNECTED = '🔌 Disconnected. You will no longer receive SignalStack alerts in this chat.';

export async function POST(req: NextRequest) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) {
    const header = req.headers.get('x-telegram-bot-api-secret-token');
    if (header !== secret) {
      return NextResponse.json({ ok: false }, { status: 401 });
    }
  }

  const update = (await req.json().catch(() => null)) as TelegramUpdate | null;
  const message = update?.message;
  const chatId = message?.chat?.id;
  const text = (message?.text || '').trim();

  if (chatId != null && text) {
    const chatIdStr = String(chatId);
    if (text.startsWith('/start')) {
      const param = text.split(/\s+/)[1];
      if (param) {
        const res = await setUserTelegramChatId(param, chatIdStr);
        await sendTelegramMessage({
          chatId: chatIdStr,
          parseMode: 'HTML',
          text: res.ok ? CONNECTED : `⚠️ Could not connect: ${res.error || 'unknown error'}`,
        });
      } else {
        await sendTelegramMessage({ chatId: chatIdStr, text: WELCOME });
      }
    } else if (text === '/stop') {
      await disconnectTelegramByChatId(chatIdStr);
      await sendTelegramMessage({ chatId: chatIdStr, text: DISCONNECTED });
    } else {
      await sendTelegramMessage({ chatId: chatIdStr, parseMode: 'HTML', text: WELCOME });
    }
  }

  // Telegram retries on non-2xx — always ack.
  return NextResponse.json({ ok: true });
}
