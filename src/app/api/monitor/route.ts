import { NextRequest, NextResponse } from 'next/server';
import { CrossoverService } from '@/lib/crossoverService';
import { WatchConfig } from '@/lib/types';

// Lazy-initialize the service using the global Socket.IO instance
let service: CrossoverService | null = null;

function getOrCreateService(): CrossoverService {
  if (!service) {
    const io = (global as any).__io || null;
    service = new CrossoverService(io);
    service.initialize();
  }
  return service;
}

// POST: Start monitoring a symbol
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { symbol, timeframe, emaPeriods, trackBullish, trackBearish, exchange, currency } = body;

    if (!symbol || !timeframe || !emaPeriods || emaPeriods.length < 2) {
      return NextResponse.json(
        { success: false, error: 'Need symbol, timeframe, and at least 2 EMA periods' },
        { status: 400 },
      );
    }

    const config: WatchConfig = {
      symbol: symbol.toUpperCase(),
      timeframe,
      emaPeriods: emaPeriods.map(Number),
      trackBullish: trackBullish !== false,
      trackBearish: trackBearish !== false,
      exchange: exchange || 'NSE',
      currency: currency || 'INR',
    };

    const svc = getOrCreateService();
    const result = await svc.startMonitoring(config);

    return NextResponse.json(result);
  } catch (error: any) {
    console.error('❌ Monitor start error:', error);
    return NextResponse.json(
      { success: false, error: error?.message || 'Failed to start monitoring' },
      { status: 500 },
    );
  }
}

// DELETE: Stop monitoring a symbol
export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json();
    const { symbol, timeframe } = body;

    if (!symbol) {
      return NextResponse.json(
        { success: false, error: 'Symbol is required' },
        { status: 400 },
      );
    }

    const svc = getOrCreateService();
    await svc.stopMonitoring(symbol, timeframe);

    return NextResponse.json({
      success: true,
      message: `Stopped monitoring ${symbol}`,
    });
  } catch (error: any) {
    console.error('❌ Monitor stop error:', error);
    return NextResponse.json(
      { success: false, error: error?.message || 'Failed to stop monitoring' },
      { status: 500 },
    );
  }
}

// GET: Get monitoring status
export async function GET() {
  try {
    const svc = getOrCreateService();
    const info = svc.getMonitoringInfo();

    return NextResponse.json({
      success: true,
      ...info,
      uptime: process.uptime(),
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error?.message || 'Failed to get status' },
      { status: 500 },
    );
  }
}
