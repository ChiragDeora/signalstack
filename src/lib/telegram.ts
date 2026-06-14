/**
 * Telegram alerts via Bot API.
 * Bot token comes from env (TELEGRAM_BOT_TOKEN; legacy: telegram_auth_bot_api).
 * Each user's chat_id is stored in profiles.telegram_chat_id (see profilePersistence).
 */

import { getSupabaseAdmin } from './supabaseServer';

const TG_API_BASE = 'https://api.telegram.org';

function getBotToken(): string | null {
  const t =
    process.env.TELEGRAM_BOT_TOKEN ||
    process.env.telegram_auth_bot_api ||
    process.env.TELEGRAM_AUTH_BOT_API ||
    '';
  return t.trim() || null;
}

export function isTelegramConfigured(): boolean {
  return !!getBotToken();
}

let cachedBotUsername: string | null | undefined;

/** Bot's @username (for building t.me deep links). Cached after the first lookup. */
export async function getBotUsername(): Promise<string | null> {
  if (cachedBotUsername !== undefined) return cachedBotUsername;
  const token = getBotToken();
  if (!token) {
    cachedBotUsername = null;
    return null;
  }
  try {
    const res = await fetch(`${TG_API_BASE}/bot${token}/getMe`);
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: { username?: string } };
    cachedBotUsername = data?.ok ? data.result?.username || null : null;
  } catch {
    cachedBotUsername = null;
  }
  return cachedBotUsername;
}

/**
 * A one-tap "Connect Telegram" link: opens a chat with the bot pre-filled with
 * /start <userId>. The webhook handler reads that param and saves the chat id
 * for this user — no manual chat-id lookup needed.
 */
export async function getTelegramConnectUrl(userId: string): Promise<string | null> {
  const username = await getBotUsername();
  if (!username || !userId) return null;
  return `https://t.me/${username}?start=${encodeURIComponent(userId)}`;
}

/** Disconnect whichever account has this chat id saved (used by the /stop command). */
export async function disconnectTelegramByChatId(chatId: string): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  if (!supabase || !chatId) return false;
  const { error } = await supabase
    .from('profiles')
    .update({ telegram_chat_id: null, updated_at: new Date().toISOString() })
    .eq('telegram_chat_id', chatId);
  return !error;
}

/**
 * Point Telegram's webhook at our server. Call once after deploy (see
 * /api/telegram/setup). No-op if the bot token isn't configured.
 */
export async function registerTelegramWebhook(baseUrl: string): Promise<{ ok: boolean; description?: string }> {
  const token = getBotToken();
  if (!token) return { ok: false, description: 'Bot token not configured' };
  const url = `${baseUrl.replace(/\/$/, '')}/api/telegram/webhook`;
  const body: Record<string, unknown> = { url, allowed_updates: ['message'] };
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) body.secret_token = secret;
  try {
    const res = await fetch(`${TG_API_BASE}/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    return { ok: !!data.ok, description: data.description };
  } catch (err: unknown) {
    return { ok: false, description: err instanceof Error ? err.message : String(err) };
  }
}

export async function getUserTelegramChatId(userId: string): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase || !userId) return null;
  const { data, error } = await supabase
    .from('profiles')
    .select('telegram_chat_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.warn('[telegram] getUserTelegramChatId failed:', error.message);
    return null;
  }
  const id = (data?.telegram_chat_id || '').toString().trim();
  return id || null;
}

export async function setUserTelegramChatId(userId: string, chatId: string | null): Promise<{ ok: boolean; error?: string }> {
  const supabase = getSupabaseAdmin();
  if (!supabase || !userId) return { ok: false, error: 'Database not configured' };
  const cleaned = (chatId || '').toString().trim();
  if (cleaned && !/^-?\d{4,}$/.test(cleaned)) {
    return { ok: false, error: 'Telegram chat id must be a number (e.g. 123456789 or -1009876543210)' };
  }
  const value = cleaned || null;
  // Use update first; if no row, insert a minimal one.
  const { data: existing, error: selErr } = await supabase
    .from('profiles')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (selErr) return { ok: false, error: selErr.message };
  if (existing) {
    const { error } = await supabase
      .from('profiles')
      .update({ telegram_chat_id: value, updated_at: new Date().toISOString() })
      .eq('user_id', userId);
    if (error) return { ok: false, error: error.message };
  } else {
    const { error } = await supabase
      .from('profiles')
      .insert({ user_id: userId, telegram_chat_id: value, updated_at: new Date().toISOString() });
    if (error) return { ok: false, error: error.message };
  }
  return { ok: true };
}

interface SendMessageOpts {
  chatId: string;
  text: string;
  parseMode?: 'HTML' | 'MarkdownV2';
  disablePreview?: boolean;
}

export async function sendTelegramMessage(opts: SendMessageOpts): Promise<{ ok: boolean; error?: string }> {
  const token = getBotToken();
  if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set' };
  if (!opts.chatId) return { ok: false, error: 'chatId is required' };
  const body: Record<string, unknown> = {
    chat_id: opts.chatId,
    text: opts.text,
    disable_web_page_preview: opts.disablePreview ?? true,
  };
  if (opts.parseMode) body.parse_mode = opts.parseMode;
  try {
    const res = await fetch(`${TG_API_BASE}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!res.ok || !data.ok) {
      const msg = data.description || `HTTP ${res.status}`;
      console.warn('Telegram sendMessage failed:', msg);
      return { ok: false, error: msg };
    }
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('Telegram sendMessage error:', msg);
    return { ok: false, error: msg };
  }
}

function fmtTimeIST(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'medium',
      timeStyle: 'short',
    }) + ' IST';
  } catch {
    return iso;
  }
}

export async function sendCrossoverTelegramAlert(
  userId: string,
  alert: {
    symbol: string;
    timeframe: string;
    crossoverType: 'bullish' | 'bearish';
    fastPeriod: number;
    slowPeriod: number;
    price: number;
    currency: string;
    timestamp: string;
  },
): Promise<void> {
  if (!isTelegramConfigured()) return;
  const chatId = await getUserTelegramChatId(userId);
  if (!chatId) return;
  const emoji = alert.crossoverType === 'bullish' ? '📈' : '📉';
  const dir = alert.crossoverType === 'bullish' ? 'Bullish' : 'Bearish';
  const arrow = alert.crossoverType === 'bullish' ? 'above' : 'below';
  const text =
    `${emoji} <b>${dir} crossover</b>\n` +
    `<b>${alert.symbol}</b> · ${alert.timeframe}\n` +
    `EMA(${alert.fastPeriod}) crossed ${arrow} EMA(${alert.slowPeriod})\n` +
    `Price: ${alert.currency} ${alert.price}\n` +
    `<i>${fmtTimeIST(alert.timestamp)}</i>`;
  await sendTelegramMessage({ chatId, text, parseMode: 'HTML' });
}

const RSI_SIGNAL_LABEL: Record<string, string> = {
  overboughtCross: 'Overbought cross',
  oversoldCross: 'Oversold cross',
  thresholdBreach: 'Threshold breach',
  centerlineCross: 'Centerline (50) cross',
  signalLineCross: 'Signal line cross',
};

export async function sendRsiTelegramAlert(
  userId: string,
  alert: {
    symbol: string;
    timeframe: string;
    signalType: 'overboughtCross' | 'oversoldCross' | 'thresholdBreach' | 'centerlineCross' | 'signalLineCross';
    direction: 'bullish' | 'bearish';
    rsiValue: number;
    previousRsi: number;
    period: number;
    overbought: number;
    oversold: number;
    price: number;
    currency: string;
    timestamp: string;
  },
): Promise<void> {
  if (!isTelegramConfigured()) return;
  const chatId = await getUserTelegramChatId(userId);
  if (!chatId) return;
  const emoji = alert.direction === 'bullish' ? '📈' : '📉';
  const label = RSI_SIGNAL_LABEL[alert.signalType] ?? alert.signalType;
  const text =
    `${emoji} <b>RSI ${label}</b>\n` +
    `<b>${alert.symbol}</b> · ${alert.timeframe}\n` +
    `RSI(${alert.period}) = <b>${alert.rsiValue.toFixed(2)}</b> (prev ${alert.previousRsi.toFixed(2)})\n` +
    `Direction: ${alert.direction}\n` +
    `Price: ${alert.currency} ${alert.price}\n` +
    `<i>${fmtTimeIST(alert.timestamp)}</i>`;
  await sendTelegramMessage({ chatId, text, parseMode: 'HTML' });
}
