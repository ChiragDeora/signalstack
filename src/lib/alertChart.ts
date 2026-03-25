import sharp from 'sharp';
import { CandleData, CrossoverAlert } from './types';

type Attachment = {
  filename: string;
  content: string;
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

function sanitizeFilePart(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export async function buildCrossoverChartAttachment(
  alert: CrossoverAlert,
  candles: CandleData[] | undefined,
): Promise<Attachment | null> {
  if (!candles || candles.length < Math.max(alert.slowPeriod + 5, 20)) return null;

  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  const window = sorted.slice(-80);
  const closes = window.map((c) => c.close);
  const fast = computeEmaSeries(closes, alert.fastPeriod);
  const slow = computeEmaSeries(closes, alert.slowPeriod);

  const validVals = [
    ...closes,
    ...fast.filter((v): v is number => v !== null),
    ...slow.filter((v): v is number => v !== null),
  ];
  if (validVals.length === 0) return null;

  const min = Math.min(...validVals);
  const max = Math.max(...validVals);
  const width = 960;
  const height = 540;
  const left = 70;
  const right = 30;
  const top = 30;
  const bottom = 70;
  const plotW = width - left - right;
  const plotH = height - top - bottom;

  const closePath = buildPath(closes, left, plotW, min, max, top, plotH);
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

  const yTicks = 5;
  const gridLines: string[] = [];
  const yLabels: string[] = [];
  for (let i = 0; i <= yTicks; i++) {
    const y = top + (i * plotH) / yTicks;
    const val = max - ((max - min) * i) / yTicks;
    gridLines.push(`<line x1="${left}" y1="${y.toFixed(1)}" x2="${(left + plotW).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#e5e7eb" stroke-width="1" />`);
    yLabels.push(`<text x="${left - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="12" fill="#6b7280">${val.toFixed(2)}</text>`);
  }

  const startLabel = new Date(window[0].timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const endLabel = new Date(window[window.length - 1].timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>
  <text x="${left}" y="20" font-size="18" font-family="Arial, sans-serif" fill="#111827" font-weight="700">${alert.symbol} ${alert.timeframe} crossover chart</text>
  <text x="${left}" y="${height - 18}" font-size="12" font-family="Arial, sans-serif" fill="#6b7280">${startLabel}</text>
  <text x="${left + plotW}" y="${height - 18}" text-anchor="end" font-size="12" font-family="Arial, sans-serif" fill="#6b7280">${endLabel}</text>
  ${gridLines.join('')}
  ${yLabels.join('')}
  <polyline fill="none" stroke="#2563eb" stroke-width="2" points="${closePath}" />
  <polyline fill="none" stroke="#f59e0b" stroke-width="2.4" points="${fastPath}" />
  <polyline fill="none" stroke="#7c3aed" stroke-width="2.4" points="${slowPath}" />
  <line x1="${crossX.toFixed(1)}" y1="${top}" x2="${crossX.toFixed(1)}" y2="${(top + plotH).toFixed(1)}" stroke="${crossColor}" stroke-width="1.5" stroke-dasharray="5,4" />
  <circle cx="${crossX.toFixed(1)}" cy="${crossY.toFixed(1)}" r="4.5" fill="${crossColor}" />
  <rect x="${left}" y="${height - 54}" width="12" height="3" fill="#2563eb"/><text x="${left + 18}" y="${height - 48}" font-size="12" font-family="Arial, sans-serif" fill="#374151">Close</text>
  <rect x="${left + 90}" y="${height - 54}" width="12" height="3" fill="#f59e0b"/><text x="${left + 108}" y="${height - 48}" font-size="12" font-family="Arial, sans-serif" fill="#374151">EMA(${alert.fastPeriod})</text>
  <rect x="${left + 210}" y="${height - 54}" width="12" height="3" fill="#7c3aed"/><text x="${left + 228}" y="${height - 48}" font-size="12" font-family="Arial, sans-serif" fill="#374151">EMA(${alert.slowPeriod})</text>
  <text x="${left + 380}" y="${height - 48}" font-size="12" font-family="Arial, sans-serif" fill="${crossColor}">${alert.crossoverType.toUpperCase()} crossover</text>
</svg>`;

  try {
    // Convert SVG→PNG so common email clients render it reliably.
    const pngBuffer = await sharp(Buffer.from(svg, 'utf8')).png().toBuffer();
    return {
      filename: `${sanitizeFilePart(alert.symbol)}_${sanitizeFilePart(alert.timeframe)}_${alert.crossoverType}_crossover.png`,
      content: pngBuffer.toString('base64'),
      contentType: 'image/png',
    };
  } catch (err) {
    console.warn('Chart PNG generation failed:', err);
    return null;
  }
}
