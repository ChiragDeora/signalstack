import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateCrossoverService } from '@/lib/crossoverServiceSingleton';

const MAX_DELAY_SECONDS = 300; // 5 min max

/**
 * POST: Send a test push notification to all subscribed devices.
 * Body: { delaySeconds?: number } — if set, send the test after that many seconds (for "test when browser closed").
 */
export async function POST(req: NextRequest) {
  try {
    let delaySeconds = 0;
    try {
      const body = await req.json().catch(() => ({}));
      delaySeconds = Math.min(MAX_DELAY_SECONDS, Math.max(0, Number(body?.delaySeconds) || 0));
    } catch {
      // no body or invalid
    }

    const svc = await getOrCreateCrossoverService();
    if (svc.getMonitoringInfo().pushSubscriptionCount === 0) {
      return NextResponse.json({
        success: false,
        error: 'No push subscriptions. Enable alerts first.',
      }, { status: 400 });
    }

    if (delaySeconds > 0) {
      setTimeout(() => {
        svc.sendTestPushNotification().then(({ sent }) => {
          if (sent > 0) console.log(`🔔 Delayed test push sent to ${sent} device(s)`);
        }).catch((e) => console.error('Delayed test push failed:', e));
      }, delaySeconds * 1000);
      return NextResponse.json({
        success: true,
        scheduled: true,
        message: `Test will send in ${delaySeconds} second(s). Close the browser to check.`,
        delaySeconds,
      });
    }

    const { sent, failed } = await svc.sendTestPushNotification();

    return NextResponse.json({
      success: true,
      message: sent > 0 ? `Test notification sent to ${sent} device(s).` : 'No devices received the test.',
      sent,
      failed,
    });
  } catch (error: unknown) {
    console.error('❌ Push test error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to send test notification' },
      { status: 500 },
    );
  }
}
