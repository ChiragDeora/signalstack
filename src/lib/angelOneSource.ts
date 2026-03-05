// ============================================
// Angel One SmartAPI Data Source
// ============================================
// Login with client code + password + TOTP → JWT.
// Historical: getCandleData. Symbol lookup: searchScrip.
// Docs: https://smartapi.angelbroking.com/docs

import crypto from 'crypto';
import { CandleData, PriceData, SearchResult, MarketInfo } from './types';

const ANGEL_BASE = 'https://apiconnect.angelone.in';

// RFC 4648 base32 alphabet
const B32_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(str: string): Buffer {
  str = str.toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const idx = B32_ALPHA.indexOf(str[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

function generateTOTP(secretBase32: string, windowSeconds = 30): string {
  const secret = base32Decode(secretBase32);
  const T = Math.floor(Date.now() / 1000 / windowSeconds);
  const Tbuf = Buffer.allocUnsafe(8);
  Tbuf.writeBigUInt64BE(BigInt(T), 0);
  const hmac = crypto.createHmac('sha1', secret).update(Tbuf).digest();
  const offset = hmac[19]! & 0x0f;
  const code = ((hmac[offset]! & 0x7f) << 24) | (hmac[offset + 1]! << 16) | (hmac[offset + 2]! << 8) | hmac[offset + 3]!;
  const otp = (code % 1_000_000).toString().padStart(6, '0');
  return otp;
}

const INTERVAL_MAP: Record<string, string> = {
  '1m': 'ONE_MINUTE',
  '5m': 'FIVE_MINUTE',
  '15m': 'FIFTEEN_MINUTE',
  '30m': 'THIRTY_MINUTE',
  '1h': 'ONE_HOUR',
  '4h': 'ONE_HOUR',
  '1d': 'ONE_DAY',
};

interface AngelSession {
  jwtToken: string;
  refreshToken: string;
  feedToken: string;
  expiresAt: number;
}

export class AngelOneDataSource {
  private apiKey: string;
  private clientCode: string;
  private password: string;
  private totpSecret: string;
  private session: AngelSession | null = null;

  constructor() {
    this.apiKey = process.env.ANGEL_API_KEY || '';
    this.clientCode = process.env.ANGEL_CLIENT_CODE || '';
    this.password = process.env.ANGEL_PASSWORD || '';
    this.totpSecret = process.env.ANGEL_TOTP_SECRET || '';
  }

  isAvailable(): boolean {
    return !!(this.apiKey && this.clientCode && this.password && this.totpSecret);
  }

  private getHeaders(withAuth = false): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-PrivateKey': this.apiKey,
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': '127.0.0.1',
      'X-ClientPublicIP': '127.0.0.1',
      'X-MACAddress': '000000000000',
    };
    if (withAuth && this.session?.jwtToken) {
      h['Authorization'] = `Bearer ${this.session.jwtToken}`;
    }
    return h;
  }

  private async login(): Promise<boolean> {
    const totp = generateTOTP(this.totpSecret);
    const body = {
      clientcode: this.clientCode,
      password: this.password,
      totp,
    };
    try {
      const res = await fetch(`${ANGEL_BASE}/rest/auth/angelbroking/user/v1/loginByPassword`, {
        method: 'POST',
        headers: this.getHeaders(false),
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { status: boolean; data?: { jwtToken: string; refreshToken: string; feedToken: string } };
      if (!json.status || !json.data?.jwtToken) {
        console.error('❌ Angel One login failed:', (json as any).message || res.status);
        return false;
      }
      this.session = {
        jwtToken: json.data.jwtToken,
        refreshToken: json.data.refreshToken,
        feedToken: json.data.feedToken,
        expiresAt: Date.now() + 23 * 60 * 60 * 1000, // ~1 day
      };
      console.log('✅ Angel One session started');
      return true;
    } catch (e: any) {
      console.error('❌ Angel One login error:', e?.message || e);
      return false;
    }
  }

  private async ensureSession(): Promise<boolean> {
    if (this.session && this.session.expiresAt > Date.now() + 60_000) return true;
    return this.login();
  }

  private async refreshToken(): Promise<boolean> {
    if (!this.session?.refreshToken) return this.login();
    try {
      const res = await fetch(`${ANGEL_BASE}/rest/auth/angelbroking/jwt/v1/generateTokens`, {
        method: 'POST',
        headers: {
          ...this.getHeaders(true),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ refreshToken: this.session.refreshToken }),
      });
      const json = (await res.json()) as { status: boolean; data?: { jwtToken: string; refreshToken: string; feedToken: string } };
      if (!json.status || !json.data?.jwtToken) return this.login();
      this.session = {
        jwtToken: json.data.jwtToken,
        refreshToken: json.data.refreshToken,
        feedToken: json.data.feedToken,
        expiresAt: Date.now() + 23 * 60 * 60 * 1000,
      };
      return true;
    } catch {
      return this.login();
    }
  }

  /** Resolve symbol (e.g. RELIANCE or RELIANCE.NS) to NSE symboltoken for equity */
  async resolveSymbol(symbol: string): Promise<{ symboltoken: string; tradingsymbol: string } | null> {
    await this.ensureSession();
    const clean = symbol.toUpperCase().replace(/\.(NS|BO)$/i, '').trim();
    try {
      const res = await fetch(`${ANGEL_BASE}/rest/secure/angelbroking/order/v1/searchScrip`, {
        method: 'POST',
        headers: this.getHeaders(true),
        body: JSON.stringify({ exchange: 'NSE', searchscrip: clean }),
      });
      if (res.status === 401 || res.status === 403) {
        await this.refreshToken();
        return this.resolveSymbol(symbol);
      }
      const json = (await res.json()) as { status: boolean; data?: Array<{ symboltoken: string; tradingsymbol: string }> };
      if (!json.status || !Array.isArray(json.data)) return null;
      const eq = json.data.find((r) => r.tradingsymbol?.endsWith('-EQ'));
      if (!eq) return null;
      return { symboltoken: eq.symboltoken, tradingsymbol: eq.tradingsymbol };
    } catch (e: any) {
      console.error('Angel searchScrip error:', e?.message);
      return null;
    }
  }

  async fetchHistoricalCandles(symbol: string, timeframe: string, candleCount = 500): Promise<CandleData[]> {
    if (!(await this.ensureSession())) return [];
    const resolved = await this.resolveSymbol(symbol);
    if (!resolved) {
      console.warn(`⚠️  Angel: symbol "${symbol}" not found`);
      return [];
    }
    const interval = INTERVAL_MAP[timeframe] || 'FIVE_MINUTE';
    const toDate = new Date();
    const fromDate = new Date(toDate.getTime() - 90 * 24 * 60 * 60 * 1000);
    const fromStr = fromDate.toISOString().slice(0, 16).replace('T', ' ');
    const toStr = toDate.toISOString().slice(0, 16).replace('T', ' ');
    try {
      const res = await fetch(`${ANGEL_BASE}/rest/secure/angelbroking/historical/v1/getCandleData`, {
        method: 'POST',
        headers: this.getHeaders(true),
        body: JSON.stringify({
          exchange: 'NSE',
          symboltoken: resolved.symboltoken,
          interval,
          fromdate: fromStr,
          todate: toStr,
        }),
      });
      if (res.status === 401 || res.status === 403) {
        await this.refreshToken();
        return this.fetchHistoricalCandles(symbol, timeframe, candleCount);
      }
      const json = (await res.json()) as { status: boolean; data?: Array<string | number>[] };
      if (!json.status || !Array.isArray(json.data)) return [];
      const candles: CandleData[] = json.data
        .map((row) => {
          const [ts, open, high, low, close, vol] = row as [string, number, number, number, number, number];
          const timestamp = typeof ts === 'string' ? new Date(ts).getTime() : (ts as number) * 1000;
          return { timestamp, open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(vol) || 0 };
        })
        .filter((c) => c.close > 0)
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(-candleCount);
      return candles;
    } catch (e: any) {
      console.error('Angel getCandleData error:', e?.message);
      return [];
    }
  }

  /** Fetch live Last Traded Price from Angel One (same as chart). */
  async fetchLTP(symbol: string): Promise<{ ltp: number; open: number; high: number; low: number; close: number } | null> {
    if (!(await this.ensureSession())) return null;
    const resolved = await this.resolveSymbol(symbol);
    if (!resolved) return null;
    try {
      const res = await fetch(`${ANGEL_BASE}/rest/secure/angelbroking/order/v1/getLtpData`, {
        method: 'POST',
        headers: this.getHeaders(true),
        body: JSON.stringify({
          exchange: 'NSE',
          tradingsymbol: resolved.tradingsymbol,
          symboltoken: resolved.symboltoken,
        }),
      });
      if (res.status === 401 || res.status === 403) {
        await this.refreshToken();
        return this.fetchLTP(symbol);
      }
      const json = (await res.json()) as {
        status: boolean;
        data?: { ltp: string; open?: string; high?: string; low?: string; close?: string };
      };
      if (!json.status || !json.data?.ltp) return null;
      const ltp = parseFloat(String(json.data.ltp));
      const open = parseFloat(String(json.data.open ?? 0)) || ltp;
      const high = parseFloat(String(json.data.high ?? 0)) || ltp;
      const low = parseFloat(String(json.data.low ?? 0)) || ltp;
      const close = parseFloat(String(json.data.close ?? 0)) || ltp;
      return { ltp, open, high, low, close };
    } catch (e: any) {
      console.error('Angel getLtpData error:', e?.message);
      return null;
    }
  }

  async fetchTimeframeData(symbol: string, timeframe: string): Promise<PriceData | null> {
    const candles = await this.fetchHistoricalCandles(symbol, timeframe, 500);
    if (candles.length === 0) return null;
    const latestCandle = candles[candles.length - 1]!;
    const previousCandle = candles.length > 1 ? candles[candles.length - 2]! : latestCandle;

    // Use live LTP so displayed price matches Angel One chart; fallback to last candle close
    const ltpData = await this.fetchLTP(symbol);
    const price = ltpData ? ltpData.ltp : latestCandle.close;
    const change = price - previousCandle.close;
    const changePercent = previousCandle.close !== 0 ? (change / previousCandle.close) * 100 : 0;

    const market: MarketInfo = {
      name: 'NSE',
      exchange: 'NSE',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
      country: 'India',
      openTime: '09:15',
      closeTime: '15:30',
    };
    return {
      symbol,
      price,
      source: `Angel One (${timeframe})`,
      currency: 'INR',
      change: parseFloat(change.toFixed(2)),
      changePercent: parseFloat(changePercent.toFixed(2)),
      volume: latestCandle.volume,
      timestamp: new Date().toISOString(),
      timeframe,
      candleData: candles,
      market,
    };
  }

  async searchSymbols(query: string): Promise<SearchResult[]> {
    if (!query || query.length < 1) return [];
    await this.ensureSession();
    try {
      const res = await fetch(`${ANGEL_BASE}/rest/secure/angelbroking/order/v1/searchScrip`, {
        method: 'POST',
        headers: this.getHeaders(true),
        body: JSON.stringify({ exchange: 'NSE', searchscrip: query.toUpperCase().trim() }),
      });
      if (res.status === 401 || res.status === 403) {
        await this.refreshToken();
        return this.searchSymbols(query);
      }
      const json = (await res.json()) as { status: boolean; data?: Array<{ symboltoken: string; tradingsymbol: string }> };
      if (!json.status || !Array.isArray(json.data)) return [];
      return json.data
        .filter((r) => r.tradingsymbol?.endsWith('-EQ'))
        .slice(0, 20)
        .map((r) => ({
          symbol: r.tradingsymbol.replace(/-EQ$/, ''),
          name: `${r.tradingsymbol.replace(/-EQ$/, '')} (NSE)`,
          exchange: 'NSE',
          currency: 'INR',
          country: 'India',
          type: 'Equity',
        }));
    } catch (e: any) {
      console.error('Angel searchSymbols error:', e?.message);
      return [];
    }
  }
}

let angelInstance: AngelOneDataSource | null = null;
export function getAngelOneSource(): AngelOneDataSource {
  if (!angelInstance) angelInstance = new AngelOneDataSource();
  return angelInstance;
}
