import { NextRequest, NextResponse } from 'next/server';
import { CrossoverService } from '@/lib/crossoverService';

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

    return NextResponse.json({ success: true, message: 'Push subscription added' });
  } catch (error: any) {
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
