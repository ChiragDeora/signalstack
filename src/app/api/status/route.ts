import { NextResponse } from 'next/server';
import { getAlerts } from '@/lib/alertStore';
import { getAngelOneSource } from '@/lib/angelOneSource';
import { isVapidConfigured } from '@/lib/pushKeys';
import { isBrevoConfigured, getAlertRecipientEmails } from '@/lib/brevoEmail';

export async function GET() {
  const angel = getAngelOneSource();

  return NextResponse.json({
    status: 'running',
    uptime: process.uptime(),
    alertCount: getAlerts().length,
    dataSources: angel.isAvailable() ? ['Angel One'] : [],
    angelConfigured: angel.isAvailable(),
    vapidConfigured: isVapidConfigured(),
    brevoConfigured: isBrevoConfigured(),
    emailAlertsConfigured:
      isBrevoConfigured() && getAlertRecipientEmails().length > 0,
  });
}
