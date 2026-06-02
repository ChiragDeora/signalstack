/**
 * Brevo email: API (preferred) or SMTP.
 * - API: set BREVO_API_KEY (Brevo → Settings → SMTP & API → API keys). Same account as dashboard; credits decrement.
 * - SMTP: set BREVO_SMTP_USER + BREVO_SMTP_PASS (SMTP key from same page).
 * Optional: BREVO_FROM_EMAIL, BREVO_ALERT_TO.
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

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
  },
  userEmail?: string | null,
  attachments?: EmailAttachment[],
): Promise<void> {
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
  const text =
    `${direction} crossover detected.\n` +
    `Symbol: ${alert.symbol}\n` +
    `Timeframe: ${alert.timeframe}\n` +
    `EMA(${alert.fastPeriod}) crossed ${alert.crossoverType === 'bullish' ? 'above' : 'below'} EMA(${alert.slowPeriod})\n` +
    `Price: ${alert.currency} ${alert.price}\n` +
    `Time: ${timeStr}`;
  const html =
    `<p><strong>${direction} crossover</strong></p>` +
    `<p>Symbol: <strong>${alert.symbol}</strong> · Timeframe: ${alert.timeframe}</p>` +
    `<p>EMA(${alert.fastPeriod}) crossed ${alert.crossoverType === 'bullish' ? 'above' : 'below'} EMA(${alert.slowPeriod}) at ${alert.currency} ${alert.price}</p>` +
    `<p><small>${timeStr}</small></p>`;

  const result = await sendEmail({ to: recipients, subject, text, html, attachments });
  if (!result.ok) console.warn('Brevo crossover alert email failed:', result.error);
}

const RSI_SIGNAL_LABEL: Record<string, string> = {
  overboughtCross: 'Overbought cross',
  oversoldCross: 'Oversold cross',
  thresholdBreach: 'Threshold breach',
  centerlineCross: 'Centerline (50) cross',
};

/**
 * Send RSI alert emails.
 */
export async function sendRsiAlertEmail(
  alert: {
    symbol: string;
    timeframe: string;
    signalType: 'overboughtCross' | 'oversoldCross' | 'thresholdBreach' | 'centerlineCross';
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
  userEmail?: string | null,
): Promise<void> {
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
  const text =
    `RSI ${signalLabel} (${alert.direction}) detected.\n` +
    `Symbol: ${alert.symbol}\n` +
    `Timeframe: ${alert.timeframe}\n` +
    `RSI(${alert.period}) = ${alert.rsiValue.toFixed(2)} (previous ${alert.previousRsi.toFixed(2)})\n` +
    `Thresholds: overbought ${alert.overbought} / oversold ${alert.oversold}\n` +
    `Price: ${alert.currency} ${alert.price}\n` +
    `Time: ${timeStr}`;
  const html =
    `<p><strong>RSI ${signalLabel}</strong> (${alert.direction})</p>` +
    `<p>Symbol: <strong>${alert.symbol}</strong> · Timeframe: ${alert.timeframe}</p>` +
    `<p>RSI(${alert.period}) = <strong>${alert.rsiValue.toFixed(2)}</strong> (previous ${alert.previousRsi.toFixed(2)})</p>` +
    `<p>Thresholds — overbought ${alert.overbought}, oversold ${alert.oversold}</p>` +
    `<p>Price at signal: ${alert.currency} ${alert.price}</p>` +
    `<p><small>${timeStr}</small></p>`;

  const result = await sendEmail({ to: recipients, subject, text, html });
  if (!result.ok) console.warn('Brevo RSI alert email failed:', result.error);
}
