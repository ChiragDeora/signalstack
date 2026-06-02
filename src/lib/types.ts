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

// RSI alert stored and pushed to clients
export interface RsiAlert {
  id: string;
  type: 'rsi';
  symbol: string;
  timeframe: string;
  signalType: 'overboughtCross' | 'oversoldCross' | 'thresholdBreach' | 'centerlineCross';
  direction: 'bullish' | 'bearish';
  rsiValue: number;
  previousRsi: number;
  period: number;
  overbought: number;
  oversold: number;
  price: number;
  currency: string;
  timestamp: string;
  source: string;
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

// RSI configuration per watch. All fields are required when enabled = true —
// the UI forces the user to supply them (no implicit defaults).
export interface RsiConfig {
  enabled: boolean;
  period: number;
  overbought: number;
  oversold: number;
  signals: {
    overboughtCross: boolean;
    oversoldCross: boolean;
    thresholdBreach: boolean;
    centerlineCross: boolean;
  };
}

// Watch configuration for monitoring a symbol (userId for per-user segregation)
export interface WatchConfig {
  userId?: string; // Clerk user id – used to segregate polls and enforce per-user limits
  symbol: string;
  timeframe: string;
  emaPeriods: number[];
  trackBullish: boolean;
  trackBearish: boolean;
  exchange: string;
  currency: string;
  rsi?: RsiConfig;
}

// EMA status for a watched symbol (sent to frontend)
export interface EmaStatus {
  emas: Record<number, number | null>;
  warmupProgress: Record<number, number>;
  lastPrice: number | null;
  rsi?: {
    value: number | null;
    period: number;
    warmupProgress: number;
  };
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
  userId?: string; // Clerk user id — used to scope push notifications per user
}

// Socket.IO event payloads
export interface PriceUpdate {
  symbol: string;
  timeframe?: string;
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
  rsi?: {
    value: number | null;
    period: number;
    warmupProgress: number;
  };
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
