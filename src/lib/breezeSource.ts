// ============================================
// ICICI Direct Breeze API Data Source
// ============================================
// Uses the official `breezeconnect` npm package.
// Env vars needed:
//   BREEZE_API_KEY      - App key from Breeze portal
//   BREEZE_SECRET_KEY   - Secret key from Breeze portal
//   BREEZE_SESSION_TOKEN - Session token (refreshed daily via ICICI login)

import { CandleData, PriceData, SearchResult, MarketInfo } from './types';

// Dynamic require to prevent webpack from statically bundling breezeconnect
// (it has native deps like adm-zip that break Next.js build)
let BreezeConnect: any = null;
function loadBreezeConnect(): any {
  if (BreezeConnect) return BreezeConnect;
  try {
    const mod = 'breezeconnect';
    BreezeConnect = require(mod).BreezeConnect;
  } catch {
    // breezeconnect not installed — will run without it
  }
  return BreezeConnect;
}

// Rate limiting state
interface RateLimit {
  callsThisMinute: number;
  callsToday: number;
  lastMinuteReset: number;
  lastDayReset: number;
}

export class BreezeDataSource {
  private breeze: any = null;
  private connected = false;
  private apiKey: string;
  private secretKey: string;
  private sessionToken: string;
  private rateLimit: RateLimit = {
    callsThisMinute: 0,
    callsToday: 0,
    lastMinuteReset: Date.now(),
    lastDayReset: Date.now(),
  };

  // Map app timeframe IDs to Breeze interval strings
  private static INTERVAL_MAP: Record<string, string> = {
    '1m': '1minute',
    '5m': '5minute',
    '15m': '5minute',   // Breeze doesn't have 15m, use 5m
    '30m': '30minute',
    '1h': '30minute',   // Breeze doesn't have 1h, use 30m
    '4h': '30minute',   // Breeze doesn't have 4h, use 30m
    '1d': '1day',
  };

  constructor() {
    this.apiKey = process.env.BREEZE_API_KEY || '';
    this.secretKey = process.env.BREEZE_SECRET_KEY || '';
    this.sessionToken = process.env.BREEZE_SESSION_TOKEN || '';
  }

  /**
   * Check if Breeze API credentials are configured
   */
  isAvailable(): boolean {
    return !!(loadBreezeConnect() && this.apiKey && this.secretKey && this.sessionToken);
  }

  /**
   * Connect to Breeze API and generate session
   */
  async connect(): Promise<boolean> {
    if (!this.isAvailable()) {
      console.log('⚠️  Breeze API not configured, skipping');
      return false;
    }

    try {
      const BC = loadBreezeConnect();
      this.breeze = new BC({ appKey: this.apiKey });
      await this.breeze.generateSession(this.secretKey, this.sessionToken);
      this.connected = true;
      console.log('✅ Breeze API connected successfully');
      return true;
    } catch (error: any) {
      console.error('❌ Breeze API connection failed:', error?.message || error);
      this.connected = false;
      return false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Reload credentials from env and reconnect.
   * Called automatically after the daily token refresh cron job.
   */
  async reconnect(): Promise<boolean> {
    this.apiKey = process.env.BREEZE_API_KEY || '';
    this.secretKey = process.env.BREEZE_SECRET_KEY || '';
    this.sessionToken = process.env.BREEZE_SESSION_TOKEN || '';
    this.connected = false;
    this.breeze = null;
    console.log('🔄 Breeze: reconnecting with refreshed session token...');
    return this.connect();
  }

  /**
   * Check rate limits before making a call
   */
  private checkRateLimit(): boolean {
    const now = Date.now();

    // Reset minute counter
    if (now - this.rateLimit.lastMinuteReset > 60_000) {
      this.rateLimit.callsThisMinute = 0;
      this.rateLimit.lastMinuteReset = now;
    }

    // Reset daily counter
    if (now - this.rateLimit.lastDayReset > 86_400_000) {
      this.rateLimit.callsToday = 0;
      this.rateLimit.lastDayReset = now;
    }

    if (this.rateLimit.callsThisMinute >= 90) {
      console.warn('⚠️  Breeze rate limit: approaching 100 calls/minute');
      return false;
    }

    if (this.rateLimit.callsToday >= 4500) {
      console.warn('⚠️  Breeze rate limit: approaching 5000 calls/day');
      return false;
    }

    this.rateLimit.callsThisMinute++;
    this.rateLimit.callsToday++;
    return true;
  }

  /**
   * Get the Breeze interval string for a timeframe
   */
  private getBreezeInterval(timeframe: string): string {
    return BreezeDataSource.INTERVAL_MAP[timeframe] || '1minute';
  }

  /**
   * Calculate how many candles to request for EMA warmup.
   * We need at least maxEmaPeriod * 2 candles.
   */
  private getHistoryRange(timeframe: string, candleCount: number = 500): { from: Date; to: Date } {
    const now = new Date();
    const to = new Date(now);

    const minutesPerCandle: Record<string, number> = {
      '1m': 1, '5m': 5, '15m': 15, '30m': 30,
      '1h': 60, '4h': 240, '1d': 1440,
    };

    const mins = (minutesPerCandle[timeframe] || 5) * candleCount;
    const from = new Date(now.getTime() - mins * 60_000);

    return { from, to };
  }

  /**
   * Fetch historical OHLCV candle data
   */
  async fetchHistoricalCandles(
    stockCode: string,
    timeframe: string,
    candleCount: number = 500,
    exchangeCode: string = 'NSE',
  ): Promise<CandleData[]> {
    if (!this.connected || !this.breeze) return [];
    if (!this.checkRateLimit()) return [];

    try {
      const interval = this.getBreezeInterval(timeframe);
      const { from, to } = this.getHistoryRange(timeframe, candleCount);

      const response = await this.breeze.getHistoricalData({
        interval,
        fromDate: from.toISOString(),
        toDate: to.toISOString(),
        stockCode: stockCode.toUpperCase(),
        exchangeCode: exchangeCode.toUpperCase(),
        productType: 'cash',
      });

      if (!response?.Success || !Array.isArray(response.Success)) {
        console.warn(`⚠️  Breeze: no historical data for ${stockCode}`);
        return [];
      }

      const candles: CandleData[] = response.Success
        .map((item: any) => ({
          timestamp: new Date(item.datetime || item.date).getTime(),
          open: parseFloat(item.open) || 0,
          high: parseFloat(item.high) || 0,
          low: parseFloat(item.low) || 0,
          close: parseFloat(item.close) || 0,
          volume: parseInt(item.volume) || 0,
        }))
        .filter((c: CandleData) => c.close > 0)
        .sort((a: CandleData, b: CandleData) => a.timestamp - b.timestamp);

      console.log(`✅ Breeze: ${candles.length} candles for ${stockCode} (${interval})`);
      return candles;
    } catch (error: any) {
      console.error(`❌ Breeze historical data error for ${stockCode}:`, error?.message || error);
      return [];
    }
  }

  /**
   * Fetch current price data for a symbol
   */
  async fetchTimeframeData(symbol: string, timeframe: string): Promise<PriceData | null> {
    if (!this.connected || !this.breeze) return null;
    if (!this.checkRateLimit()) return null;

    try {
      const cleanSymbol = symbol.toUpperCase().replace(/\.NS$/, '').replace(/\.BO$/, '');
      const exchangeCode = symbol.toUpperCase().includes('.BO') ? 'BSE' : 'NSE';

      // Fetch recent candles to get current price + history
      const candles = await this.fetchHistoricalCandles(cleanSymbol, timeframe, 500, exchangeCode);

      if (candles.length === 0) return null;

      const latest = candles[candles.length - 1];
      const previous = candles.length > 1 ? candles[candles.length - 2] : latest;
      const change = latest.close - previous.close;
      const changePercent = previous.close !== 0 ? (change / previous.close) * 100 : 0;

      const market = this.getMarketInfo(exchangeCode);

      return {
        symbol,
        price: latest.close,
        source: `Breeze (${timeframe})`,
        currency: market.currency,
        change: parseFloat(change.toFixed(2)),
        changePercent: parseFloat(changePercent.toFixed(2)),
        volume: latest.volume,
        timestamp: new Date().toISOString(),
        timeframe,
        candleData: candles,
        market,
      };
    } catch (error: any) {
      console.error(`❌ Breeze price fetch error for ${symbol}:`, error?.message || error);
      return null;
    }
  }

  /**
   * Search symbols - Breeze uses ICICI-specific stock codes
   * For now we return a simple lookup. Users should type stock codes directly.
   */
  async searchSymbols(query: string): Promise<SearchResult[]> {
    // Breeze doesn't have a search API. Users type stock codes directly (e.g., "RELIANCE", "TCS").
    // We return the query as a potential NSE/BSE symbol.
    if (!query || query.length < 1) return [];

    const upperQuery = query.toUpperCase().trim();
    const results: SearchResult[] = [
      {
        symbol: upperQuery,
        name: `${upperQuery} (NSE)`,
        exchange: 'NSE',
        currency: 'INR',
        country: 'India',
        type: 'Equity',
      },
      {
        symbol: `${upperQuery}.BO`,
        name: `${upperQuery} (BSE)`,
        exchange: 'BSE',
        currency: 'INR',
        country: 'India',
        type: 'Equity',
      },
    ];

    return results;
  }

  /**
   * Connect to Breeze WebSocket for real-time tick data
   */
  async connectWebSocket(): Promise<boolean> {
    if (!this.connected || !this.breeze) return false;

    try {
      await this.breeze.wsConnect();
      console.log('✅ Breeze WebSocket connected');
      return true;
    } catch (error: any) {
      console.error('❌ Breeze WebSocket connection failed:', error?.message || error);
      return false;
    }
  }

  /**
   * Subscribe to real-time feed for a stock.
   * Callback receives tick data on each update.
   */
  async subscribeFeed(
    stockCode: string,
    exchangeCode: string = 'NSE',
    interval: string = '1minute',
    onTick: (tick: any) => void,
  ): Promise<boolean> {
    if (!this.connected || !this.breeze) return false;

    try {
      this.breeze.on_ticks = onTick;
      await this.breeze.subscribeFeeds({
        exchangeCode,
        stockCode: stockCode.toUpperCase(),
        productType: 'cash',
        getExchangeQuotes: true,
        getMarketDepth: false,
        interval,
      });
      console.log(`✅ Breeze: subscribed to ${stockCode} feed`);
      return true;
    } catch (error: any) {
      console.error(`❌ Breeze subscribe error for ${stockCode}:`, error?.message || error);
      return false;
    }
  }

  /**
   * Unsubscribe from real-time feed
   */
  async unsubscribeFeed(stockCode: string, exchangeCode: string = 'NSE'): Promise<void> {
    if (!this.connected || !this.breeze) return;
    try {
      await this.breeze.unsubscribeFeeds({
        exchangeCode,
        stockCode: stockCode.toUpperCase(),
        productType: 'cash',
      });
    } catch (error: any) {
      console.error(`Breeze unsubscribe error:`, error?.message || error);
    }
  }

  /**
   * Disconnect WebSocket
   */
  async disconnectWebSocket(): Promise<void> {
    if (!this.breeze) return;
    try {
      await this.breeze.wsDisconnect();
    } catch {
      // ignore
    }
  }

  private getMarketInfo(exchangeCode: string): MarketInfo {
    const markets: Record<string, MarketInfo> = {
      NSE: {
        name: 'National Stock Exchange of India',
        exchange: 'NSE',
        timezone: 'Asia/Kolkata',
        currency: 'INR',
        country: 'India',
        openTime: '09:15',
        closeTime: '15:30',
      },
      BSE: {
        name: 'Bombay Stock Exchange',
        exchange: 'BSE',
        timezone: 'Asia/Kolkata',
        currency: 'INR',
        country: 'India',
        openTime: '09:15',
        closeTime: '15:30',
      },
    };
    return markets[exchangeCode] || markets.NSE;
  }
}

// Module-level singleton so the connection persists across requests
let instance: BreezeDataSource | null = null;

export function getBreezeSource(): BreezeDataSource {
  if (!instance) {
    instance = new BreezeDataSource();
  }
  return instance;
}
