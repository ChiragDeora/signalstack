/**
 * Today's OHLC (from LTP) and yesterday's OHLC (from the previous 1d candle)
 * for a symbol. Shared by the Spotlight "Today / Yesterday" readout and the
 * end-of-day summary email.
 */
import { UniversalMarketDataSource } from './dynamicMarketSource';

export interface DayRange {
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface DaySummary {
  today: DayRange;
  yesterday: DayRange | null;
}

const IST_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Returns YYYY-MM-DD calendar date in IST for a given epoch-ms timestamp. */
export function istDateOf(ts: number | Date = new Date()): string {
  const d = typeof ts === 'number' ? new Date(ts) : ts;
  const parts = IST_DATE_FMT.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Fetch ONLY the previous trading day's OHLC via daily candles. Used by the
 * pre-market warm-up cron (09:10 IST) — prev-day data is final before open,
 * so it can be fetched and cached before the market session starts.
 *
 * Candle-index resolution: Angel One's ONE_DAY response may or may not
 * include today's in-progress daily candle. Never assume position — compare
 * the last candle's IST calendar date against today's.
 *   • last candle's IST date == today → today's partial is included,
 *     previous trading day = sorted[-2]
 *   • else → sorted[-1] IS the previous trading day
 */
export async function fetchPrevDayOHLC(
  symbol: string,
  exchange: 'NSE' | 'NFO' | 'BSE' = 'NSE',
  dataSource: UniversalMarketDataSource = new UniversalMarketDataSource(),
): Promise<DayRange | null> {
  try {
    const daily = await dataSource.fetchTimeframeData(symbol, '1d', exchange);
    if (!daily?.candleData || daily.candleData.length < 1) return null;
    const sorted = [...daily.candleData].sort((a, b) => a.timestamp - b.timestamp);
    const todayIST = istDateOf();
    const lastCandle = sorted[sorted.length - 1];
    const lastIST = istDateOf(lastCandle.timestamp);
    let prev = null as typeof lastCandle | null;
    if (lastIST === todayIST) {
      if (sorted.length >= 2) prev = sorted[sorted.length - 2];
    } else {
      prev = lastCandle;
    }
    return prev ? { open: prev.open, high: prev.high, low: prev.low, close: prev.close } : null;
  } catch {
    return null;
  }
}

/**
 * Full day summary: today's OHLC (from LTP) + previous trading day's OHLC.
 * Pass `knownPrevDay` (from the pre-market warm-up cache) to skip the heavy
 * daily-candle fetch — then this costs a single cheap LTP call.
 */
export async function fetchDaySummary(
  symbol: string,
  exchange: 'NSE' | 'NFO' | 'BSE' = 'NSE',
  dataSource: UniversalMarketDataSource = new UniversalMarketDataSource(),
  knownPrevDay?: DayRange | null,
): Promise<DaySummary | null> {
  const ltp = await dataSource.fetchLTP(symbol, exchange);
  if (!ltp) return null;

  const yesterday = knownPrevDay ?? (await fetchPrevDayOHLC(symbol, exchange, dataSource));

  return {
    today: { open: ltp.open, high: ltp.high, low: ltp.low, close: ltp.ltp },
    yesterday,
  };
}

/** Compact fixed-2 formatter without currency symbol (used inside the block). */
function n(v: number): string {
  return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export const OHLC_UNAVAILABLE = 'OHLC data unavailable';

/**
 * Multi-line OHLC context block appended to every alert message. Layout:
 *
 *   Prev day: O 1295.10 / H 1310.45 / L 1288.20 / C 1300.70
 *   Today open: 1305.85 (gap up +0.40%)
 *   Price above prev day high ✅
 *
 * Rules:
 * - Returns the fallback string `OHLC_UNAVAILABLE` (never null) when prev-day
 *   or today-open data is missing — callers embed the string verbatim so the
 *   alert never silently drops the block.
 * - The final line reports the single most significant position vs the prev
 *   day range (above high / below low / vs close / within range).
 * - Gap % uses `(todayOpen - prevClose) / prevClose × 100`.
 *
 * `currency` unused today but reserved so this stays compatible with the
 * older single-sentence helper's call sites.
 */
export function buildOhlcContextBlock(
  direction: 'bullish' | 'bearish',
  price: number,
  daySummary: DaySummary | null,
  _currency = 'INR',
): string {
  void _currency;
  if (!daySummary || !daySummary.yesterday) return OHLC_UNAVAILABLE;
  const y = daySummary.yesterday;
  const todayOpen = daySummary.today?.open;
  if (!Number.isFinite(y.open) || !Number.isFinite(y.high) ||
      !Number.isFinite(y.low) || !Number.isFinite(y.close) ||
      !Number.isFinite(todayOpen ?? NaN) || (todayOpen as number) <= 0) {
    return OHLC_UNAVAILABLE;
  }

  const prevLine = `Prev day: O ${n(y.open)} / H ${n(y.high)} / L ${n(y.low)} / C ${n(y.close)}`;

  const gapPct = ((todayOpen as number) - y.close) / y.close * 100;
  const gapWord = gapPct >= 0 ? 'gap up' : 'gap down';
  const gapStr = `${gapPct >= 0 ? '+' : ''}${gapPct.toFixed(2)}%`;
  const todayLine = `Today open: ${n(todayOpen as number)} (${gapWord} ${gapStr})`;

  // Single most significant fact vs prev day range. Same ordering for both
  // directions so the message reflects the actual price position, not a
  // direction bias.
  let statusLine: string;
  if (Number.isFinite(price) && price > y.high) {
    statusLine = 'Price above prev day high ✅';
  } else if (Number.isFinite(price) && price < y.low) {
    statusLine = 'Price below prev day low ❌';
  } else if (Number.isFinite(price) && price > y.close) {
    statusLine = 'Price above prev day close';
  } else if (Number.isFinite(price) && price < y.close) {
    statusLine = 'Price below prev day close';
  } else {
    statusLine = 'Price within prev day range';
  }
  void direction; // direction reserved for future asymmetric layouts

  return `${prevLine}\n${todayLine}\n${statusLine}`;
}

/**
 * Deprecated single-sentence variant. Kept only so any lingering imports keep
 * compiling; new callers should use `buildOhlcContextBlock`.
 * @deprecated
 */
export function buildOhlcComparison(
  direction: 'bullish' | 'bearish',
  price: number,
  daySummary: DaySummary | null,
  currency = 'INR',
): string | null {
  const block = buildOhlcContextBlock(direction, price, daySummary, currency);
  return block === OHLC_UNAVAILABLE ? null : block;
}
