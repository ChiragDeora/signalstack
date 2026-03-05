/**
 * Brevo SMTP email service for relay and notifications.
 * Set BREVO_SMTP_USER (login email) and BREVO_SMTP_PASS (SMTP key) in env.
 * Optional: BREVO_ALERT_TO = comma-separated emails to receive crossover alerts.
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

const BREVO_HOST = process.env.BREVO_SMTP_HOST || 'smtp-relay.brevo.com';
const BREVO_PORT = parseInt(process.env.BREVO_SMTP_PORT || '587', 10);
const BREVO_USER = process.env.BREVO_SMTP_USER || '';
const BREVO_PASS = process.env.BREVO_SMTP_PASS || '';
const BREVO_FROM = process.env.BREVO_FROM_EMAIL || process.env.BREVO_SMTP_USER || 'alerts@signalstack.app';

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (transporter) return transporter;
  if (!BREVO_USER || !BREVO_PASS) return null;
  try {
    transporter = nodemailer.createTransport({
      host: BREVO_HOST,
      port: BREVO_PORT,
      secure: BREVO_PORT === 465,
      auth: { user: BREVO_USER, pass: BREVO_PASS },
    });
    return transporter;
  } catch {
    return null;
  }
}

export function isBrevoConfigured(): boolean {
  return !!(BREVO_USER && BREVO_PASS);
}

/**
 * Send a single email (relay). Use for transactional or custom emails.
 */
export async function sendEmail(options: {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const trans = getTransporter();
  if (!trans) {
    return { ok: false, error: 'Brevo SMTP not configured (set BREVO_SMTP_USER and BREVO_SMTP_PASS)' };
  }
  const to = Array.isArray(options.to) ? options.to.join(', ') : options.to;
  try {
    await trans.sendMail({
      from: BREVO_FROM,
      to,
      subject: options.subject,
      text: options.text,
      html: options.html,
      replyTo: options.replyTo,
    });
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
): Promise<void> {
  const envRecipients = getAlertRecipientEmails();
  const recipients = [...envRecipients];
  if (userEmail && !recipients.includes(userEmail.toLowerCase())) {
    recipients.push(userEmail.toLowerCase());
  }
  if (recipients.length === 0) return;
  if (!isBrevoConfigured()) return;

  const emoji = alert.crossoverType === 'bullish' ? '📈' : '📉';
  const direction = alert.crossoverType === 'bullish' ? 'Bullish' : 'Bearish';
  const subject = `${emoji} ${direction} Crossover: ${alert.symbol} (${alert.timeframe})`;
  const text =
    `${direction} crossover detected.\n` +
    `Symbol: ${alert.symbol}\n` +
    `Timeframe: ${alert.timeframe}\n` +
    `EMA(${alert.fastPeriod}) crossed ${alert.crossoverType === 'bullish' ? 'above' : 'below'} EMA(${alert.slowPeriod})\n` +
    `Price: ${alert.currency} ${alert.price}\n` +
    `Time: ${alert.timestamp}`;
  const html =
    `<p><strong>${direction} crossover</strong></p>` +
    `<p>Symbol: <strong>${alert.symbol}</strong> · Timeframe: ${alert.timeframe}</p>` +
    `<p>EMA(${alert.fastPeriod}) crossed ${alert.crossoverType === 'bullish' ? 'above' : 'below'} EMA(${alert.slowPeriod}) at ${alert.currency} ${alert.price}</p>` +
    `<p><small>${alert.timestamp}</small></p>`;

  const result = await sendEmail({ to: recipients, subject, text, html });
  if (!result.ok) console.warn('Brevo crossover alert email failed:', result.error);
}
