import { NextRequest, NextResponse } from 'next/server';
import { isTelegramConfigured, registerTelegramWebhook } from '@/lib/telegram';

/**
 * One-time (idempotent) Telegram webhook registration. Called automatically
 * on server boot (see server.js) when a public URL is known. Safe to call
 * repeatedly — Telegram just re-registers the same webhook.
 */
export async function GET(req: NextRequest) {
  if (!isTelegramConfigured()) {
    return NextResponse.json({ ok: false, reason: 'TELEGRAM_BOT_TOKEN not configured' });
  }

  const base = process.env.APP_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || req.nextUrl.origin;
  if (/localhost|127\.0\.0\.1/.test(base)) {
    return NextResponse.json({ ok: false, reason: 'Telegram cannot reach a local URL — deploy and set APP_PUBLIC_URL.' });
  }

  const result = await registerTelegramWebhook(base);
  return NextResponse.json({
    ok: result.ok,
    description: result.description,
    webhookUrl: `${base.replace(/\/$/, '')}/api/telegram/webhook`,
  });
}
