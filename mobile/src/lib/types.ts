/**
 * Types shared with the PWA backend — keep field names identical to types.ts there.
 */
export interface RsiSignalFlags {
  overboughtCross: boolean;
  oversoldCross: boolean;
  thresholdBreach: boolean;
  centerlineCross: boolean;
  signalLineCross: boolean;
}
export interface RsiPayload {
  enabled: boolean;
  period: number;
  overbought: number;
  oversold: number;
  signalLineLength?: number;
  timeframe?: string;
  signals: RsiSignalFlags;
}
export interface MonitoredWatch {
  symbol: string;
  timeframe: string;
  emaPeriods: number[];
  trackBullish: boolean;
  trackBearish: boolean;
  exchange: string;
  currency: string;
  rsi?: RsiPayload;
}
export interface SymbolMeta {
  symbol: string;
  name?: string;
  currency: string;
  exchange?: string;
}
export interface SearchResult {
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
  type: string;
}
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
export interface RsiAlert {
  id: string;
  type: 'rsi';
  symbol: string;
  timeframe: string;
  signalType: 'overboughtCross' | 'oversoldCross' | 'thresholdBreach' | 'centerlineCross' | 'signalLineCross';
  direction: 'bullish' | 'bearish';
  rsiValue: number;
  previousRsi: number;
  period: number;
  overbought: number;
  oversold: number;
  price: number;
  currency: string;
  timestamp: string;
}
export interface PriceInfo {
  price: number;
  change: number;
  changePercent: number;
  currency: string;
  source: string;
  lastUpdate: Date | null;
}
export interface RsiLive {
  value: number | null;
  period: number;
  warmupProgress: number;
}
export interface EMA {
  id: number;
  period: number;
  color: string;
}
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
