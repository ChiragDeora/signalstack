import { NextResponse } from 'next/server';
import { getAlerts, clearAlerts } from '@/lib/alertStore';

export async function GET() {
  return NextResponse.json({
    success: true,
    alerts: getAlerts().slice(0, 100),
    count: getAlerts().length,
  });
}

export async function DELETE() {
  clearAlerts();
  return NextResponse.json({ success: true, message: 'Alert history cleared' });
}
