/**
 * Brevo email: API (preferred) or SMTP.
 * - API: set BREVO_API_KEY (Brevo → Settings → SMTP & API → API keys). Same account as dashboard; credits decrement.
 * - SMTP: set BREVO_SMTP_USER + BREVO_SMTP_PASS (SMTP key from same page).
 * Optional: BREVO_FROM_EMAIL, BREVO_ALERT_TO.
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { isMarketOpen } from './marketHours';
import type { DaySummary } from './daySummary';

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
const INK = '#0f172a';
const INK_2 = '#475569';
const MUTED = '#64748b';
const BORDER = '#e2e8f0';
const SURFACE = '#ffffff';
const SURFACE_2 = '#f6f8fc';
const CARD_BG = '#fafbfd';
const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const MONO = "SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

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

/**
 * Structured day-levels section: prev-day O/H/L/C as labeled stat cells,
 * today's open with a colored gap chip, and a one-line status badge. Falls
 * back to a muted single-line note when the summary is missing (fetch failed)
 * so the section is never silently dropped.
 */
function renderDayLevels(
  daySummary: DaySummary | null | undefined,
  price: number,
): string {
  const y = daySummary?.yesterday;
  const todayOpen = daySummary?.today?.open;
  const valid =
    y && Number.isFinite(y.open) && Number.isFinite(y.high) &&
    Number.isFinite(y.low) && Number.isFinite(y.close) &&
    Number.isFinite(todayOpen ?? NaN) && (todayOpen as number) > 0;

  if (!valid) {
    return `
    <tr>
      <td style="padding:14px 24px 4px 24px;">
        <div style="font-size:12px;color:${MUTED};font-style:italic;">OHLC data unavailable for this alert.</div>
      </td>
    </tr>`;
  }

  const gapPct = ((todayOpen as number) - y.close) / y.close * 100;
  const gapUp = gapPct >= 0;
  const gapColor = gapUp ? ACCENT_BULL : ACCENT_BEAR;
  const gapStr = `${gapUp ? '+' : ''}${gapPct.toFixed(2)}%`;

  let statusTxt: string;
  let statusColor: string;
  if (price > y.high) { statusTxt = 'Above prev day high'; statusColor = ACCENT_BULL; }
  else if (price < y.low) { statusTxt = 'Below prev day low'; statusColor = ACCENT_BEAR; }
  else if (price > y.close) { statusTxt = 'Above prev day close'; statusColor = ACCENT_BULL; }
  else if (price < y.close) { statusTxt = 'Below prev day close'; statusColor = ACCENT_BEAR; }
  else { statusTxt = 'At prev day close'; statusColor = INK_2; }

  const cell = (label: string, value: number) => `
    <td width="25%" style="padding:8px 6px;text-align:center;background:${SURFACE_2};border:1px solid ${BORDER};">
      <div style="font-size:10px;font-weight:700;color:${MUTED};letter-spacing:.05em;">${label}</div>
      <div style="font-family:${MONO};font-size:13px;font-weight:700;color:${INK};margin-top:2px;">${fmtNum(value)}</div>
    </td>`;

  return `
    <tr>
      <td style="padding:16px 24px 4px 24px;">
        <div style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:${MUTED};margin-bottom:8px;">Previous day</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:4px 0;">
          <tr>
            ${cell('OPEN', y.open)}
            ${cell('HIGH', y.high)}
            ${cell('LOW', y.low)}
            ${cell('CLOSE', y.close)}
          </tr>
        </table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px;">
          <tr>
            <td style="font-size:12.5px;color:${INK_2};">
              Today open&nbsp;
              <span style="font-family:${MONO};font-weight:700;color:${INK};">${fmtNum(todayOpen as number)}</span>
              &nbsp;<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-family:${MONO};font-size:11px;font-weight:700;color:#ffffff;background:${gapColor};">${gapStr}</span>
            </td>
            <td align="right" style="font-size:12.5px;font-weight:700;color:${statusColor};white-space:nowrap;">
              ● ${statusTxt}
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

/**
 * Renders the standard alert email shell. `bodyRows` is a string of `<tr>…</tr>`
 * blocks slotted into the main card between the header and the OHLC callout.
 */
function renderAlertEmail(opts: {
  direction: 'bullish' | 'bearish';
  eyebrow: string;   // e.g. "Bullish crossover" or "RSI Overbought cross"
  symbol: string;
  timeframe: string;
  bodyRows: string;  // main content rows
  daySummary?: DaySummary | null;
  price: number;
  timeStr: string;
}): string {
  const accent = opts.direction === 'bullish' ? ACCENT_BULL : ACCENT_BEAR;
  // Gradient top stripe. Solid `background` first as fallback for Outlook
  // desktop (Word engine ignores linear-gradient and uses the solid color).
  const stripeGradient =
    opts.direction === 'bullish'
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
<body style="margin:0;padding:0;background:${SURFACE_2};font-family:${FONT_STACK};color:${INK};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SURFACE_2};">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${SURFACE};border:1px solid ${BORDER};border-radius:14px;overflow:hidden;box-shadow:0 1px 2px rgba(15,23,42,.04);">
        <tr>
          <td style="height:4px;background:${accent};background:${stripeGradient};line-height:4px;font-size:0;">&nbsp;</td>
        </tr>
        <tr>
          <td style="padding:20px 24px 8px 24px;">
            <div style="font-size:11.5px;font-weight:700;color:${accent};letter-spacing:.08em;text-transform:uppercase;">
              ${escapeHtml(opts.eyebrow)}
            </div>
            <div style="margin-top:6px;">
              <span style="font-size:26px;font-weight:800;color:${INK};letter-spacing:-.01em;">${escapeHtml(opts.symbol)}</span>
              <span style="display:inline-block;margin-left:8px;padding:3px 8px;border-radius:999px;background:${SURFACE_2};border:1px solid ${BORDER};font-family:${MONO};font-size:11px;font-weight:700;color:${INK_2};vertical-align:middle;">${escapeHtml(opts.timeframe)}</span>
            </div>
          </td>
        </tr>
        ${opts.bodyRows}
        ${renderDayLevels(opts.daySummary, opts.price)}
        <tr>
          <td style="padding:16px 24px 18px 24px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${BORDER};">
              <tr>
                <td style="padding-top:12px;font-size:11px;color:${MUTED};">${escapeHtml(opts.timeStr)}</td>
                <td align="right" style="padding-top:12px;font-size:11px;color:${MUTED};">SignalStack</td>
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

function renderCrossoverBody(alert: {
  crossoverType: 'bullish' | 'bearish';
  fastPeriod: number;
  slowPeriod: number;
  price: number;
  currency: string;
}): string {
  const accent = alert.crossoverType === 'bullish' ? ACCENT_BULL : ACCENT_BEAR;
  const dir = alert.crossoverType === 'bullish' ? 'above' : 'below';
  const priceLine = `${escapeHtml(alert.currency)} ${alert.price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `
        <tr>
          <td style="padding:8px 24px 4px 24px;">
            <div style="font-size:14px;color:${INK_2};line-height:1.5;">
              EMA(<strong style="color:${INK};">${alert.fastPeriod}</strong>) crossed <strong style="color:${accent};">${dir}</strong> EMA(<strong style="color:${INK};">${alert.slowPeriod}</strong>)
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:12px 24px 8px 24px;">
            <div style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:${MUTED};">Price at signal</div>
            <div style="font-family:${MONO};font-size:22px;font-weight:800;color:${accent};margin-top:4px;">${priceLine}</div>
          </td>
        </tr>`;
}

function renderRsiBody(alert: {
  signalType: string;
  direction: 'bullish' | 'bearish';
  rsiValue: number;
  previousRsi: number;
  period: number;
  overbought: number;
  oversold: number;
  price: number;
  currency: string;
}, signalLabel: string): string {
  const accent = alert.direction === 'bullish' ? ACCENT_BULL : ACCENT_BEAR;
  const priceLine = `${escapeHtml(alert.currency)} ${alert.price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `
        <tr>
          <td style="padding:8px 24px 4px 24px;">
            <div style="font-size:14px;color:${INK_2};line-height:1.5;">
              <strong style="color:${INK};">${escapeHtml(signalLabel)}</strong>
              <span style="color:${MUTED};">·</span>
              RSI(<strong style="color:${INK};">${alert.period}</strong>)
              <span style="color:${MUTED};">=</span>
              <strong style="color:${accent};font-family:${MONO};">${alert.rsiValue.toFixed(2)}</strong>
              <span style="color:${MUTED};font-family:${MONO};font-size:12px;">(prev ${alert.previousRsi.toFixed(2)})</span>
            </div>
            <div style="font-size:12px;color:${MUTED};margin-top:6px;font-family:${MONO};">
              overbought ${alert.overbought} / oversold ${alert.oversold}
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:12px 24px 8px 24px;">
            <div style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:${MUTED};">Price at signal</div>
            <div style="font-family:${MONO};font-size:22px;font-weight:800;color:${accent};margin-top:4px;">${priceLine}</div>
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
    price: number;
    currency: string;
    timestamp: string;
    ohlcContext?: string;
  },
  userEmail?: string | null,
  attachments?: EmailAttachment[],
  daySummary?: DaySummary | null,
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
    timeframe: alert.timeframe,
    bodyRows: renderCrossoverBody(alert),
    daySummary,
    price: alert.price,
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
  daySummary?: DaySummary | null,
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
    timeframe: alert.timeframe,
    bodyRows: renderRsiBody(alert, signalLabel),
    daySummary,
    price: alert.price,
    timeStr,
  });

  const result = await sendEmail({ to: recipients, subject, text, html });
  if (!result.ok) console.warn('Brevo RSI alert email failed:', result.error);
}
