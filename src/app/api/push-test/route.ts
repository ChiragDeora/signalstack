import { NextResponse } from 'next/server';
import { getOrCreateCrossoverService } from '@/lib/crossoverServiceSingleton';

/**
 * POST: Send a test push notification to all subscribed devices.
 * Used by the "Test notification" button in the UI.
 */
export async function POST() {
  try {
    const svc = await getOrCreateCrossoverService();
    const { sent, failed } = await svc.sendTestPushNotification();

    if (sent === 0 && failed === 0) {
      return NextResponse.json({
        success: false,
        error: 'No push subscriptions. Enable alerts first.',
      }, { status: 400 });
    }

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
