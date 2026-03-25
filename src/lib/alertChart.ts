import sharp from 'sharp';
import { CandleData, CrossoverAlert } from './types';

type Attachment = {
  filename: string;
  content: string; // base64
  contentType?: string;
};

function computeEmaSeries(closes: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(closes.length).fill(null);
  if (period <= 0 || closes.length === 0) return out;
  const k = 2 / (period + 1);
  let ema: number | null = null;
  let seedSum = 0;
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i];
    if (i < period) {
      seedSum += c;
      if (i === period - 1) {
        ema = seedSum / period;
        out[i] = ema;
      }
      continue;
    }
    if (ema === null) continue;
    ema = c * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function mapY(value: number, min: number, max: number, top: number, height: number): number {
  if (max <= min) return top + height / 2;
  const t = (value - min) / (max - min);
  return top + height - t * height;
}

function buildPath(values: Array<number | null>, left: number, width: number, min: number, max: number, top: number, height: number): string {
  const n = values.length;
  if (n < 2) return '';
  const pts: string[] = [];
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v === null || Number.isNaN(v)) continue;
    const x = left + (i * width) / (n - 1);
    const y = mapY(v, min, max, top, height);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return pts.join(' ');
}

/** Build candlestick bars for the chart */
function buildCandlesticks(
  candles: CandleData[],
  left: number,
  width: number,
  min: number,
  max: number,
  top: number,
  height: number,
): string {
  const n = candles.length;
  if (n < 2) return '';
  const barWidth = Math.max(1, (width / n) * 0.6);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const x = left + (i * width) / (n - 1);
    const yOpen = mapY(c.open, min, max, top, height);
    const yClose = mapY(c.close, min, max, top, height);
    const yHigh = mapY(c.high, min, max, top, height);
    const yLow = mapY(c.low, min, max, top, height);
    const bullish = c.close >= c.open;
    const fill = bullish ? '#16a34a' : '#dc2626';
    const bodyTop = Math.min(yOpen, yClose);
    const bodyH = Math.max(1, Math.abs(yOpen - yClose));
    // Wick
    parts.push(`<line x1="${x.toFixed(1)}" y1="${yHigh.toFixed(1)}" x2="${x.toFixed(1)}" y2="${yLow.toFixed(1)}" stroke="${fill}" stroke-width="1" />`);
    // Body
    parts.push(`<rect x="${(x - barWidth / 2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${fill}" />`);
  }
  return parts.join('');
}

function sanitizeFilePart(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function buildSvg(alert: CrossoverAlert, candles: CandleData[]): string {
  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  const window = sorted.slice(-80);
  const closes = window.map((c) => c.close);
  const fast = computeEmaSeries(closes, alert.fastPeriod);
  const slow = computeEmaSeries(closes, alert.slowPeriod);

  const allVals = [
    ...window.flatMap((c) => [c.high, c.low]),
    ...fast.filter((v): v is number => v !== null),
    ...slow.filter((v): v is number => v !== null),
  ];
  if (allVals.length === 0) return '';

  const rawMin = Math.min(...allVals);
  const rawMax = Math.max(...allVals);
  const pad = (rawMax - rawMin) * 0.05 || 1;
  const min = rawMin - pad;
  const max = rawMax + pad;

  const width = 960;
  const height = 540;
  const left = 80;
  const right = 30;
  const top = 40;
  const bottom = 75;
  const plotW = width - left - right;
  const plotH = height - top - bottom;

  const candleSvg = buildCandlesticks(window, left, plotW, min, max, top, plotH);
  const fastPath = buildPath(fast, left, plotW, min, max, top, plotH);
  const slowPath = buildPath(slow, left, plotW, min, max, top, plotH);

  const alertTs = Date.parse(alert.timestamp);
  let crossoverIdx = window.length - 1;
  if (!Number.isNaN(alertTs)) {
    let bestDist = Number.MAX_SAFE_INTEGER;
    for (let i = 0; i < window.length; i++) {
      const d = Math.abs(window[i].timestamp - alertTs);
      if (d < bestDist) {
        bestDist = d;
        crossoverIdx = i;
      }
    }
  }
  const crossX = left + (crossoverIdx * plotW) / Math.max(1, window.length - 1);
  const crossY = mapY(closes[crossoverIdx], min, max, top, plotH);
  const crossColor = alert.crossoverType === 'bullish' ? '#16a34a' : '#dc2626';
  const arrowDir = alert.crossoverType === 'bullish' ? 'up' : 'down';

  // Y-axis grid & labels
  const yTicks = 6;
  const gridLines: string[] = [];
  const yLabels: string[] = [];
  for (let i = 0; i <= yTicks; i++) {
    const y = top + (i * plotH) / yTicks;
    const val = max - ((max - min) * i) / yTicks;
    gridLines.push(`<line x1="${left}" y1="${y.toFixed(1)}" x2="${(left + plotW).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#f0f0f0" stroke-width="1" />`);
    yLabels.push(`<text x="${left - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" font-family="Arial, sans-serif" fill="#888">${val.toFixed(2)}</text>`);
  }

  // X-axis time labels (first, middle, last)
  const fmtTime = (ts: number) => new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
  const fmtDate = (ts: number) => new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });
  const xLabelY = top + plotH + 18;
  const mid = Math.floor(window.length / 2);
  const xLabels = [
    `<text x="${left}" y="${xLabelY}" font-size="11" font-family="Arial, sans-serif" fill="#888">${fmtDate(window[0].timestamp)} ${fmtTime(window[0].timestamp)}</text>`,
    `<text x="${left + plotW / 2}" y="${xLabelY}" text-anchor="middle" font-size="11" font-family="Arial, sans-serif" fill="#888">${fmtDate(window[mid].timestamp)} ${fmtTime(window[mid].timestamp)}</text>`,
    `<text x="${left + plotW}" y="${xLabelY}" text-anchor="end" font-size="11" font-family="Arial, sans-serif" fill="#888">${fmtDate(window[window.length - 1].timestamp)} ${fmtTime(window[window.length - 1].timestamp)}</text>`,
  ];

  // Crossover arrow
  const arrowSvg = arrowDir === 'up'
    ? `<polygon points="${crossX},${crossY - 18} ${crossX - 7},${crossY - 8} ${crossX + 7},${crossY - 8}" fill="${crossColor}" />`
    : `<polygon points="${crossX},${crossY + 18} ${crossX - 7},${crossY + 8} ${crossX + 7},${crossY + 8}" fill="${crossColor}" />`;

  const direction = alert.crossoverType === 'bullish' ? 'Bullish' : 'Bearish';
  const title = `${alert.symbol} · ${alert.timeframe} · ${direction} Crossover · ${alert.currency} ${alert.price}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fafafa"/>
      <stop offset="100%" stop-color="#f5f5f5"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <rect x="${left}" y="${top}" width="${plotW}" height="${plotH}" fill="#ffffff" stroke="#e5e7eb" stroke-width="1"/>
  <text x="${left}" y="26" font-size="16" font-family="Arial, sans-serif" fill="#111827" font-weight="700">${title}</text>
  ${gridLines.join('\n  ')}
  ${yLabels.join('\n  ')}
  ${xLabels.join('\n  ')}
  ${candleSvg}
  <polyline fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" points="${fastPath}" />
  <polyline fill="none" stroke="#7c3aed" stroke-width="2" stroke-linecap="round" points="${slowPath}" />
  <line x1="${crossX.toFixed(1)}" y1="${top}" x2="${crossX.toFixed(1)}" y2="${(top + plotH).toFixed(1)}" stroke="${crossColor}" stroke-width="1.5" stroke-dasharray="6,4" opacity="0.7" />
  ${arrowSvg}
  <circle cx="${crossX.toFixed(1)}" cy="${crossY.toFixed(1)}" r="5" fill="${crossColor}" stroke="#fff" stroke-width="2" />
  <rect x="${left}" y="${height - 48}" width="14" height="3" rx="1" fill="#f59e0b"/><text x="${left + 20}" y="${height - 42}" font-size="12" font-family="Arial, sans-serif" fill="#555">EMA(${alert.fastPeriod})</text>
  <rect x="${left + 110}" y="${height - 48}" width="14" height="3" rx="1" fill="#7c3aed"/><text x="${left + 130}" y="${height - 42}" font-size="12" font-family="Arial, sans-serif" fill="#555">EMA(${alert.slowPeriod})</text>
  <circle cx="${left + 230}" cy="${height - 46}" r="4" fill="${crossColor}"/><text x="${left + 240}" y="${height - 42}" font-size="12" font-family="Arial, sans-serif" fill="${crossColor}" font-weight="600">${direction} crossover</text>
  <text x="${width - right}" y="${height - 42}" text-anchor="end" font-size="10" font-family="Arial, sans-serif" fill="#bbb">SignalStack</text>
</svg>`;
}

/**
 * Build a PNG chart attachment for a crossover alert email.
 * Uses sharp to rasterize the SVG — no browser needed, ~10ms.
 * Returns null if not enough candle data to render a meaningful chart.
 */
export async function buildCrossoverChartAttachment(
  alert: CrossoverAlert,
  candles: CandleData[] | undefined,
): Promise<Attachment | null> {
  if (!candles || candles.length < Math.max(alert.slowPeriod + 5, 20)) return null;

  try {
    const svg = buildSvg(alert, candles);
    if (!svg) return null;

    const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();

    return {
      filename: `${sanitizeFilePart(alert.symbol)}_${sanitizeFilePart(alert.timeframe)}_${alert.crossoverType}_crossover.png`,
      content: pngBuffer.toString('base64'),
      contentType: 'image/png',
    };
  } catch (err) {
    console.warn('Chart generation failed:', err);
    return null;
  }
}
