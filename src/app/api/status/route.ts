import { NextResponse } from 'next/server';
import { getAlerts } from '@/lib/alertStore';
import { getAngelOneSource } from '@/lib/angelOneSource';

export async function GET() {
  const angel = getAngelOneSource();

  return NextResponse.json({
    status: 'running',
    uptime: process.uptime(),
    alertCount: getAlerts().length,
    dataSources: angel.isAvailable() ? ['Angel One'] : [],
    angelConfigured: angel.isAvailable(),
    vapidConfigured: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
  });
}
