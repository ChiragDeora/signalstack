import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import fs from 'fs';
import { LOG_PATH } from '@/lib/alertLogger';

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Sign in required' }, { status: 401 });
    }

    if (!fs.existsSync(LOG_PATH)) {
      return NextResponse.json(
        { success: false, error: 'Alert log not yet created — wait for the first crossover alert.' },
        { status: 404 },
      );
    }

    const file = fs.readFileSync(LOG_PATH);
    const filename = `crossover-log-${new Date().toISOString().slice(0, 10)}.xlsx`;

    return new NextResponse(new Uint8Array(file), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(file.length),
        'Cache-Control': 'no-store',
      },
    });
  } catch (e: any) {
    console.error('alert-log GET error', e);
    return NextResponse.json({ success: false, error: e?.message ?? 'Unknown error' }, { status: 500 });
  }
}
