import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getClerkUserEmail } from '@/lib/clerkUserEmail';
import { sendEmail, isBrevoConfigured } from '@/lib/brevoEmail';

/**
 * POST /api/test-email — Send a test email to the signed-in user (to verify email works).
 */
export async function POST() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Sign in required' }, { status: 401 });
    }
    if (!isBrevoConfigured()) {
      return NextResponse.json(
        { success: false, error: 'Brevo not configured. Set BREVO_API_KEY (Brevo → Settings → SMTP & API → API keys).' },
        { status: 503 },
      );
    }
    const email = await getClerkUserEmail(userId);
    if (!email) {
      return NextResponse.json(
        { success: false, error: 'No email found for your account' },
        { status: 400 },
      );
    }
    const result = await sendEmail({
      to: email,
      subject: 'Test email – SignalStack',
      text: "This is a test email from SignalStack. Email delivery is working.",
      html: "<p>This is a <strong>test email</strong> from SignalStack. Email delivery is working.</p>",
    });
    if (!result.ok) {
      console.error('Test email send failed:', result.error);
      let errMsg = result.error || 'Send failed';
      if (errMsg.toLowerCase().includes('sender') || errMsg.toLowerCase().includes('from')) {
        errMsg += ' Add/verify the sender in Brevo → Senders and set BREVO_FROM_EMAIL to that email in .env';
      }
      return NextResponse.json(
        { success: false, error: errMsg },
        { status: 500 },
      );
    }
    console.log('✅ Test email sent to', email);
    return NextResponse.json({ success: true, message: 'Test email sent to ' + email, email });
  } catch (e) {
    console.error('test-email error:', e);
    return NextResponse.json(
      { success: false, error: 'Request failed' },
      { status: 500 },
    );
  }
}
