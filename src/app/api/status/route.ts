import { NextResponse } from 'next/server';
import { getAlerts } from '@/lib/alertStore';
import { getDhanSource } from '@/lib/dhanSource';

export async function GET() {
  const dhan = getDhanSource();

  return NextResponse.json({
    status: 'running',
    uptime: process.uptime(),
    alertCount: getAlerts().length,
    dataSources: dhan.isAvailable() ? ['Dhan HQ'] : [],
    dhanConfigured: dhan.isAvailable(),
    vapidConfigured: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
  });
}
