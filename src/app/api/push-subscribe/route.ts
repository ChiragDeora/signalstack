import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { CrossoverService } from '@/lib/crossoverService';
import { getClerkUserEmail } from '@/lib/clerkUserEmail';
import { sendEmail, isBrevoConfigured } from '@/lib/brevoEmail';

let service: CrossoverService | null = null;

function getOrCreateService(): CrossoverService {
  if (!service) {
    const io = (global as any).__io || null;
    service = new CrossoverService(io);
    service.initialize();
  }
  return service;
}

// POST: Subscribe to push notifications
export async function POST(req: NextRequest) {
  try {
    const subscription = await req.json();

    if (!subscription?.endpoint || !subscription?.keys) {
      return NextResponse.json(
        { success: false, error: 'Invalid push subscription' },
        { status: 400 },
      );
    }

    const svc = getOrCreateService();
    svc.addPushSubscription({
      endpoint: subscription.endpoint,
      keys: {
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
      },
    });

    // Send a one-time test email so the user can confirm push/notifications are working
    const { userId } = await auth();
    if (userId && isBrevoConfigured()) {
      try {
        const email = await getClerkUserEmail(userId);
        if (email) {
          const result = await sendEmail({
            to: email,
            subject: 'Push notifications enabled – SignalStack',
            text:
              "You're all set. Push notifications are now enabled. You'll receive crossover alerts here and by email when they occur.",
            html:
              "<p>You're all set. <strong>Push notifications are now enabled.</strong></p>" +
              "<p>You'll receive crossover alerts via push and email when they occur.</p>",
          });
          if (result.ok) {
            console.log('✅ Test email sent to', email);
          } else {
            console.error('Test email send failed:', result.error);
          }
        } else {
          console.warn('Test email skipped: no email for user', userId);
        }
      } catch (e) {
        console.error('Test email on push enable failed:', e);
      }
    } else {
      if (!userId) console.warn('Test email skipped: user not signed in');
      else console.warn('Test email skipped: Brevo not configured');
    }

    return NextResponse.json({ success: true, message: 'Push subscription added' });
  } catch (error: unknown) {
    console.error('❌ Push subscribe error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to subscribe' },
      { status: 500 },
    );
  }
}

// DELETE: Unsubscribe from push notifications
export async function DELETE(req: NextRequest) {
  try {
    const { endpoint } = await req.json();

    if (!endpoint) {
      return NextResponse.json(
        { success: false, error: 'Endpoint is required' },
        { status: 400 },
      );
    }

    const svc = getOrCreateService();
    svc.removePushSubscription(endpoint);

    return NextResponse.json({ success: true, message: 'Push subscription removed' });
  } catch {
    return NextResponse.json(
      { success: false, error: 'Failed to unsubscribe' },
      { status: 500 },
    );
  }
}
