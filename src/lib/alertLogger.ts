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
import { CrossoverAlert, RsiAlert } from './types';
import type { DaySummary } from './daySummary';

export const LOG_PATH = path.resolve(process.cwd(), 'data', 'crossover-log.xlsx');
const SHEET_NAME = 'Crossover Log';

// Header set covers both crossover and RSI rows; irrelevant columns are blank
// per row. Order is stable — appending new columns at the end is safe; do not
// reorder existing ones or older xlsx files become misaligned.
const HEADERS = [
  'Symbol',
  'Timeframe',
  'Type',
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
  'RSI Signal Type',
  'RSI Value',
  'RSI Period',
  'RSI Overbought',
  'RSI Oversold',
  'Yesterday Open',
  'Yesterday High',
  'Yesterday Low',
  'Yesterday Close',
  "Today Open",
  'OHLC Comparison',
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
  daySummary?: DaySummary | null;
}

// Make sure the existing worksheet has every header in HEADERS. Older log
// files predate columns like RSI / OHLC and would otherwise misalign with new
// rows. Adds missing headers in place; does not reorder existing ones.
function ensureHeaders(ws: ExcelJS.Worksheet): void {
  const row1 = ws.getRow(1);
  const current: string[] = [];
  row1.eachCell({ includeEmpty: true }, (cell) => current.push(String(cell.value ?? '')));
  if (current.length >= HEADERS.length) return;
  HEADERS.forEach((h, i) => {
    if (current[i] !== h) row1.getCell(i + 1).value = h;
  });
  row1.commit();
  row1.font = { bold: true };
  row1.alignment = { horizontal: 'left' };
}

// Build a row object keyed by HEADER name. Any header not present in the map
// is written as blank — letting both crossover and RSI rows share the schema.
function rowFromMap(map: Record<string, unknown>): unknown[] {
  return HEADERS.map((h) => (h in map ? (map[h] as unknown) : ''));
}

function withWorkbook(fn: (ws: ExcelJS.Worksheet) => void | Promise<void>): Promise<void> {
  writeQueue = writeQueue
    .then(async () => {
      try {
        if (!fs.existsSync(LOG_PATH)) await initAlertLog();
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(LOG_PATH);
        const ws = wb.getWorksheet(SHEET_NAME);
        if (!ws) {
          console.error('❌ Crossover log sheet not found, recreating');
          await initAlertLog();
          return;
        }
        ensureHeaders(ws);
        await fn(ws);
        await wb.xlsx.writeFile(LOG_PATH);
      } catch (err) {
        console.error('❌ alert log write failed:', err);
      }
    })
    .catch((err) => console.error('❌ writeQueue chain error:', err));
  return writeQueue;
}

export async function appendAlertLog(alert: CrossoverAlert, extras: AlertLogExtras = {}): Promise<void> {
  return withWorkbook((ws) => {
    const intervalMs = timeframeToMs(alert.timeframe);
    const alertCandleMs = new Date(alert.timestamp).getTime();
    const estimatedCrossMs = alertCandleMs - intervalMs;
    const emaDiffPct =
      alert.slowEmaValue !== 0
        ? ((alert.fastEmaValue - alert.slowEmaValue) / alert.slowEmaValue) * 100
        : 0;
    const ds = extras.daySummary ?? null;
    ws.addRow(
      rowFromMap({
        'Symbol': alert.symbol,
        'Timeframe': alert.timeframe,
        'Type': 'crossover',
        'Direction': alert.crossoverType,
        'EMA Fast': alert.fastPeriod,
        'EMA Slow': alert.slowPeriod,
        'Alert Candle Open (IST)': toIST(alertCandleMs),
        'Estimated Cross Candle (IST)': toIST(estimatedCrossMs),
        'Detected At (IST)': toIST(Date.now()),
        'Email Sent At (IST)': extras.emailSentAt ? toIST(extras.emailSentAt) : '',
        'Fast EMA Value': alert.fastEmaValue,
        'Slow EMA Value': alert.slowEmaValue,
        'EMA Diff %': Number(emaDiffPct.toFixed(4)),
        'Yesterday Open': ds?.yesterday?.open ?? '',
        'Yesterday High': ds?.yesterday?.high ?? '',
        'Yesterday Low': ds?.yesterday?.low ?? '',
        'Yesterday Close': ds?.yesterday?.close ?? '',
        'Today Open': ds?.today?.open ?? '',
        'OHLC Comparison': alert.ohlcContext ?? '',
        'Candle Close Price': extras.candleClosePrice ?? alert.price,
        'User ID': extras.userId ?? '',
      }),
    );
  });
}

export interface RsiAlertLogExtras {
  userId?: string;
  emailSentAt?: string | number | Date;
  daySummary?: DaySummary | null;
  ohlcContext?: string;
}

export async function appendRsiAlertLog(alert: RsiAlert, extras: RsiAlertLogExtras = {}): Promise<void> {
  return withWorkbook((ws) => {
    const alertCandleMs = new Date(alert.timestamp).getTime();
    const ds = extras.daySummary ?? null;
    ws.addRow(
      rowFromMap({
        'Symbol': alert.symbol,
        'Timeframe': alert.timeframe,
        'Type': 'rsi',
        'Direction': alert.direction,
        'Alert Candle Open (IST)': toIST(alertCandleMs),
        'Detected At (IST)': toIST(Date.now()),
        'Email Sent At (IST)': extras.emailSentAt ? toIST(extras.emailSentAt) : '',
        'RSI Signal Type': alert.signalType,
        'RSI Value': alert.rsiValue,
        'RSI Period': alert.period,
        'RSI Overbought': alert.overbought,
        'RSI Oversold': alert.oversold,
        'Yesterday Open': ds?.yesterday?.open ?? '',
        'Yesterday High': ds?.yesterday?.high ?? '',
        'Yesterday Low': ds?.yesterday?.low ?? '',
        'Yesterday Close': ds?.yesterday?.close ?? '',
        'Today Open': ds?.today?.open ?? '',
        'OHLC Comparison': extras.ohlcContext ?? '',
        'Candle Close Price': alert.price,
        'User ID': extras.userId ?? '',
      }),
    );
  });
}
