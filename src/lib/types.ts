// ============================================
// SignalStack - Shared Type Definitions
// ============================================

// OHLCV candle data from any source
export interface CandleData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Unified price response from any data source
export interface PriceData {
  symbol: string;
  price: number;
  source: string;
  currency: string;
  change: number;
  changePercent: number;
  volume: number;
  timestamp: string;
  timeframe: string;
  candleData?: CandleData[];
  market: MarketInfo;
}

// Exchange/market metadata
export interface MarketInfo {
  name: string;
  exchange: string;
  timezone: string;
  currency: string;
  country: string;
  openTime: string;
  closeTime: string;
}

// Symbol search result
export interface SearchResult {
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
  country: string;
  type: string;
}

// Crossover alert stored and pushed to clients
export interface CrossoverAlert {
  id: string;
  symbol: string;
  timeframe: string;
  fastPeriod: number;
  slowPeriod: number;
  fastEmaValue: number;
  slowEmaValue: number;
  crossoverType: 'bullish' | 'bearish';
  price: number;
  currency: string;
  timestamp: string;
  source: string;
}

// Watch configuration for monitoring a symbol
export interface WatchConfig {
  symbol: string;
  timeframe: string;
  emaPeriods: number[];
  trackBullish: boolean;
  trackBearish: boolean;
  exchange: string;
  currency: string;
}

// EMA status for a watched symbol (sent to frontend)
export interface EmaStatus {
  emas: Record<number, number | null>;
  warmupProgress: Record<number, number>;
  lastPrice: number | null;
}

// Monitoring status update
export interface MonitorStatus {
  symbol: string;
  timeframe: string;
  status: 'starting' | 'warming_up' | 'running' | 'stopped' | 'error';
  message?: string;
}

// Push subscription (from browser Push API)
export interface PushSubscriptionData {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

// Socket.IO event payloads
export interface PriceUpdate {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  currency: string;
  source: string;
  timestamp: string;
}

export interface EmaUpdate {
  symbol: string;
  timeframe: string;
  emas: Record<number, number | null>;
  warmupProgress: Record<number, number>;
}

// Available timeframes
export const TIMEFRAMES = [
  { id: '1m', label: '1 Minute', description: 'Ultra short-term', cronExpr: '* * * * *' },
  { id: '5m', label: '5 Minutes', description: 'Short-term', cronExpr: '*/5 * * * *' },
  { id: '15m', label: '15 Minutes', description: 'Intraday', cronExpr: '*/15 * * * *' },
  { id: '30m', label: '30 Minutes', description: 'Medium-term', cronExpr: '*/30 * * * *' },
  { id: '1h', label: '1 Hour', description: 'Hourly', cronExpr: '0 * * * *' },
  { id: '4h', label: '4 Hours', description: 'Swing trading', cronExpr: '0 */4 * * *' },
  { id: '1d', label: '1 Day', description: 'Daily', cronExpr: '0 16 * * 1-5' },
] as const;

export type TimeframeId = typeof TIMEFRAMES[number]['id'];
