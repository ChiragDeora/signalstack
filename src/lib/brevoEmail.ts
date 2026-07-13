/**
 * Brevo email: API (preferred) or SMTP.
 * - API: set BREVO_API_KEY (Brevo → Settings → SMTP & API → API keys). Same account as dashboard; credits decrement.
 * - SMTP: set BREVO_SMTP_USER + BREVO_SMTP_PASS (SMTP key from same page).
 * Optional: BREVO_FROM_EMAIL, BREVO_ALERT_TO.
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { isMarketOpen } from './marketHours';

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

export type EmailAttachment = {
  filename: string;
  content: string;
  contentType?: string;
};

function getBrevoConfig() {
  const host = process.env.BREVO_SMTP_HOST || 'smtp-relay.brevo.com';
  const port = parseInt(process.env.BREVO_SMTP_PORT || '587', 10);
  const user = process.env.BREVO_SMTP_USER || '';
  const pass = process.env.BREVO_SMTP_PASS || '';
  const from = process.env.BREVO_FROM_EMAIL || process.env.BREVO_SMTP_USER || 'alerts@signalstack.app';
  return { host, port, user, pass, from };
}

function getSender() {
  const from = getBrevoConfig().from;
  const name = process.env.BREVO_FROM_NAME || 'SignalStack';
  return { name, email: from };
}

function getTransporter(): Transporter | null {
  const { host, port, user, pass } = getBrevoConfig();
  if (!user || !pass) return null;
  try {
    return nodemailer.createTransport({
      host,
      port,
      secure: port === 465, // false for 587 (STARTTLS)
      auth: { user, pass },
    });
  } catch {
    return null;
  }
}

export function isBrevoConfigured(): boolean {
  if (process.env.BREVO_API_KEY?.trim()) return true;
  const { user, pass } = getBrevoConfig();
  return !!(user && pass);
}

/**
 * Send via Brevo Transactional API (preferred: same account as dashboard, credits decrement).
 */
async function sendEmailViaApi(options: {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  attachments?: EmailAttachment[];
}): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.BREVO_API_KEY?.trim();
  if (!apiKey) return { ok: false, error: 'BREVO_API_KEY not set' };
  const sender = getSender();
  console.log('Brevo API: sending from', sender.email, 'to', Array.isArray(options.to) ? options.to : [options.to]);
  const toList = Array.isArray(options.to) ? options.to : [options.to];
  const to = toList.map((e) => (typeof e === 'string' ? { email: e.trim() } : { email: (e as { email: string }).email }));
  const body: Record<string, unknown> = {
    sender,
    to,
    subject: options.subject,
  };
  if (options.html) body.htmlContent = options.html;
  if (options.text) body.textContent = options.text;
  if (!body.htmlContent && !body.textContent) body.textContent = '(No content)';
  if (options.replyTo) body.replyTo = { email: options.replyTo };
  if (options.attachments?.length) {
    body.attachment = options.attachments.map((a) => ({
      name: a.filename,
      content: a.content,
      type: a.contentType,
    }));
  }
  try {
    const res = await fetch(BREVO_API_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const msg = [data.message, data.code, res.statusText].filter(Boolean).join(' ') || 'Request failed';
      console.warn('Brevo API error:', res.status, JSON.stringify(data));
      return { ok: false, error: String(data.message || data.code || msg).trim() || `HTTP ${res.status}` };
    }
    const messageId = data.messageId as string | undefined;
    if (messageId) console.log('Brevo API sent, messageId:', messageId);
    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('Brevo API send failed:', message);
    return { ok: false, error: message };
  }
}

/**
 * Send a single email. Uses BREVO_API_KEY if set (recommended), else SMTP.
 */
export async function sendEmail(options: {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  attachments?: EmailAttachment[];
}): Promise<{ ok: boolean; error?: string }> {
  if (process.env.BREVO_API_KEY?.trim()) {
    console.log('Using Brevo API (BREVO_API_KEY is set)');
    return sendEmailViaApi(options);
  }
  console.log('Using Brevo SMTP (BREVO_SMTP_USER)');
  const trans = getTransporter();
  if (!trans) {
    return { ok: false, error: 'Brevo not configured. Set BREVO_API_KEY (recommended) or BREVO_SMTP_USER + BREVO_SMTP_PASS.' };
  }
  const { from } = getBrevoConfig();
  const to = Array.isArray(options.to) ? options.to.join(', ') : options.to;
  try {
    await trans.verify();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('Brevo SMTP verify failed:', message);
    return {
      ok: false,
      error: `Brevo SMTP failed: ${message}. Use SMTP key from Brevo → Settings → SMTP & API (not API key for SMTP).`,
    };
  }
  try {
    const info = await trans.sendMail({
      from,
      to,
      subject: options.subject,
      text: options.text,
      html: options.html,
      replyTo: options.replyTo,
      attachments: options.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
        encoding: 'base64',
      })),
    });
    if (info.messageId) {
      console.log('Brevo SMTP accepted, messageId:', info.messageId);
    }
    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('Brevo sendEmail error:', message);
    return { ok: false, error: message };
  }
}

/**
 * Comma-separated list of emails to receive every crossover alert (optional).
 * Set BREVO_ALERT_TO in env, e.g. "user1@example.com,user2@example.com"
 */
export function getAlertRecipientEmails(): string[] {
  const raw = process.env.BREVO_ALERT_TO || '';
  return raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0 && e.includes('@'));
}

/**
 * Format alert timestamp for email: readable date and time in IST (e.g. "6 Mar 2026, 2:45 PM IST").
 */
function formatAlertTimestamp(isoTimestamp: string): string {
  try {
    const date = new Date(isoTimestamp);
    return date.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'medium',
      timeStyle: 'short',
    }) + ' IST';
  } catch {
    return isoTimestamp;
  }
}

// ============================================================================
// Alert email design system — shared shell + primitives.
// Rules for cross-client compatibility (Gmail / Outlook / Apple Mail):
//   • table-based layout, everything inline-styled
//   • no flexbox, no grid, no web fonts, no dark-mode variants
//   • max width 600px; single column; graceful degradation on narrow screens
// ============================================================================
const ACCENT_BULL = '#10b981';
const ACCENT_BEAR = '#ef4444';
const ACCENT_BRAND = '#1f6dff';
const INK = '#0f172a';
const INK_2 = '#475569';
const MUTED = '#64748b';
const BORDER = '#e6ebf2';
const SURFACE = '#ffffff';
const SURFACE_2 = '#f1f5f9';
const PAGE_BG = '#eef2f8';
const BULL_TINT = '#ecfdf5';
const BEAR_TINT = '#fef2f2';
const BULL_TINT_BORDER = '#bbf7d0';
const BEAR_TINT_BORDER = '#fecaca';
const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const MONO = "SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

// Public app URL for the logo image + CTA link. Override with NEXT_PUBLIC_APP_URL.
const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || 'https://signalstack-105d.onrender.com').replace(/\/+$/, '');
const LOGO_URL = `${APP_URL}/app-icon-512.png`;
const CURRENCY_SYMBOL: Record<string, string> = { INR: '₹', USD: '$', GBP: '£', EUR: '€', JPY: '¥' };

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtNum(v: number): string {
  return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function money(v: number, currency: string): string {
  const sym = CURRENCY_SYMBOL[currency];
  return sym ? `${sym}${fmtNum(v)}` : `${currency} ${fmtNum(v)}`;
}

/** Accent-filled CTA button (bulletproof: table cell holds the color). */
function ctaButton(label: string, url: string, accent: string): string {
  return `
        <tr>
          <td style="padding:16px 28px 4px 28px;">
            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
              <td style="border-radius:11px;background:${accent};">
                <a href="${url}" target="_blank" style="display:inline-block;padding:13px 24px;font-family:${FONT_STACK};font-size:13.5px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:11px;">${escapeHtml(label)} &nbsp;&rarr;</a>
              </td>
            </tr></table>
          </td>
        </tr>`;
}

/**
 * Premium alert email shell. Composes: gradient bar → brand header → a
 * direction-tinted hero (badge + symbol + big price) → type-specific body →
 * CTA → footer. `bodyRows` is type-specific `<tr>…</tr>` content.
 */
function renderAlertEmail(opts: {
  direction: 'bullish' | 'bearish';
  eyebrow: string;      // "Bullish crossover", "RSI overbought cross", …
  symbol: string;
  subtitle: string;     // small line under the symbol
  timeframe: string;
  heroLabel: string;    // e.g. "Price at signal"
  heroValue: string;    // e.g. "₹1,307.30" (pre-formatted)
  bodyRows: string;
  timeStr: string;
}): string {
  const bull = opts.direction === 'bullish';
  const accent = bull ? ACCENT_BULL : ACCENT_BEAR;
  const tint = bull ? BULL_TINT : BEAR_TINT;
  const tintBorder = bull ? BULL_TINT_BORDER : BEAR_TINT_BORDER;
  const arrow = bull ? '&#9650;' : '&#9660;'; // ▲ / ▼
  const stripe = bull
    ? 'linear-gradient(90deg,#10b981,#0bb5d6)'
    : 'linear-gradient(90deg,#ef4444,#f59e0b)';
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${escapeHtml(opts.eyebrow)} · ${escapeHtml(opts.symbol)}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE_BG};font-family:${FONT_STACK};color:${INK};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE_BG};">
  <tr>
    <td align="center" style="padding:28px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${SURFACE};border:1px solid ${BORDER};border-radius:18px;overflow:hidden;box-shadow:0 8px 28px rgba(15,23,42,.10);">
        <tr>
          <td style="height:5px;background:${accent};background:${stripe};line-height:5px;font-size:0;">&nbsp;</td>
        </tr>

        <!-- brand header -->
        <tr>
          <td style="padding:18px 28px 4px 28px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
              <td style="vertical-align:middle;">
                <img src="${LOGO_URL}" width="26" height="26" alt="" style="vertical-align:middle;border-radius:7px;display:inline-block;">
                <span style="vertical-align:middle;margin-left:9px;font-size:16px;font-weight:800;color:${INK};letter-spacing:-.01em;">Signal<span style="color:${ACCENT_BRAND};">Stack</span></span>
              </td>
              <td align="right" style="vertical-align:middle;font-size:10px;font-weight:700;letter-spacing:.12em;color:${MUTED};text-transform:uppercase;">Real-time alert</td>
            </tr></table>
          </td>
        </tr>

        <!-- hero -->
        <tr>
          <td style="padding:10px 28px 4px 28px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${tint};border:1px solid ${tintBorder};border-radius:16px;">
              <tr><td style="padding:20px 20px 20px 20px;">
                <span style="display:inline-block;padding:6px 12px;border-radius:999px;background:${accent};color:#ffffff;font-size:11px;font-weight:800;letter-spacing:.05em;">${arrow}&nbsp; ${escapeHtml(opts.eyebrow.toUpperCase())}</span>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;"><tr>
                  <td style="vertical-align:bottom;">
                    <div style="font-size:32px;font-weight:800;color:${INK};letter-spacing:-.02em;line-height:1;">${escapeHtml(opts.symbol)}</div>
                    <div style="font-size:12px;color:${MUTED};margin-top:5px;">${escapeHtml(opts.subtitle)}</div>
                  </td>
                  <td align="right" style="vertical-align:bottom;">
                    <span style="display:inline-block;padding:5px 11px;border-radius:8px;background:#ffffff;border:1px solid ${tintBorder};font-family:${MONO};font-size:12px;font-weight:700;color:${INK_2};">${escapeHtml(opts.timeframe)}</span>
                  </td>
                </tr></table>
                <div style="margin-top:20px;font-size:10.5px;font-weight:700;letter-spacing:.06em;color:${MUTED};text-transform:uppercase;">${escapeHtml(opts.heroLabel)}</div>
                <div style="font-family:${MONO};font-size:36px;font-weight:800;color:${accent};margin-top:3px;line-height:1;">${opts.heroValue}</div>
              </td></tr>
            </table>
          </td>
        </tr>

        ${opts.bodyRows}
        ${ctaButton('View in SignalStack', APP_URL, accent)}

        <!-- footer -->
        <tr>
          <td style="padding:20px 28px 24px 28px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${BORDER};">
              <tr>
                <td style="padding-top:14px;font-size:11px;color:${MUTED};">${escapeHtml(opts.timeStr)}</td>
                <td align="right" style="padding-top:14px;font-size:11px;color:${MUTED};">EMA · RSI alerts</td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/** EMA fast/slow value cards + plain crossover sentence. */
function renderCrossoverBody(alert: {
  crossoverType: 'bullish' | 'bearish';
  fastPeriod: number;
  slowPeriod: number;
  fastEmaValue: number;
  slowEmaValue: number;
}): string {
  const bull = alert.crossoverType === 'bullish';
  const accent = bull ? ACCENT_BULL : ACCENT_BEAR;
  const dir = bull ? 'above' : 'below';
  const arrow = bull ? '&#9650;' : '&#9660;';
  const fastTint = bull ? BULL_TINT : BEAR_TINT;
  const fastBorder = bull ? BULL_TINT_BORDER : BEAR_TINT_BORDER;
  const card = (label: string, period: number, val: number, bg: string, border: string) => `
      <td width="44%" style="background:${bg};border:1px solid ${border};border-radius:12px;padding:12px 14px;">
        <div style="font-size:10px;font-weight:800;letter-spacing:.06em;color:${MUTED};text-transform:uppercase;">${label} &middot; EMA ${period}</div>
        <div style="font-family:${MONO};font-size:20px;font-weight:800;color:${INK};margin-top:6px;">${fmtNum(val)}</div>
      </td>`;
  return `
        <tr>
          <td style="padding:18px 28px 2px 28px;">
            <div style="font-size:11px;font-weight:800;letter-spacing:.06em;color:${MUTED};text-transform:uppercase;margin-bottom:11px;">The crossover</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
              ${card('Fast', alert.fastPeriod, alert.fastEmaValue, fastTint, fastBorder)}
              <td width="12%" align="center" style="vertical-align:middle;">
                <div style="width:30px;height:30px;line-height:30px;border-radius:15px;background:${accent};color:#ffffff;font-size:12px;font-weight:800;text-align:center;margin:0 auto;">${arrow}</div>
              </td>
              ${card('Slow', alert.slowPeriod, alert.slowEmaValue, SURFACE_2, BORDER)}
            </tr></table>
            <div style="margin-top:14px;font-size:13.5px;color:${INK_2};line-height:1.5;">
              EMA <strong style="color:${INK};">${alert.fastPeriod}</strong> crossed <strong style="color:${accent};">${dir}</strong> EMA <strong style="color:${INK};">${alert.slowPeriod}</strong>
            </div>
          </td>
        </tr>`;
}

/** RSI value + horizontal gauge with OB/OS markers. */
function renderRsiBody(alert: {
  signalType: string;
  direction: 'bullish' | 'bearish';
  rsiValue: number;
  previousRsi: number;
  period: number;
  overbought: number;
  oversold: number;
}, signalLabel: string): string {
  const accent = alert.direction === 'bullish' ? ACCENT_BULL : ACCENT_BEAR;
  const rsi = Math.max(0, Math.min(100, alert.rsiValue));
  const fillPct = rsi.toFixed(1);
  const restPct = (100 - rsi).toFixed(1);
  return `
        <tr>
          <td style="padding:18px 28px 2px 28px;">
            <div style="font-size:11px;font-weight:800;letter-spacing:.06em;color:${MUTED};text-transform:uppercase;margin-bottom:11px;">${escapeHtml(signalLabel)}</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
              <td style="vertical-align:bottom;">
                <span style="font-family:${MONO};font-size:30px;font-weight:800;color:${accent};">${alert.rsiValue.toFixed(1)}</span>
                <span style="font-size:12px;color:${MUTED};font-family:${MONO};">&nbsp;RSI(${alert.period})</span>
              </td>
              <td align="right" style="vertical-align:bottom;font-size:12px;color:${MUTED};font-family:${MONO};">prev ${alert.previousRsi.toFixed(1)}</td>
            </tr></table>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;border-radius:999px;overflow:hidden;"><tr>
              <td width="${fillPct}%" style="background:${accent};height:8px;font-size:0;line-height:8px;">&nbsp;</td>
              <td width="${restPct}%" style="background:${SURFACE_2};height:8px;font-size:0;line-height:8px;">&nbsp;</td>
            </tr></table>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;"><tr>
              <td style="font-size:10px;color:${MUTED};font-family:${MONO};">0</td>
              <td align="center" style="font-size:10px;color:${MUTED};font-family:${MONO};">OS ${alert.oversold}</td>
              <td align="center" style="font-size:10px;color:${MUTED};font-family:${MONO};">OB ${alert.overbought}</td>
              <td align="right" style="font-size:10px;color:${MUTED};font-family:${MONO};">100</td>
            </tr></table>
          </td>
        </tr>`;
}

/**
 * Send crossover alert emails to BREVO_ALERT_TO and optionally to the signed-in user's email.
 * @param alert - Crossover alert payload
 * @param userEmail - Optional: Clerk user's email (signed-in user who is monitoring)
 */
export async function sendCrossoverAlertEmail(
  alert: {
    symbol: string;
    timeframe: string;
    crossoverType: 'bullish' | 'bearish';
    fastPeriod: number;
    slowPeriod: number;
    fastEmaValue: number;
    slowEmaValue: number;
    price: number;
    currency: string;
    timestamp: string;
    ohlcContext?: string;
  },
  userEmail?: string | null,
  attachments?: EmailAttachment[],
): Promise<void> {
  if (!isMarketOpen('NSE')) {
    console.warn(
      `[market-closed] Email crossover alert suppressed: ${alert.symbol} ${alert.crossoverType} @ ${alert.timestamp}`,
    );
    return;
  }
  const envRecipients = getAlertRecipientEmails();
  const recipients = [...envRecipients];
  if (userEmail && !recipients.includes(userEmail.toLowerCase())) {
    recipients.push(userEmail.toLowerCase());
  }
  if (recipients.length === 0) return;
  if (!isBrevoConfigured()) return;

  const timeStr = formatAlertTimestamp(alert.timestamp);
  const emoji = alert.crossoverType === 'bullish' ? '📈' : '📉';
  const direction = alert.crossoverType === 'bullish' ? 'Bullish' : 'Bearish';
  const subject = `${emoji} ${direction} Crossover: ${alert.symbol} (${alert.timeframe})`;

  const ohlcText = alert.ohlcContext ? `\n${alert.ohlcContext}\n` : '';
  const text =
    `${direction} crossover detected.\n` +
    `Symbol: ${alert.symbol} · Timeframe: ${alert.timeframe}\n` +
    `EMA(${alert.fastPeriod}) crossed ${alert.crossoverType === 'bullish' ? 'above' : 'below'} EMA(${alert.slowPeriod})\n` +
    `Price at signal: ${alert.currency} ${alert.price}\n` +
    ohlcText +
    `Time: ${timeStr}`;

  const html = renderAlertEmail({
    direction: alert.crossoverType,
    eyebrow: `${direction} crossover`,
    symbol: alert.symbol,
    subtitle: `EMA ${alert.fastPeriod}/${alert.slowPeriod} crossover`,
    timeframe: alert.timeframe,
    heroLabel: 'Price at signal',
    heroValue: money(alert.price, alert.currency),
    bodyRows: renderCrossoverBody(alert),
    timeStr,
  });

  const result = await sendEmail({ to: recipients, subject, text, html, attachments });
  if (!result.ok) console.warn('Brevo crossover alert email failed:', result.error);
}

export interface DaySummaryItem {
  symbol: string;
  currency: string;
  todayOpen: number;
  todayHigh: number;
  todayLow: number;
  todayClose: number;
  yesterdayHigh: number | null;
  yesterdayLow: number | null;
}

export async function sendEndOfDaySummaryEmail(
  to: string,
  items: DaySummaryItem[],
  date: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!isBrevoConfigured() || items.length === 0) return { ok: false, error: 'Not configured or no items' };

  const cur = (c: string) => ({ USD: '$', INR: '₹', GBP: '£', JPY: '¥', EUR: '€' } as Record<string, string>)[c] || c;

  const subject = `📊 Market Day Summary — ${date}`;

  const rows = items.map((s) => {
    const c = cur(s.currency);
    const yHigh = s.yesterdayHigh != null ? `${c}${s.yesterdayHigh.toFixed(2)}` : '—';
    const yLow = s.yesterdayLow != null ? `${c}${s.yesterdayLow.toFixed(2)}` : '—';
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600">${s.symbol}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">${c}${s.todayOpen.toFixed(2)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">${c}${s.todayHigh.toFixed(2)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">${c}${s.todayLow.toFixed(2)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:600">${c}${s.todayClose.toFixed(2)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;color:#888">${yHigh}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;color:#888">${yLow}</td>
    </tr>`;
  }).join('');

  const textRows = items.map((s) => {
    const c = cur(s.currency);
    const yH = s.yesterdayHigh != null ? `${c}${s.yesterdayHigh.toFixed(2)}` : '—';
    const yL = s.yesterdayLow != null ? `${c}${s.yesterdayLow.toFixed(2)}` : '—';
    return `${s.symbol}: Open ${c}${s.todayOpen.toFixed(2)} | High ${c}${s.todayHigh.toFixed(2)} | Low ${c}${s.todayLow.toFixed(2)} | Close ${c}${s.todayClose.toFixed(2)} | Prev High ${yH} | Prev Low ${yL}`;
  }).join('\n');

  const html = `
    <div style="font-family:-apple-system,system-ui,sans-serif;max-width:720px;margin:0 auto">
      <h2 style="margin:0 0 4px;font-size:18px">Market Day Summary</h2>
      <p style="margin:0 0 16px;color:#666;font-size:13px">${date}</p>
      <table style="border-collapse:collapse;width:100%;font-size:13px">
        <thead>
          <tr style="background:#f8f9fa">
            <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #dee2e6">Symbol</th>
            <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #dee2e6">Open</th>
            <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #dee2e6">High</th>
            <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #dee2e6">Low</th>
            <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #dee2e6">Close</th>
            <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #dee2e6;color:#888">Prev High</th>
            <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #dee2e6;color:#888">Prev Low</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin:16px 0 0;font-size:11px;color:#999">Sent by SignalStack</p>
    </div>`;

  const text = `Market Day Summary — ${date}\n\n${textRows}`;

  return sendEmail({ to, subject, text, html });
}

const RSI_SIGNAL_LABEL: Record<string, string> = {
  overboughtCross: 'Overbought cross',
  oversoldCross: 'Oversold cross',
  thresholdBreach: 'Threshold breach',
  centerlineCross: 'Centerline (50) cross',
  signalLineCross: 'Signal line cross',
};

/**
 * Send RSI alert emails.
 */
export async function sendRsiAlertEmail(
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
    signalLineLength?: number;
    price: number;
    currency: string;
    timestamp: string;
    ohlcContext?: string;
  },
  userEmail?: string | null,
): Promise<void> {
  if (!isMarketOpen('NSE')) {
    console.warn(
      `[market-closed] Email RSI alert suppressed: ${alert.symbol} ${alert.signalType} @ ${alert.timestamp}`,
    );
    return;
  }
  const envRecipients = getAlertRecipientEmails();
  const recipients = [...envRecipients];
  if (userEmail && !recipients.includes(userEmail.toLowerCase())) {
    recipients.push(userEmail.toLowerCase());
  }
  if (recipients.length === 0) return;
  if (!isBrevoConfigured()) return;

  const timeStr = formatAlertTimestamp(alert.timestamp);
  const emoji = alert.direction === 'bullish' ? '📈' : '📉';
  const signalLabel = RSI_SIGNAL_LABEL[alert.signalType] ?? alert.signalType;
  const subject = `${emoji} RSI ${signalLabel}: ${alert.symbol} (${alert.timeframe})`;

  const ohlcText = alert.ohlcContext ? `\n${alert.ohlcContext}\n` : '';
  const text =
    `RSI ${signalLabel} (${alert.direction}) detected.\n` +
    `Symbol: ${alert.symbol} · Timeframe: ${alert.timeframe}\n` +
    `RSI(${alert.period}) = ${alert.rsiValue.toFixed(2)} (previous ${alert.previousRsi.toFixed(2)})\n` +
    `Thresholds: overbought ${alert.overbought} / oversold ${alert.oversold}\n` +
    `Price at signal: ${alert.currency} ${alert.price}\n` +
    ohlcText +
    `Time: ${timeStr}`;

  const html = renderAlertEmail({
    direction: alert.direction,
    eyebrow: `RSI ${signalLabel}`,
    symbol: alert.symbol,
    subtitle: `RSI ${alert.period} signal`,
    timeframe: alert.timeframe,
    heroLabel: 'Price at signal',
    heroValue: money(alert.price, alert.currency),
    bodyRows: renderRsiBody(alert, signalLabel),
    timeStr,
  });

  const result = await sendEmail({ to: recipients, subject, text, html });
  if (!result.ok) console.warn('Brevo RSI alert email failed:', result.error);
}

const LEVEL_LABEL_EMAIL: Record<'high' | 'low' | 'close', string> = {
  high: 'prev day high',
  low: 'prev day low',
  close: 'prev day close',
};

/** Prev-day level-cross email — fired once when price crosses a prev-day level. */
export async function sendLevelCrossAlertEmail(
  alert: {
    symbol: string;
    timeframe: string;
    level: 'high' | 'low' | 'close';
    crossDirection: 'above' | 'below';
    levelValue: number;
    price: number;
    currency: string;
    timestamp: string;
  },
  userEmail?: string | null,
): Promise<void> {
  if (!isMarketOpen('NSE')) {
    console.warn(
      `[market-closed] Email level-cross alert suppressed: ${alert.symbol} ${alert.crossDirection} ${alert.level} @ ${alert.timestamp}`,
    );
    return;
  }
  const envRecipients = getAlertRecipientEmails();
  const recipients = [...envRecipients];
  if (userEmail && !recipients.includes(userEmail.toLowerCase())) {
    recipients.push(userEmail.toLowerCase());
  }
  if (recipients.length === 0) return;
  if (!isBrevoConfigured()) return;

  const timeStr = formatAlertTimestamp(alert.timestamp);
  const label = LEVEL_LABEL_EMAIL[alert.level];
  const dir = alert.crossDirection === 'above' ? 'bullish' : 'bearish';
  const accent = dir === 'bullish' ? ACCENT_BULL : ACCENT_BEAR;
  const tint = dir === 'bullish' ? BULL_TINT : BEAR_TINT;
  const tintBorder = dir === 'bullish' ? BULL_TINT_BORDER : BEAR_TINT_BORDER;
  const arrow = alert.crossDirection === 'above' ? '⬆️' : '⬇️';
  const subject = `${arrow} ${alert.symbol}: crossed ${alert.crossDirection} ${label} (${alert.timeframe})`;
  const priceLine = money(alert.price, alert.currency);
  const levelStr = money(alert.levelValue, alert.currency);

  const text =
    `${alert.symbol} crossed ${alert.crossDirection} ${label}.\n` +
    `Symbol: ${alert.symbol} · Timeframe: ${alert.timeframe}\n` +
    `Level (${label}): ${levelStr}\n` +
    `Price: ${priceLine}\n` +
    `Time: ${timeStr}`;

  const bodyRows = `
        <tr>
          <td style="padding:18px 28px 2px 28px;">
            <div style="font-size:11px;font-weight:800;letter-spacing:.06em;color:${MUTED};text-transform:uppercase;margin-bottom:11px;">The level break</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
              <td width="48%" style="background:${tint};border:1px solid ${tintBorder};border-radius:12px;padding:12px 14px;">
                <div style="font-size:10px;font-weight:800;letter-spacing:.06em;color:${MUTED};text-transform:uppercase;">${escapeHtml(label)}</div>
                <div style="font-family:${MONO};font-size:20px;font-weight:800;color:${INK};margin-top:6px;">${levelStr}</div>
              </td>
              <td width="4%">&nbsp;</td>
              <td width="48%" style="background:${SURFACE_2};border:1px solid ${BORDER};border-radius:12px;padding:12px 14px;">
                <div style="font-size:10px;font-weight:800;letter-spacing:.06em;color:${MUTED};text-transform:uppercase;">Price now</div>
                <div style="font-family:${MONO};font-size:20px;font-weight:800;color:${accent};margin-top:6px;">${priceLine}</div>
              </td>
            </tr></table>
            <div style="margin-top:14px;font-size:13.5px;color:${INK_2};line-height:1.5;">
              Price crossed <strong style="color:${accent};">${alert.crossDirection}</strong> ${escapeHtml(label)}
            </div>
          </td>
        </tr>`;

  const html = renderAlertEmail({
    direction: dir,
    eyebrow: `Crossed ${alert.crossDirection} ${label}`,
    symbol: alert.symbol,
    subtitle: `Prev-day ${alert.level} break`,
    timeframe: alert.timeframe,
    heroLabel: 'Price now',
    heroValue: priceLine,
    bodyRows,
    timeStr,
  });

  const result = await sendEmail({ to: recipients, subject, text, html });
  if (!result.ok) console.warn('Brevo level-cross alert email failed:', result.error);
}
