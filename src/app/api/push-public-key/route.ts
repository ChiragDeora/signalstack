import { NextResponse } from 'next/server';
import { getVapidKeys } from '@/lib/pushKeys';

/**
 * GET: Return the VAPID public key for client-side push subscription.
 * Client must decode with urlBase64ToUint8Array() before passing to pushManager.subscribe().
 * See: https://blog.openreplay.com/implementing-push-notifications-web-push-api/
 */
export async function GET() {
  const keys = getVapidKeys();
  if (!keys) {
    return NextResponse.json(
      { error: 'Push notifications not configured' },
      { status: 503 }
    );
  }
  return NextResponse.json({ publicKey: keys.publicKey });
}
