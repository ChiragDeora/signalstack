// ============================================
// Alert Logger - persistent xlsx log of every fired crossover
// ============================================
// Appends one row per crossover alert to data/crossover-log.xlsx so the
// timing can be cross-referenced against TradingView visual crosses after
// the trading session.
//
// Concurrency: a single in-process promise queue serializes writes so
// concurrent alerts don't race on the file.

import ExcelJS from 'exceljs';
import path from 'path';
import fs from 'fs';
import { CrossoverAlert } from './types';

export const LOG_PATH = path.resolve(process.cwd(), 'data', 'crossover-log.xlsx');
const SHEET_NAME = 'Crossover Log';

const HEADERS = [
  'Symbol',
  'Timeframe',
  'Direction',
  'EMA Fast',
  'EMA Slow',
  'Alert Candle Open (IST)',
  'Estimated Cross Candle (IST)',
  'Detected At (IST)',
  'Email Sent At (IST)',
  'Fast EMA Value',
  'Slow EMA Value',
  'EMA Diff %',
  'Candle Close Price',
  'User ID',
  'TV Visual Cross',
  'Timestamp Delta (min)',
  'Notes',
];

// Serialize all writes through this promise chain so concurrent alerts
// can't corrupt the file.
let writeQueue: Promise<void> = Promise.resolve();

function timeframeToMs(timeframe: string): number {
  const map: Record<string, number> = {
    '1m': 60_000,
    '5m': 5 * 60_000,
    '15m': 15 * 60_000,
    '30m': 30 * 60_000,
    '1h': 60 * 60_000,
    '4h': 4 * 60 * 60_000,
    '1d': 24 * 60 * 60_000,
  };
  return map[timeframe] || 5 * 60_000;
}

function toIST(input: string | number | Date): string {
  const d = typeof input === 'string' || typeof input === 'number' ? new Date(input) : input;
  if (isNaN(d.getTime())) return '';
  // Format as YYYY-MM-DD HH:mm:ss in Asia/Kolkata
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

export async function initAlertLog(): Promise<void> {
  try {
    const dir = path.dirname(LOG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(LOG_PATH)) {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet(SHEET_NAME);
      ws.addRow(HEADERS);
      ws.getRow(1).font = { bold: true };
      ws.getRow(1).alignment = { horizontal: 'left' };
      ws.columns = HEADERS.map((h) => ({ width: Math.max(h.length + 4, 14) }));
      // Freeze the header row
      ws.views = [{ state: 'frozen', ySplit: 1 }];
      await wb.xlsx.writeFile(LOG_PATH);
      console.log(`📒 Created crossover log at ${LOG_PATH}`);
    } else {
      console.log(`📒 Crossover log present at ${LOG_PATH}`);
    }
  } catch (err) {
    console.error('❌ Failed to init alert log:', err);
  }
}

export interface AlertLogExtras {
  userId?: string;
  emailSentAt?: string | number | Date;
  candleClosePrice?: number;
}

export async function appendAlertLog(alert: CrossoverAlert, extras: AlertLogExtras = {}): Promise<void> {
  // Chain onto the write queue to serialize file access
  writeQueue = writeQueue
    .then(async () => {
      try {
        if (!fs.existsSync(LOG_PATH)) {
          await initAlertLog();
        }
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(LOG_PATH);
        const ws = wb.getWorksheet(SHEET_NAME);
        if (!ws) {
          console.error('❌ Crossover log sheet not found, recreating');
          await initAlertLog();
          return;
        }

        const intervalMs = timeframeToMs(alert.timeframe);
        const alertCandleMs = new Date(alert.timestamp).getTime();
        const estimatedCrossMs = alertCandleMs - intervalMs;
        const emaDiffPct =
          alert.slowEmaValue !== 0
            ? ((alert.fastEmaValue - alert.slowEmaValue) / alert.slowEmaValue) * 100
            : 0;

        ws.addRow([
          alert.symbol,
          alert.timeframe,
          alert.crossoverType,
          alert.fastPeriod,
          alert.slowPeriod,
          toIST(alertCandleMs),
          toIST(estimatedCrossMs),
          toIST(Date.now()),
          extras.emailSentAt ? toIST(extras.emailSentAt) : '',
          alert.fastEmaValue,
          alert.slowEmaValue,
          Number(emaDiffPct.toFixed(4)),
          extras.candleClosePrice ?? alert.price,
          extras.userId ?? '',
          '', // TV Visual Cross — manual
          '', // Timestamp Delta — manual or formula
          '', // Notes — manual
        ]);

        await wb.xlsx.writeFile(LOG_PATH);
      } catch (err) {
        console.error('❌ appendAlertLog failed:', err);
      }
    })
    .catch((err) => {
      console.error('❌ writeQueue chain error:', err);
    });

  return writeQueue;
}
