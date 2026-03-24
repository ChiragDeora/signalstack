import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { sendEmail, isBrevoConfigured } from '@/lib/brevoEmail';

/**
 * POST /api/send-email — Send an email via Brevo.
 * Requires sign-in.
 * Body: {
 *   to: string | string[],
 *   subject: string,
 *   text?: string,
 *   html?: string,
 *   attachments?: { filename: string; content: string; contentType?: string }[]
 * }
 */
export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Sign in required' }, { status: 401 });
    }
    if (!isBrevoConfigured()) {
      return NextResponse.json(
        { success: false, error: 'Brevo SMTP not configured (BREVO_SMTP_USER, BREVO_SMTP_PASS)' },
        { status: 503 },
      );
    }

    const body = await req.json();
    const { to, subject, text, html, attachments } = body;
    if (!to || !subject) {
      return NextResponse.json(
        { success: false, error: 'Missing "to" or "subject"' },
        { status: 400 },
      );
    }
    if (!text && !html) {
      return NextResponse.json(
        { success: false, error: 'Provide at least "text" or "html"' },
        { status: 400 },
      );
    }
    if (attachments !== undefined) {
      const valid =
        Array.isArray(attachments) &&
        attachments.every(
          (a) =>
            a &&
            typeof a === 'object' &&
            typeof a.filename === 'string' &&
            a.filename.trim().length > 0 &&
            typeof a.content === 'string' &&
            a.content.trim().length > 0 &&
            (a.contentType === undefined || typeof a.contentType === 'string'),
        );
      if (!valid) {
        return NextResponse.json(
          { success: false, error: 'Invalid "attachments" format' },
          { status: 400 },
        );
      }
    }

    const result = await sendEmail({ to, subject, text, html, attachments });
    if (!result.ok) {
      return NextResponse.json(
        { success: false, error: result.error || 'Send failed' },
        { status: 500 },
      );
    }
    return NextResponse.json({ success: true, message: 'Email sent' });
  } catch (e) {
    console.error('send-email error:', e);
    return NextResponse.json(
      { success: false, error: 'Request failed' },
      { status: 500 },
    );
  }
}
