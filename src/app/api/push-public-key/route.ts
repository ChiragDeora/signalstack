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
    const hint =
      process.env.VERCEL
        ? 'On Vercel, set NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT in Project Settings → Environment Variables. Generate keys with: npx web-push generate-vapid-keys'
        : 'Set VAPID env vars or run the app with a writable filesystem so keys can be auto-generated.';
    return NextResponse.json(
      { error: 'Push notifications not configured', hint },
      { status: 503 }
    );
  }
  return NextResponse.json({ publicKey: keys.publicKey });
}
