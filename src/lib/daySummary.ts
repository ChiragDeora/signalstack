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

export async function fetchDaySummary(
  symbol: string,
  exchange: 'NSE' | 'NFO' | 'BSE' = 'NSE',
  dataSource: UniversalMarketDataSource = new UniversalMarketDataSource(),
): Promise<DaySummary | null> {
  const ltp = await dataSource.fetchLTP(symbol, exchange);
  if (!ltp) return null;

  let yesterday: DayRange | null = null;
  try {
    const daily = await dataSource.fetchTimeframeData(symbol, '1d', exchange);
    if (daily?.candleData && daily.candleData.length >= 2) {
      const sorted = [...daily.candleData].sort((a, b) => a.timestamp - b.timestamp);
      const prev = sorted[sorted.length - 2];
      yesterday = { open: prev.open, high: prev.high, low: prev.low, close: prev.close };
    }
  } catch {
    /* yesterday data is optional */
  }

  return {
    today: { open: ltp.open, high: ltp.high, low: ltp.low, close: ltp.ltp },
    yesterday,
  };
}
