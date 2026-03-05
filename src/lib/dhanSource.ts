// ============================================
// Dhan HQ API Data Source (v2)
// ============================================
// REST API for historical & live market data from Dhan.
// Env vars needed:
//   DHAN_ACCESS_TOKEN  - Access token from Dhan portal
//   DHAN_CLIENT_ID     - Client ID from Dhan portal
//
// Historical data:
//   POST https://api.dhan.co/v2/charts/historical  (daily candles)
//   POST https://api.dhan.co/v2/charts/intraday    (1/5/15/25/60 min candles)
//
// Live quote:
//   POST https://api.dhan.co/v2/marketfeed/ltp
//
// Instruments list (for symbol lookup):
//   https://images.dhan.co/api-data/api-scrip-master.csv

import fs from 'fs';
import path from 'path';
import { CandleData, PriceData, SearchResult, MarketInfo } from './types';

const DHAN_BASE_URL = 'https://api.dhan.co/v2';
const SCRIP_MASTER_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';

// Disk cache — stored in .scrip-cache.json next to this file so it survives
// process restarts. Only re-downloaded when older than SCRIP_CACHE_TTL_MS.
const DISK_CACHE_PATH = path.join(process.cwd(), '.scrip-cache.json');

// Dhan exchange segment enum values
type ExchangeSegment =
  | 'NSE_EQ'
  | 'BSE_EQ'
  | 'NSE_FNO'
  | 'BSE_FNO'
  | 'NSE_CURRENCY'
  | 'BSE_CURRENCY'
  | 'MCX_COMM'
  | 'IDX_I';

// Dhan intraday intervals (minutes)
type DhanInterval = '1' | '5' | '15' | '25' | '60';

// Map app timeframe IDs to Dhan interval strings
const INTERVAL_MAP: Record<string, DhanInterval | 'daily'> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '25m': '25',
  '30m': '60',  // closest available above 30m
  '1h': '60',
  '4h': '60',   // Dhan max intraday is 60m; aggregate client-side if needed
  '1d': 'daily',
};

// Rate limiting state
interface RateLimit {
  dataCallsToday: number;
  quoteCallsThisSecond: number;
  lastSecondReset: number;
  lastDayReset: number;
}

interface ScripEntry {
  securityId: string;
  exchangeSegment: ExchangeSegment;
  tradingSymbol: string;
  name: string;
}

const SCRIP_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // refresh every 6 hours

// Store cache on `global` so it survives Next.js hot-module reloads in dev.
// An in-flight promise deduplicates concurrent callers so the CSV is only
// fetched once even when multiple requests arrive before the first resolves.
declare global {
  // eslint-disable-next-line no-var
  var __dhanScripCache: Map<string, ScripEntry> | null;
  // eslint-disable-next-line no-var
  var __dhanScripFetchedAt: number;
  // eslint-disable-next-line no-var
  var __dhanScripInflight: Promise<Map<string, ScripEntry>> | null;
}

if (!global.__dhanScripCache)      global.__dhanScripCache      = null;
if (!global.__dhanScripFetchedAt)  global.__dhanScripFetchedAt  = 0;
if (!global.__dhanScripInflight)   global.__dhanScripInflight   = null;

export class DhanDataSource {
  private accessToken: string;
  private clientId: string;
  private rateLimit: RateLimit = {
    dataCallsToday: 0,
    quoteCallsThisSecond: 0,
    lastSecondReset: Date.now(),
    lastDayReset: Date.now(),
  };

  constructor() {
    this.accessToken = process.env.DHAN_ACCESS_TOKEN || '';
    this.clientId = process.env.DHAN_CLIENT_ID || '';
  }

  isAvailable(): boolean {
    return !!(this.accessToken && this.clientId);
  }

  // ----------------------------------------------------------------
  // Rate-limit helpers
  // ----------------------------------------------------------------

  private checkDataRateLimit(): boolean {
    const now = Date.now();
    if (now - this.rateLimit.lastDayReset > 86_400_000) {
      this.rateLimit.dataCallsToday = 0;
      this.rateLimit.lastDayReset = now;
    }
    if (this.rateLimit.dataCallsToday >= 95_000) {
      console.warn('⚠️  Dhan rate limit: approaching 100k data calls/day');
      return false;
    }
    this.rateLimit.dataCallsToday++;
    return true;
  }

  private checkQuoteRateLimit(): boolean {
    const now = Date.now();
    if (now - this.rateLimit.lastSecondReset > 1_000) {
      this.rateLimit.quoteCallsThisSecond = 0;
      this.rateLimit.lastSecondReset = now;
    }
    if (this.rateLimit.quoteCallsThisSecond >= 1) {
      return false;
    }
    this.rateLimit.quoteCallsThisSecond++;
    return true;
  }

  // ----------------------------------------------------------------
  // HTTP helpers
  // ----------------------------------------------------------------

  private get headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'access-token': this.accessToken,
      'client-id': this.clientId,
    };
  }

  private async post<T>(path: string, body: object): Promise<T | null> {
    try {
      const res = await fetch(`${DHAN_BASE_URL}${path}`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`❌ Dhan API ${path} error ${res.status}: ${text}`);
        return null;
      }

      return (await res.json()) as T;
    } catch (error: any) {
      console.error(`❌ Dhan API ${path} fetch error:`, error?.message || error);
      return null;
    }
  }

  // ----------------------------------------------------------------
  // Scrip master CSV — dynamic symbol resolution
  // ----------------------------------------------------------------

  /**
   * Load and cache the Dhan scrip master CSV.
   *
   * Uses a global cache (survives Next.js HMR reloads) and an in-flight
   * promise so concurrent callers all await the same single fetch instead
   * of each firing their own request.
   */
  private async loadScripMaster(): Promise<Map<string, ScripEntry>> {
    const now = Date.now();

    // Return cached copy if still fresh
    if (global.__dhanScripCache && now - global.__dhanScripFetchedAt < SCRIP_CACHE_TTL_MS) {
      return global.__dhanScripCache;
    }

    // If another caller is already fetching, piggyback on that promise
    if (global.__dhanScripInflight) {
      return global.__dhanScripInflight;
    }

    // Start a new fetch and store the promise so concurrent callers share it
    global.__dhanScripInflight = this.fetchAndParseScripMaster().finally(() => {
      global.__dhanScripInflight = null;
    });

    return global.__dhanScripInflight;
  }

  private async fetchAndParseScripMaster(): Promise<Map<string, ScripEntry>> {
    // 1. Try loading from disk cache first (instant — avoids re-downloading)
    try {
      if (fs.existsSync(DISK_CACHE_PATH)) {
        const stat = fs.statSync(DISK_CACHE_PATH);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs < SCRIP_CACHE_TTL_MS) {
          console.log('📂 Loading Dhan scrip master from disk cache...');
          const raw = fs.readFileSync(DISK_CACHE_PATH, 'utf8');
          const entries: [string, ScripEntry][] = JSON.parse(raw);
          const map = new Map<string, ScripEntry>(entries);
          global.__dhanScripCache     = map;
          global.__dhanScripFetchedAt = stat.mtimeMs;
          console.log(`✅ Scrip master loaded from disk: ${map.size} symbols`);
          return map;
        }
      }
    } catch (diskErr: any) {
      console.warn('⚠️  Disk cache read failed, will re-download:', diskErr?.message);
    }

    // 2. Download from Dhan CDN
    console.log('📥 Downloading Dhan scrip master CSV (this takes ~30s, cached after)...');
    try {
      const res = await fetch(SCRIP_MASTER_URL);
      if (!res.ok) {
        console.error(`❌ Failed to fetch scrip master: ${res.status}`);
        return global.__dhanScripCache ?? new Map();
      }

      const csv = await res.text();
      const lines = csv.split('\n');
      if (lines.length < 2) return global.__dhanScripCache ?? new Map();

      const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
      const colIdx = (name: string) => headers.indexOf(name);

      const idxSecId    = colIdx('SEM_SMST_SECURITY_ID');
      const idxExch     = colIdx('SEM_EXM_EXCH_ID');
      const idxTradeSym = colIdx('SEM_TRADING_SYMBOL');
      const idxName     = colIdx('SEM_CUSTOM_SYMBOL');
      const idxInstr    = colIdx('SEM_INSTRUMENT_NAME');

      const map = new Map<string, ScripEntry>();

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const cols = this.parseCSVLine(line);
        if (cols.length <= Math.max(idxSecId, idxExch, idxTradeSym)) continue;

        const securityId = cols[idxSecId]?.trim();
        const exchId     = cols[idxExch]?.trim().toUpperCase();
        const tradingSym = cols[idxTradeSym]?.trim().toUpperCase();
        const customSym  = idxName >= 0 ? cols[idxName]?.trim().toUpperCase() : '';
        const instrName  = idxInstr >= 0 ? cols[idxInstr]?.trim().toUpperCase() : '';

        if (!securityId || !exchId || !tradingSym) continue;

        const segment = this.exchIdToSegment(exchId, instrName);
        if (!segment) continue;

        const entry: ScripEntry = {
          securityId,
          exchangeSegment: segment,
          tradingSymbol: tradingSym,
          name: customSym || tradingSym,
        };

        const nseKey = tradingSym;
        const bseKey = `${tradingSym}.BO`;

        if (segment === 'NSE_EQ' || segment === 'IDX_I') {
          if (!map.has(nseKey)) map.set(nseKey, entry);
        } else if (segment === 'BSE_EQ') {
          if (!map.has(bseKey)) map.set(bseKey, entry);
          if (!map.has(nseKey)) map.set(nseKey, entry);
        }
      }

      global.__dhanScripCache     = map;
      global.__dhanScripFetchedAt = Date.now();
      console.log(`✅ Dhan scrip master downloaded: ${map.size} symbols`);

      // 3. Save to disk so next startup is instant
      try {
        fs.writeFileSync(DISK_CACHE_PATH, JSON.stringify([...map.entries()]));
        console.log('💾 Scrip master saved to disk cache');
      } catch (writeErr: any) {
        console.warn('⚠️  Could not save scrip master to disk:', writeErr?.message);
      }

      return map;
    } catch (err: any) {
      console.error('❌ Scrip master load error:', err?.message || err);
      return global.__dhanScripCache ?? new Map();
    }
  }

  private parseCSVLine(line: string): string[] {
    const cols: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        cols.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    cols.push(current);
    return cols;
  }

  private exchIdToSegment(exchId: string, instrName: string): ExchangeSegment | null {
    if (exchId === 'NSE') {
      if (instrName === 'INDEX') return 'IDX_I';
      if (instrName === 'EQUITY' || instrName === 'EQ' || instrName === '') return 'NSE_EQ';
      return null; // skip FNO, currency etc.
    }
    if (exchId === 'BSE') {
      if (instrName === 'EQUITY' || instrName === 'EQ' || instrName === '') return 'BSE_EQ';
      return null;
    }
    if (exchId === 'IDX') return 'IDX_I';
    return null;
  }

  // ----------------------------------------------------------------
  // Symbol → SecurityId resolution
  // ----------------------------------------------------------------

  /**
   * Resolve a symbol string like "RELIANCE", "TCS", "RELIANCE.NS", "RELIANCE.BO"
   * to a { securityId, exchangeSegment } pair using the scrip master.
   */
  async resolveSymbolAsync(symbol: string): Promise<{ securityId: string; exchangeSegment: ExchangeSegment } | null> {
    const isBSE = /\.BO$/i.test(symbol);
    const clean = symbol.toUpperCase().replace(/\.(NS|BO)$/i, '').trim();
    const lookupKey = isBSE ? `${clean}.BO` : clean;

    const map = await this.loadScripMaster();
    const entry = map.get(lookupKey) ?? map.get(clean);
    if (entry) {
      if (isBSE && entry.exchangeSegment === 'NSE_EQ') {
        return { securityId: entry.securityId, exchangeSegment: 'BSE_EQ' };
      }
      return { securityId: entry.securityId, exchangeSegment: entry.exchangeSegment };
    }

    console.warn(`⚠️  Dhan: symbol "${symbol}" not found in scrip master`);
    return null;
  }

  // ----------------------------------------------------------------
  // Historical candle data
  // ----------------------------------------------------------------

  private getDateRange(
    timeframe: string,
    candleCount: number,
  ): { fromDate: string; toDate: string } {
    const now = new Date();
    const toDate = now.toISOString().split('T')[0];

    const minutesPerCandle: Record<string, number> = {
      '1m': 1, '5m': 5, '15m': 15, '25m': 25,
      '30m': 60, '1h': 60, '4h': 240, '1d': 1440,
    };

    const mins = (minutesPerCandle[timeframe] || 5) * candleCount;
    const fromMs = now.getTime() - mins * 60_000;
    // Dhan caps intraday history at 90 days
    const cappedFromMs = Math.max(fromMs, now.getTime() - 89 * 86_400_000);
    const fromDate = new Date(cappedFromMs).toISOString().split('T')[0];

    return { fromDate, toDate };
  }

  async fetchHistoricalCandles(
    symbol: string,
    timeframe: string,
    candleCount: number = 500,
  ): Promise<CandleData[]> {
    if (!this.isAvailable()) return [];
    if (!this.checkDataRateLimit()) return [];

    const resolved = await this.resolveSymbolAsync(symbol);
    if (!resolved) {
      console.warn(`⚠️  Dhan: could not resolve symbol "${symbol}"`);
      return [];
    }

    const { securityId, exchangeSegment } = resolved;
    const dhanInterval = INTERVAL_MAP[timeframe] ?? '5';
    const isDaily = dhanInterval === 'daily';

    const { fromDate, toDate } = this.getDateRange(timeframe, candleCount);

    interface DhanCandleResponse {
      open: number[];
      high: number[];
      low: number[];
      close: number[];
      volume: number[];
      timestamp: number[];
    }

    let data: DhanCandleResponse | null;

    if (isDaily) {
      data = await this.post<DhanCandleResponse>('/charts/historical', {
        securityId,
        exchangeSegment,
        instrument: exchangeSegment === 'IDX_I' ? 'INDEX' : 'EQUITY',
        expiryCode: 0,
        oi: false,
        fromDate,
        toDate,
      });
    } else {
      const fromDateTime = `${fromDate} 09:15:00`;
      const toDateTime   = `${toDate} 15:30:00`;

      data = await this.post<DhanCandleResponse>('/charts/intraday', {
        securityId,
        exchangeSegment,
        instrument: exchangeSegment === 'IDX_I' ? 'INDEX' : 'EQUITY',
        interval: dhanInterval,
        oi: false,
        fromDate: fromDateTime,
        toDate: toDateTime,
      });
    }

    if (!data || !Array.isArray(data.timestamp) || data.timestamp.length === 0) {
      console.warn(`⚠️  Dhan: no candle data for ${symbol} (${timeframe})`);
      return [];
    }

    const candles: CandleData[] = data.timestamp
      .map((ts, i) => ({
        timestamp: ts * 1000,
        open:   data!.open[i]   ?? 0,
        high:   data!.high[i]   ?? 0,
        low:    data!.low[i]    ?? 0,
        close:  data!.close[i]  ?? 0,
        volume: data!.volume[i] ?? 0,
      }))
      .filter(c => c.close > 0)
      .sort((a, b) => a.timestamp - b.timestamp);

    console.log(`✅ Dhan: ${candles.length} candles for ${symbol} (${timeframe})`);
    return candles;
  }

  // ----------------------------------------------------------------
  // Live LTP quote
  // ----------------------------------------------------------------

  async fetchLTP(symbol: string): Promise<number | null> {
    if (!this.isAvailable()) return null;
    if (!this.checkQuoteRateLimit()) return null;

    const resolved = await this.resolveSymbolAsync(symbol);
    if (!resolved) return null;

    const { securityId, exchangeSegment } = resolved;

    interface LTPResponse {
      status: string;
      data: Record<string, Record<string, { last_price: number }>>;
    }

    const data = await this.post<LTPResponse>('/marketfeed/ltp', {
      [exchangeSegment]: [parseInt(securityId, 10)],
    });

    if (data?.status !== 'success') return null;

    const segData = data.data?.[exchangeSegment];
    if (!segData) return null;

    const entry = segData[securityId];
    return entry?.last_price ?? null;
  }

  // ----------------------------------------------------------------
  // PriceData (unified interface)
  // ----------------------------------------------------------------

  async fetchTimeframeData(symbol: string, timeframe: string): Promise<PriceData | null> {
    if (!this.isAvailable()) return null;

    const candles = await this.fetchHistoricalCandles(symbol, timeframe, 500);
    if (candles.length === 0) return null;

    const latest   = candles[candles.length - 1];
    const previous = candles.length > 1 ? candles[candles.length - 2] : latest;
    const change   = latest.close - previous.close;
    const changePercent = previous.close !== 0 ? (change / previous.close) * 100 : 0;

    const resolved = await this.resolveSymbolAsync(symbol);
    const exchangeSegment = resolved?.exchangeSegment ?? 'NSE_EQ';
    const market = this.getMarketInfo(exchangeSegment);

    return {
      symbol,
      price: latest.close,
      source: `Dhan (${timeframe})`,
      currency: market.currency,
      change:        parseFloat(change.toFixed(2)),
      changePercent: parseFloat(changePercent.toFixed(2)),
      volume: latest.volume,
      timestamp: new Date().toISOString(),
      timeframe,
      candleData: candles,
      market,
    };
  }

  // ----------------------------------------------------------------
  // Symbol search (uses scrip master)
  // ----------------------------------------------------------------

  async searchSymbols(query: string): Promise<SearchResult[]> {
    if (!query || query.length < 1) return [];

    const upperQuery = query.toUpperCase().trim();
    const map = await this.loadScripMaster();
    const results: SearchResult[] = [];
    const seen = new Set<string>();

    for (const [key, entry] of map) {
      if (!entry.tradingSymbol.startsWith(upperQuery)) continue;
      if (seen.has(entry.tradingSymbol)) continue;
      seen.add(entry.tradingSymbol);

      const isIndex = entry.exchangeSegment === 'IDX_I';
      const exchange = entry.exchangeSegment.startsWith('BSE') ? 'BSE' : 'NSE';

      results.push({
        symbol: entry.tradingSymbol,
        name: `${entry.name} (${exchange})`,
        exchange,
        currency: 'INR',
        country: 'India',
        type: isIndex ? 'Index' : 'Equity',
      });

      if (results.length >= 20) break;
    }

    // If scrip master has no results yet, fall back to suggestions
    if (results.length === 0) {
      results.push(
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
      );
    }

    return results;
  }

  // ----------------------------------------------------------------
  // Market metadata
  // ----------------------------------------------------------------

  private getMarketInfo(exchangeSegment: ExchangeSegment): MarketInfo {
    const markets: Partial<Record<ExchangeSegment, MarketInfo>> = {
      NSE_EQ: {
        name: 'National Stock Exchange of India',
        exchange: 'NSE',
        timezone: 'Asia/Kolkata',
        currency: 'INR',
        country: 'India',
        openTime: '09:15',
        closeTime: '15:30',
      },
      BSE_EQ: {
        name: 'Bombay Stock Exchange',
        exchange: 'BSE',
        timezone: 'Asia/Kolkata',
        currency: 'INR',
        country: 'India',
        openTime: '09:15',
        closeTime: '15:30',
      },
      IDX_I: {
        name: 'NSE Index',
        exchange: 'NSE',
        timezone: 'Asia/Kolkata',
        currency: 'INR',
        country: 'India',
        openTime: '09:15',
        closeTime: '15:30',
      },
      MCX_COMM: {
        name: 'Multi Commodity Exchange',
        exchange: 'MCX',
        timezone: 'Asia/Kolkata',
        currency: 'INR',
        country: 'India',
        openTime: '09:00',
        closeTime: '23:30',
      },
    };

    return markets[exchangeSegment] ?? markets.NSE_EQ!;
  }

  reload(): void {
    this.accessToken = process.env.DHAN_ACCESS_TOKEN || '';
    this.clientId    = process.env.DHAN_CLIENT_ID    || '';
  }
}

// Module-level singleton
let instance: DhanDataSource | null = null;

export function getDhanSource(): DhanDataSource {
  if (!instance) {
    instance = new DhanDataSource();
  }
  return instance;
}
