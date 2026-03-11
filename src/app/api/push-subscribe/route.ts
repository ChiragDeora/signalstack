import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getOrCreateCrossoverService } from '@/lib/crossoverServiceSingleton';
import { savePushSubscription, removePushSubscription } from '@/lib/pushSubscriptionPersistence';
import { getClerkUserEmail } from '@/lib/clerkUserEmail';
import { sendEmail, isBrevoConfigured } from '@/lib/brevoEmail';

// POST: Subscribe to push notifications
export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    const subscription = await req.json();

    if (!subscription?.endpoint || !subscription?.keys) {
      return NextResponse.json(
        { success: false, error: 'Invalid push subscription' },
        { status: 400 },
      );
    }

    const subData = {
      endpoint: subscription.endpoint,
      keys: {
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
      },
    };
    const svc = await getOrCreateCrossoverService();
    svc.addPushSubscription(subData, userId ?? undefined);
    await savePushSubscription(subData, userId ?? null).catch((e) => console.warn('Persist push subscription failed:', e?.message));

    // Send a test push immediately so the user sees a browser notification right away
    try {
      const { sent } = await svc.sendTestPushNotification();
      if (sent > 0) console.log('✅ Test push sent to new subscriber');
    } catch (e) {
      console.warn('Test push on subscribe failed:', (e as Error)?.message);
    }

    // Send a one-time test email so the user can confirm push/notifications are working
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

    const svc = await getOrCreateCrossoverService();
    svc.removePushSubscription(endpoint);
    await removePushSubscription(endpoint).catch((e) => console.warn('Persist remove push subscription failed:', e?.message));

    return NextResponse.json({ success: true, message: 'Push subscription removed' });
  } catch {
    return NextResponse.json(
      { success: false, error: 'Failed to unsubscribe' },
      { status: 500 },
    );
  }
}
