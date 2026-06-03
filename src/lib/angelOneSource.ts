// ============================================
// Angel One SmartAPI Data Source
// ============================================
// Login with client code + password + TOTP → JWT.
// Historical: getCandleData. Symbol lookup: searchScrip.
// Margin Calculator (NSE/BSE, mode FULL): https://smartapi.angelbroking.com/docs/MarginCalculator
// Docs: https://smartapi.angelbroking.com/docs

import crypto from 'crypto';
import { CandleData, PriceData, SearchResult, MarketInfo } from './types';

// Official SmartAPI: single host for all endpoints (from Angel One Python SDK)
const ANGEL_BASE = 'https://apiconnect.angelone.in';
// Public scrip master when searchScrip API returns Access denied / INTERNAL SERVER ERROR
const SCRIP_MASTER_URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';

type ScripRow = { token?: string; symbol?: string; name?: string; exch_seg?: string; instrumenttype?: string; expiry?: string };

/** Parse scrip master expiry "25JAN2024" or "28OCT2025" (DDMMMYYYY) to timestamp for sorting. */
function parseExpiry(expiry: string | undefined): number {
  if (!expiry || !/^\d{2}[A-Z]{3}\d{4}$/i.test(expiry.trim())) return 0;
  const months: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const d = expiry.trim().toUpperCase();
  const day = parseInt(d.slice(0, 2), 10);
  const mon = months[d.slice(2, 5)] ?? 0;
  const year = parseInt(d.slice(5, 9), 10);
  return new Date(year, mon, day).getTime();
}
let scripMasterCache: ScripRow[] | null = null;
let scripMasterFetchedAt = 0;
const SCRIP_MASTER_TTL_MS = 60 * 60 * 1000; // 1 hour

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

// Max historical span per interval, based on Angel One docs.
// If we exceed these, Angel often returns status=false with no data.
const INTERVAL_MAX_DAYS: Record<string, number> = {
  ONE_MINUTE: 30,
  FIVE_MINUTE: 90,
  FIFTEEN_MINUTE: 90,
  THIRTY_MINUTE: 180,
  ONE_HOUR: 365,
  ONE_DAY: 2000,
};

interface AngelSession {
  jwtToken: string;
  refreshToken: string;
  feedToken: string;
  expiresAt: number;
}

/**
 * Detect whether a query looks like an NFO trading symbol (or partial).
 * NFO symbols contain a date pattern like 17MAR26 or 28DEC2347700CE.
 * Human queries like "Nifty 50", "Bank Nifty", "Ni" do NOT match.
 * searchScrip API only works for NFO with symbol-ish input; human names
 * cause the server to return HTML errors (not auth failures).
 */
function looksLikeNfoSymbol(query: string): boolean {
  const q = query.toUpperCase().trim();
  // Contains date pattern: 2+ digits followed by 3-letter month followed by 2-4 digits
  if (/\d{2}[A-Z]{3}\d{2,4}/.test(q)) return true;
  // Ends with FUT, CE, PE (explicit derivative suffix)
  if (/(?:FUT|CE|PE)$/.test(q)) return true;
  return false;
}

/** Helper: sleep for ms. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class AngelOneDataSource {
  private apiKey: string;
  private clientCode: string;
  private password: string;
  private totpSecret: string;
  private session: AngelSession | null = null;
  /** Single in-flight promise so many concurrent callers don't all trigger login at once. */
  private sessionPromise: Promise<boolean> | null = null;
  /** Exponential backoff on repeated login failures (avoids hammering Cloudflare). */
  private loginFailureCount = 0;
  private loginBackoffUntil = 0;
  private static readonly LOGIN_BACKOFF_STEPS_MS = [30_000, 60_000, 120_000, 300_000]; // 30s → 5min

  /** Global throttle for Angel One requests — keeps us under Cloudflare WAF limits.
   *  Tuned for ~8 req/sec sustained, well under Cloudflare's typical bot threshold. */
  private static readonly MAX_CONCURRENT_REQUESTS = 2;
  private static readonly MIN_REQUEST_SPACING_MS = 250;
  private activeRequests = 0;
  private lastRequestStartMs = 0;
  private requestWaiters: Array<() => void> = [];

  private async acquireRequestSlot(): Promise<void> {
    while (this.activeRequests >= AngelOneDataSource.MAX_CONCURRENT_REQUESTS) {
      await new Promise<void>((resolve) => this.requestWaiters.push(resolve));
    }
    this.activeRequests += 1;
    const since = Date.now() - this.lastRequestStartMs;
    if (since < AngelOneDataSource.MIN_REQUEST_SPACING_MS) {
      await new Promise((r) => setTimeout(r, AngelOneDataSource.MIN_REQUEST_SPACING_MS - since));
    }
    this.lastRequestStartMs = Date.now();
  }

  private releaseRequestSlot(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    const next = this.requestWaiters.shift();
    if (next) next();
  }

  /**
   * All Angel One API fetches go through here so a concurrent burst of poll
   * timers can't stampede Cloudflare. The scrip-master bulk download uses
   * raw fetch since it hits a different CDN host.
   */
  private async throttledFetch(url: string, init?: RequestInit): Promise<Response> {
    await this.acquireRequestSlot();
    try {
      return await fetch(url, init);
    } finally {
      this.releaseRequestSlot();
    }
  }

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

  private noteLoginFailure(): void {
    this.loginFailureCount += 1;
    const idx = Math.min(this.loginFailureCount - 1, AngelOneDataSource.LOGIN_BACKOFF_STEPS_MS.length - 1);
    const delay = AngelOneDataSource.LOGIN_BACKOFF_STEPS_MS[idx];
    this.loginBackoffUntil = Date.now() + delay;
    console.warn(`⏳ Angel One: backing off login retries for ${Math.round(delay / 1000)}s (failure #${this.loginFailureCount})`);
  }

  private noteLoginSuccess(): void {
    this.loginFailureCount = 0;
    this.loginBackoffUntil = 0;
  }

  private async login(): Promise<boolean> {
    // Don't hammer the auth server during a backoff window
    if (Date.now() < this.loginBackoffUntil) {
      return false;
    }

    const totp = generateTOTP(this.totpSecret);
    const body = {
      clientcode: this.clientCode,
      password: this.password,
      totp,
    };
    try {
      const res = await this.throttledFetch(`${ANGEL_BASE}/rest/auth/angelbroking/user/v1/loginByPassword`, {
        method: 'POST',
        headers: this.getHeaders(false),
        body: JSON.stringify(body),
      });
      const raw = await res.text();
      if (typeof raw !== 'string' || raw.length === 0) {
        console.error('❌ Angel One login: empty response');
        this.noteLoginFailure();
        return false;
      }
      if (raw.startsWith('Access den') || raw.startsWith('<') || raw.includes('Access Denied')) {
        console.error('❌ Angel One login: Access denied or HTML response (auth server)');
        this.noteLoginFailure();
        return false;
      }
      let json: { status: boolean; data?: { jwtToken: string; refreshToken: string; feedToken: string } };
      try {
        json = JSON.parse(raw);
      } catch (e: any) {
        console.error('❌ Angel One login error:', e?.message || e);
        this.noteLoginFailure();
        return false;
      }
      if (!json.status || !json.data?.jwtToken) {
        console.error('❌ Angel One login failed:', (json as any).message || res.status);
        this.noteLoginFailure();
        return false;
      }
      this.session = {
        jwtToken: json.data.jwtToken,
        refreshToken: json.data.refreshToken,
        feedToken: json.data.feedToken,
        expiresAt: Date.now() + 23 * 60 * 60 * 1000, // ~1 day
      };
      this.noteLoginSuccess();
      console.log('✅ Angel One session started');
      return true;
    } catch (e: any) {
      console.error('❌ Angel One login error:', e?.message || e);
      this.noteLoginFailure();
      return false;
    }
  }

  private async ensureSession(): Promise<boolean> {
    if (this.session && this.session.expiresAt > Date.now() + 60_000) return true;
    if (this.sessionPromise) return this.sessionPromise;
    this.sessionPromise = (async () => {
      try {
        const ok = await this.doRefreshOrLogin();
        return ok;
      } finally {
        this.sessionPromise = null;
      }
    })();
    return this.sessionPromise;
  }

  private async doRefreshOrLogin(): Promise<boolean> {
    if (this.session?.refreshToken) {
      const ok = await this.refreshToken();
      if (ok) return true;
    }
    return this.login();
  }

  private async refreshToken(): Promise<boolean> {
    if (!this.session?.refreshToken) return this.login();
    try {
      const res = await this.throttledFetch(`${ANGEL_BASE}/rest/auth/angelbroking/jwt/v1/generateTokens`, {
        method: 'POST',
        headers: {
          ...this.getHeaders(true),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ refreshToken: this.session.refreshToken }),
      });
      const raw = await res.text();
      if (typeof raw !== 'string' || raw.length === 0) return this.login();
      if (raw.startsWith('Access den') || raw.startsWith('<') || raw.includes('Access Denied')) {
        console.warn('⚠️ Angel One refresh: Access denied, falling back to full login');
        return this.login();
      }
      let json: { status: boolean; data?: { jwtToken: string; refreshToken: string; feedToken: string } };
      try {
        json = JSON.parse(raw);
      } catch {
        return this.login();
      }
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

  /**
   * Call searchScrip (single host: apiconnect.angelone.in per official SDK).
   *
   * FIX: Distinguishes real auth errors (HTTP 401/403) from HTML error pages
   * that Angel returns for bad NFO queries. Only throws 'Auth' for genuine
   * authentication failures; returns { status: false } for other HTML responses.
   */
  private async searchScripApi(exchange: string, searchscrip: string): Promise<{ status: boolean; data?: Array<{ symboltoken: string; tradingsymbol: string }>; message?: string }> {
    const path = '/rest/secure/angelbroking/order/v1/searchScrip';
    const res = await this.throttledFetch(`${ANGEL_BASE}${path}`, {
      method: 'POST',
      headers: this.getHeaders(true),
      body: JSON.stringify({ exchange, searchscrip }),
    });
    // Genuine HTTP-level auth failures — throw so callers can re-auth
    if (res.status === 401 || res.status === 403) throw new Error('Auth');
    const raw = await res.text();
    if (typeof raw !== 'string' || raw.length === 0) {
      return { status: false, message: 'Empty response' };
    }
    // FIX: HTML / "Access Denied" with HTTP 200 — distinguish auth vs bad-query.
    // If we have a valid session (not expired), this is likely a bad query or
    // server-side error, not an auth issue. Don't throw Auth; just return no data.
    // This prevents the 3-round re-login spiral for NFO human-name queries.
    if (
      raw.startsWith('Access den') ||
      raw.includes('Access Denied') ||
      raw.startsWith('<') ||
      raw.startsWith('<!DOCTYPE')
    ) {
      if (this.session && this.session.expiresAt > Date.now() + 60_000) {
        // Session is fresh — this is NOT an auth failure, it's the API rejecting the query
        console.log(`[angelOne.searchScrip] ${exchange}: HTML/error response for "${searchscrip}" — not an auth issue (session still valid), returning empty`);
        return { status: false, message: `HTML error response for ${exchange} query` };
      }
      // Session may genuinely be expired — treat as auth
      console.log('[angelOne.searchScrip] HTML/Access Denied with stale session - re-authenticating');
      throw new Error('Auth');
    }
    type SearchScripResponse = { status?: boolean; data?: Array<{ symboltoken?: string; tradingsymbol?: string }>; message?: string };
    let json: SearchScripResponse;
    try {
      json = JSON.parse(raw) as SearchScripResponse;
    } catch {
      console.log('[angelOne.searchScrip] non-JSON (first 150 chars):', raw.slice(0, 150));
      return { status: false, message: 'Invalid JSON response' };
    }
    if (!json || typeof json !== 'object') return { status: false, message: 'Invalid response' };
    if (json.status && Array.isArray(json.data) && json.data.length > 0) {
      return json as { status: boolean; data: Array<{ symboltoken: string; tradingsymbol: string }>; message?: string };
    }
    return json as { status: boolean; data?: Array<{ symboltoken: string; tradingsymbol: string }>; message?: string };
  }

  /**
   * Ensure scrip master is loaded (shared by resolve and search fallback).
   * FIX: Timeout increased from 30s to 60s — the JSON is ~50MB / 200k rows
   * and regularly exceeds 30s on cold fetches, causing "operation was aborted"
   * and 0 search results.
   */
  private async ensureScripMaster(): Promise<ScripRow[]> {
    if (scripMasterCache && Date.now() - scripMasterFetchedAt <= SCRIP_MASTER_TTL_MS) {
      return scripMasterCache;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000); // FIX: 60s (was 30s)
    try {
      const res = await fetch(SCRIP_MASTER_URL, { signal: controller.signal });
      const raw = await res.text();
      const parsed = JSON.parse(raw) as ScripRow[] | Record<string, ScripRow>;
      scripMasterCache = Array.isArray(parsed) ? parsed : Object.values(parsed || {});
      scripMasterFetchedAt = Date.now();
      console.log('[angelOne.scripMaster] loaded', scripMasterCache.length, 'rows');
      return scripMasterCache;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Pre-load scrip master into cache. Call from warmup so the first user
   * search doesn't pay the 20-60s cold-fetch cost.
   */
  async preloadScripMaster(): Promise<void> {
    try {
      await this.ensureScripMaster();
    } catch (e: any) {
      console.warn('[angelOne.preloadScripMaster] failed:', e?.message);
    }
  }

  /** Normalize search query to NFO underlying prefix (e.g. "Nifty 50" -> "NIFTY", "BANK NIFTY" -> "BANKNIFTY"). */
  private normalizeNfoUnderlying(q: string): string {
    const u = q.replace(/\s+/g, '').toUpperCase();
    if (u === 'NIFTY50' || u === 'NIFTY') return 'NIFTY';
    if (u === 'BANKNIFTY' || u === 'NIFTYBANK') return 'BANKNIFTY';
    const withSpace = q.toUpperCase().trim();
    if (withSpace === 'NIFTY 50' || withSpace.startsWith('NIFTY 50')) return 'NIFTY';
    if (withSpace.includes('BANK') && withSpace.includes('NIFTY')) return 'BANKNIFTY';
    if (withSpace.startsWith('NIFTY')) return 'NIFTY';
    return u;
  }

  /** Search scrip master by query (when searchScrip API returns 401/403). Returns NSE, NFO (nearest expiry first), BSE. Optional exchangeFilter limits to one segment. */
  private async searchSymbolsFromScripMaster(query: string, exchangeFilter?: 'ALL' | 'NSE' | 'NFO' | 'BSE'): Promise<SearchResult[]> {
    const q = query.toUpperCase().trim();
    if (!q || q.length < 1) return [];
    const nfoPrefix = this.normalizeNfoUnderlying(q);
    try {
      const rows = await this.ensureScripMaster();
      const nseResults: SearchResult[] = [];
      const nfoList: (SearchResult & { _expiryTs: number })[] = [];
      const bseResults: SearchResult[] = [];
      const seen = new Set<string>();
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayTs = todayStart.getTime();
      const match = (s: string, n: string) => (s && s.toUpperCase().includes(q)) || (n && n.toUpperCase().includes(q));
      const matchNfo = (s: string, n: string) => match(s, n) || ((nfoPrefix === 'NIFTY' || nfoPrefix === 'BANKNIFTY') && s.startsWith(nfoPrefix));
      for (const r of rows) {
        const s = r.symbol || '';
        const n = r.name || '';
        const seg = r.exch_seg || '';
        const key = `${seg}:${s}`;
        if (seen.has(key)) continue;
        if (seg === 'NSE' && s.endsWith('-EQ') && match(s, n)) {
          seen.add(key);
          nseResults.push({
            symbol: s.replace(/-EQ$/, ''),
            name: `${s.replace(/-EQ$/, '')} (NSE Equity)`,
            exchange: 'NSE',
            currency: 'INR',
            country: 'India',
            type: 'Equity',
          });
        } else if (seg === 'NSE' && !s.endsWith('-EQ') && match(s, n)) {
          seen.add(key);
          nseResults.push({
            symbol: s,
            name: `${s} (NSE)`,
            exchange: 'NSE',
            currency: 'INR',
            country: 'India',
            type: 'Index',
          });
        } else if (seg === 'NFO' && matchNfo(s, n)) {
          seen.add(key);
          const isFut = s.includes('FUT');
          const type = isFut ? 'Future' : (s.endsWith('CE') || s.endsWith('PE') ? 'Option' : 'Derivative');
          nfoList.push({
            symbol: s,
            name: `${s} (NFO ${type})`,
            exchange: 'NFO',
            currency: 'INR',
            country: 'India',
            type,
            _expiryTs: parseExpiry(r.expiry),
          });
        } else if (seg === 'BSE' && match(s, n)) {
          seen.add(key);
          bseResults.push({
            symbol: s,
            name: `${s.replace(/-EQ$/, '')} (BSE)`,
            exchange: 'BSE',
            currency: 'INR',
            country: 'India',
            type: 'Equity',
          });
        }
      }
      // NFO: sort by expiry ascending (nearest/latest month first), prefer current/future expiries
      nfoList.sort((a, b) => a._expiryTs - b._expiryTs);
      const nfoFiltered = nfoList.filter((x) => x._expiryTs >= todayTs);
      const nfoFinal = (nfoFiltered.length > 0 ? nfoFiltered : nfoList).map(({ _expiryTs, ...rest }) => rest);
      const combined = [...nseResults, ...nfoFinal, ...bseResults];
      if (exchangeFilter && exchangeFilter !== 'ALL') {
        const filtered = combined.filter((r) => r.exchange === exchangeFilter);
        return filtered.slice(0, 30);
      }
      return combined.slice(0, 30);
    } catch (e: any) {
      console.warn('[angelOne.searchSymbolsFromScripMaster]', e?.message);
      return [];
    }
  }

  /** Resolve symbol from public scrip master when searchScrip API fails. Supports NSE, NFO, BSE. */
  private async resolveSymbolFromScripMaster(symbol: string, exchange: 'NSE' | 'NFO' | 'BSE' = 'NSE'): Promise<{ symboltoken: string; tradingsymbol: string } | null> {
    const clean = symbol.toUpperCase().replace(/\.(NS|BO)$/i, '').trim();
    try {
      const cache = await this.ensureScripMaster();
      const seg = exchange;
      const row = cache.find((r) => {
        if ((r.exch_seg || '') !== seg) return false;
        const s = (r.symbol || '').toUpperCase();
        const n = (r.name || '').toUpperCase();
        if (seg === 'NSE') {
          return s === `${clean}-EQ` || s === clean || n.startsWith(clean) || (s.endsWith('-EQ') && s.replace(/-EQ$/, '') === clean);
        }
        if (seg === 'NFO') {
          return s === clean || (n === clean && ((r.instrumenttype || '').startsWith('FUT') || (r.instrumenttype || '').startsWith('OPT')));
        }
        if (seg === 'BSE') {
          return s === clean || n === clean || n.startsWith(clean) || (s.endsWith('-EQ') && s.replace(/-EQ$/, '') === clean);
        }
        return false;
      });
      if (!row?.token || !row?.symbol) return null;
      console.log('[angelOne.resolveSymbol]', clean, 'resolved via scrip master', seg + ':', row.symbol);
      return { symboltoken: String(row.token), tradingsymbol: row.symbol };
    } catch (e: any) {
      console.warn('[angelOne.scripMaster]', e?.message);
      return null;
    }
  }

  /** Resolve symbol (e.g. RELIANCE or RELIANCE.NS) to NSE symboltoken for equity */
  async resolveSymbol(symbol: string): Promise<{ symboltoken: string; tradingsymbol: string } | null> {
    await this.ensureSession();
    const clean = symbol.toUpperCase().replace(/\.(NS|BO)$/i, '').trim();
    try {
      const json = await this.searchScripApi('NSE', clean);
      if (!json.status || !Array.isArray(json.data)) {
        console.warn('[angelOne.resolveSymbol]', clean, 'searchScrip no data:', json.status, json.message, 'rows:', json.data?.length);
        // Bug #3: Session may be revoked; force re-login on next call
        if (json.message?.includes('failed on both hosts') || json.message?.toUpperCase().includes('INTERNAL')) {
          this.session = null;
          await this.ensureSession();
        }
        const fallback = await this.resolveSymbolFromScripMaster(clean);
        if (fallback) return fallback;
        return null;
      }
      // Prefer NSE equity: tradingsymbol ending with -EQ (e.g. RELIANCE-EQ)
      let eq = json.data.find((r) => r.tradingsymbol?.endsWith('-EQ'));
      if (!eq) {
        // Fallback: exact symbol or symbol-EQ (some APIs return "RELIANCE" only)
        eq = json.data.find((r) => {
          const t = (r.tradingsymbol || '').trim();
          return t === clean || t === `${clean}-EQ` || (t.startsWith(clean) && !t.includes(' '));
        }) ?? json.data[0];
      }
      if (!eq?.symboltoken || !eq?.tradingsymbol) return null;
      return { symboltoken: eq.symboltoken, tradingsymbol: eq.tradingsymbol };
    } catch (e: any) {
      if (e?.message === 'Auth') {
        await this.refreshToken();
        return this.resolveSymbol(symbol);
      }
      console.error('Angel searchScrip error:', e?.message);
      // When API is unreachable (fetch failed, network error), still try scrip master
      const fallback = await this.resolveSymbolFromScripMaster(clean);
      if (fallback) return fallback;
      return null;
    }
  }

  /** Resolve symbol to BSE symboltoken for equity (e.g. RELIANCE or RELIANCE.BO). Falls back to scrip master when searchScrip fails. */
  async resolveSymbolBSE(symbol: string): Promise<{ symboltoken: string; tradingsymbol: string } | null> {
    await this.ensureSession();
    const clean = symbol.toUpperCase().replace(/\.(NS|BO)$/i, '').trim();
    try {
      const json = await this.searchScripApi('BSE', clean);
      if (json.status && Array.isArray(json.data) && json.data.length > 0) {
        let eq = json.data.find((r) => r.tradingsymbol?.endsWith('-EQ'));
        if (!eq) eq = json.data.find((r) => (r.tradingsymbol || '').trim() === clean || (r.tradingsymbol || '').trim() === `${clean}-EQ`) ?? json.data[0];
        if (eq?.symboltoken && eq?.tradingsymbol) return { symboltoken: eq.symboltoken, tradingsymbol: eq.tradingsymbol };
      }
      const fallback = await this.resolveSymbolFromScripMaster(clean, 'BSE');
      if (fallback) return fallback;
      return null;
    } catch (e: any) {
      if (e?.message === 'Auth') {
        await this.refreshToken();
        return this.resolveSymbolBSE(symbol);
      }
      console.error('Angel searchScrip BSE error:', e?.message);
      const fallback = await this.resolveSymbolFromScripMaster(clean, 'BSE');
      if (fallback) return fallback;
      return null;
    }
  }

  /** Resolve symbol to both NSE and BSE tokens for margin calculator (FULL mode with all tokens). */
  async resolveSymbolNSEAndBSE(symbol: string): Promise<{
    nse: { symboltoken: string; tradingsymbol: string } | null;
    bse: { symboltoken: string; tradingsymbol: string } | null;
  }> {
    const [nse, bse] = await Promise.all([this.resolveSymbol(symbol), this.resolveSymbolBSE(symbol)]);
    return { nse, bse };
  }

  /** Resolve symbol for a given exchange (NSE, NFO, BSE). Used for fetch candles/LTP with correct exchange. Falls back to scrip master when searchScrip API fails. */
  async resolveSymbolForExchange(symbol: string, exchange: 'NSE' | 'NFO' | 'BSE'): Promise<{ symboltoken: string; tradingsymbol: string } | null> {
    if (exchange === 'NSE') return this.resolveSymbol(symbol);
    if (exchange === 'BSE') return this.resolveSymbolBSE(symbol);
    if (exchange === 'NFO') {
      await this.ensureSession();
      const clean = symbol.toUpperCase().replace(/\.(NS|BO)$/i, '').trim();
      try {
        const json = await this.searchScripApi('NFO', clean);
        if (json.status && Array.isArray(json.data) && json.data.length > 0) {
          const exact = json.data.find((r) => (r.tradingsymbol || '').trim().toUpperCase() === clean) ?? json.data[0];
          if (exact?.symboltoken && exact?.tradingsymbol) return { symboltoken: exact.symboltoken, tradingsymbol: exact.tradingsymbol };
        }
        const fallback = await this.resolveSymbolFromScripMaster(clean, 'NFO');
        if (fallback) return fallback;
        return null;
      } catch (e: any) {
        if (e?.message === 'Auth') {
          await this.refreshToken();
          return this.resolveSymbolForExchange(symbol, 'NFO');
        }
        const fallback = await this.resolveSymbolFromScripMaster(clean, 'NFO');
        if (fallback) return fallback;
        return null;
      }
    }
    return null;
  }

  async fetchHistoricalCandles(symbol: string, timeframe: string, candleCount = 500, exchange: 'NSE' | 'NFO' | 'BSE' = 'NSE', retried = false): Promise<CandleData[]> {
    if (!(await this.ensureSession())) return [];
    const resolved = await this.resolveSymbolForExchange(symbol, exchange);
    if (!resolved) {
      console.warn(`⚠️  Angel: symbol "${symbol}" not found on ${exchange}`);
      return [];
    }
    console.log(`🔎 Angel getCandleData: ${symbol} → token=${resolved.symboltoken} tradingsymbol=${resolved.tradingsymbol} exchange=${exchange}`);
    const interval = INTERVAL_MAP[timeframe] || 'FIVE_MINUTE';
    const toDate = new Date();
    const maxDays = INTERVAL_MAX_DAYS[interval] ?? 90;
    const fromDate = new Date(toDate.getTime() - maxDays * 24 * 60 * 60 * 1000);
    // Angel One expects IST timestamps, NOT UTC. toISOString() returns UTC which is 5.5h behind IST.
    // Add 5.5h (19800000ms) offset before formatting to convert UTC → IST.
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const fromStr = new Date(fromDate.getTime() + IST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
    const toStr = new Date(toDate.getTime() + IST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');

    // Retry loop with exponential backoff for "Too many requests" rate limiting
    const MAX_RATE_LIMIT_RETRIES = 3;
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      try {
        const res = await this.throttledFetch(`${ANGEL_BASE}/rest/secure/angelbroking/historical/v1/getCandleData`, {
          method: 'POST',
          headers: this.getHeaders(true),
          body: JSON.stringify({
            exchange,
            symboltoken: resolved.symboltoken,
            interval,
            fromdate: fromStr,
            todate: toStr,
          }),
        });
        if (res.status === 401 || res.status === 403) {
          if (!retried) {
            await this.refreshToken();
            return this.fetchHistoricalCandles(symbol, timeframe, candleCount, exchange, true);
          }
          this.session = null;
          return [];
        }
        if (res.status === 429) {
          if (attempt < MAX_RATE_LIMIT_RETRIES) {
            const delay = (attempt + 1) * 2000; // 2s, 4s, 6s
            console.warn(`⚠️  Angel getCandleData rate limited (HTTP 429) for ${symbol} — retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})`);
            await sleep(delay);
            continue;
          }
          console.warn(`❌ Angel getCandleData rate limited for ${symbol} — exhausted ${MAX_RATE_LIMIT_RETRIES} retries`);
          return [];
        }
        const raw = await res.text();
        if (raw.startsWith('Access den') || raw.startsWith('<') || raw.includes('Access Denied')) {
          if (!retried) {
            await this.refreshToken();
            return this.fetchHistoricalCandles(symbol, timeframe, candleCount, exchange, true);
          }
          console.warn(`⚠️  Angel getCandleData still Access Denied after retry (${exchange}) — invalidating session`);
          this.session = null;
          return [];
        }
        const json = JSON.parse(raw) as { status: boolean; data?: Array<string | number>[]; message?: string };
        if (!json.status || !Array.isArray(json.data)) {
          // Angel sometimes returns HTTP 200 with auth-expiry payloads like:
          // { "status": false, "message": "Invalid Token" }.
          if (json.message && /invalid token|session expired|jwt/i.test(json.message)) {
            if (!retried) {
              console.warn(`⚠️  Angel getCandleData auth expired for ${symbol} (${exchange}) — refreshing token and retrying once`);
              await this.refreshToken();
              return this.fetchHistoricalCandles(symbol, timeframe, candleCount, exchange, true);
            }
            this.session = null;
            return [];
          }
          // Check for "Too many requests" in the JSON message body (Angel returns HTTP 200 + status=false)
          if (json.message && /too many requests/i.test(json.message) && attempt < MAX_RATE_LIMIT_RETRIES) {
            const delay = (attempt + 1) * 2000;
            console.warn(`⚠️  Angel getCandleData: "${json.message}" for ${symbol} — retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})`);
            await sleep(delay);
            continue;
          }
          console.warn(`❌ Angel One returned no data for ${symbol} (${exchange}) — status=${json.status} message=${json.message ?? 'none'} dataLength=${json.data?.length ?? 'null'}`);
          return [];
        }
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
    return [];
  }

  /** Fetch live Last Traded Price from Angel One (same as chart). */
  async fetchLTP(symbol: string, exchange: 'NSE' | 'NFO' | 'BSE' = 'NSE', retried = false): Promise<{ ltp: number; open: number; high: number; low: number; close: number } | null> {
    if (!(await this.ensureSession())) return null;
    const resolved = await this.resolveSymbolForExchange(symbol, exchange);
    if (!resolved) return null;

    const MAX_RATE_LIMIT_RETRIES = 3;
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      try {
        const res = await this.throttledFetch(`${ANGEL_BASE}/rest/secure/angelbroking/order/v1/getLtpData`, {
          method: 'POST',
          headers: this.getHeaders(true),
          body: JSON.stringify({
            exchange,
            tradingsymbol: resolved.tradingsymbol,
            symboltoken: resolved.symboltoken,
          }),
        });
        if (res.status === 401 || res.status === 403) {
          if (!retried) {
            await this.refreshToken();
            return this.fetchLTP(symbol, exchange, true);
          }
          this.session = null;
          return null;
        }
        if (res.status === 429) {
          if (attempt < MAX_RATE_LIMIT_RETRIES) {
            const delay = (attempt + 1) * 1500;
            console.warn(`⚠️  Angel getLtpData rate limited (HTTP 429) for ${symbol} — retrying in ${delay}ms`);
            await sleep(delay);
            continue;
          }
          return null;
        }
        const raw = await res.text();
        if (raw.startsWith('Access den') || raw.startsWith('<') || raw.includes('Access Denied')) {
          if (!retried) {
            await this.refreshToken();
            return this.fetchLTP(symbol, exchange, true);
          }
          console.warn(`⚠️  Angel getLtpData still Access Denied after retry (${exchange}) — invalidating session`);
          this.session = null;
          return null;
        }
        const json = JSON.parse(raw) as {
          status: boolean;
          data?: { ltp: string; open?: string; high?: string; low?: string; close?: string };
          message?: string;
        };
        if (!json.status || !json.data?.ltp) {
          // Angel sometimes returns HTTP 200 with auth-expiry payloads like:
          // { "status": false, "message": "Invalid Token" }.
          if (json.message && /invalid token|session expired|jwt/i.test(json.message)) {
            if (!retried) {
              console.warn(`⚠️  Angel getLtpData auth expired for ${symbol} (${exchange}) — refreshing token and retrying once`);
              await this.refreshToken();
              return this.fetchLTP(symbol, exchange, true);
            }
            this.session = null;
            return null;
          }
          // "Too many requests" returned as HTTP 200 + status=false
          if (json.message && /too many requests/i.test(json.message) && attempt < MAX_RATE_LIMIT_RETRIES) {
            const delay = (attempt + 1) * 1500;
            console.warn(`⚠️  Angel getLtpData: "${json.message}" for ${symbol} — retrying in ${delay}ms`);
            await sleep(delay);
            continue;
          }
          return null;
        }
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
    return null;
  }

  async fetchTimeframeData(symbol: string, timeframe: string, exchange: 'NSE' | 'NFO' | 'BSE' = 'NSE'): Promise<PriceData | null> {
    const candles = await this.fetchHistoricalCandles(symbol, timeframe, 500, exchange);
    if (candles.length === 0) return null;
    const latestCandle = candles[candles.length - 1]!;
    const previousCandle = candles.length > 1 ? candles[candles.length - 2]! : latestCandle;

    // Use live LTP so displayed price matches Angel One chart; fallback to last candle close
    const ltpData = await this.fetchLTP(symbol, exchange);
    const price = ltpData ? ltpData.ltp : latestCandle.close;
    const change = price - previousCandle.close;
    const changePercent = previousCandle.close !== 0 ? (change / previousCandle.close) * 100 : 0;

    const market: MarketInfo = {
      name: exchange,
      exchange,
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

  /**
   * Margin Calculator API (SmartAPI docs: https://smartapi.angelbroking.com/docs/MarginCalculator).
   * Uses mode "FULL" with exchangeTokens for NSE, BSE and NFO to include all tokens in the response.
   * NFO = Futures & Options (tokens are per contract, not the same as equity tokens).
   */
  async fetchMarginCalculator(exchangeTokens: {
    NSE?: string[];
    BSE?: string[];
    NFO?: string[];
  }, retried = false): Promise<{ status: boolean; data?: unknown; message?: string }> {
    await this.ensureSession();
    const nse = exchangeTokens.NSE?.filter(Boolean) ?? [];
    const bse = exchangeTokens.BSE?.filter(Boolean) ?? [];
    const nfo = exchangeTokens.NFO?.filter(Boolean) ?? [];
    if (nse.length === 0 && bse.length === 0 && nfo.length === 0) {
      return { status: false, message: 'At least one token for NSE, BSE or NFO is required' };
    }
    const body: { mode: string; exchangeTokens: Record<string, string[]> } = {
      mode: 'FULL',
      exchangeTokens: {},
    };
    if (nse.length) body.exchangeTokens['NSE'] = nse;
    if (bse.length) body.exchangeTokens['BSE'] = bse;
    if (nfo.length) body.exchangeTokens['NFO'] = nfo;
    try {
      const res = await this.throttledFetch(`${ANGEL_BASE}/rest/secure/angelbroking/margin/v1/batch`, {
        method: 'POST',
        headers: this.getHeaders(true),
        body: JSON.stringify(body),
      });
      if (res.status === 401 || res.status === 403) {
        if (!retried) {
          await this.refreshToken();
          return this.fetchMarginCalculator(exchangeTokens, true);
        }
        this.session = null;
        return { status: false, message: 'Auth failed after retry' };
      }
      const raw = await res.text();
      if (raw.startsWith('Access den') || raw.startsWith('<') || raw.includes('Access Denied')) {
        if (!retried) {
          await this.refreshToken();
          return this.fetchMarginCalculator(exchangeTokens, true);
        }
        this.session = null;
        return { status: false, message: 'Access Denied after retry' };
      }
      const json = JSON.parse(raw) as { status: boolean; data?: unknown; message?: string };
      return json;
    } catch (e: any) {
      console.error('Angel margin calculator error:', e?.message);
      return { status: false, message: e?.message ?? 'Margin calculator request failed' };
    }
  }

  /** Resolve symbol to NSE + BSE tokens and call Margin Calculator with mode FULL (all tokens). */
  async fetchMarginForSymbol(symbol: string): Promise<{ status: boolean; data?: unknown; message?: string }> {
    const { nse, bse } = await this.resolveSymbolNSEAndBSE(symbol);
    const exchangeTokens: { NSE?: string[]; BSE?: string[] } = {};
    if (nse?.symboltoken) exchangeTokens.NSE = [nse.symboltoken];
    if (bse?.symboltoken) exchangeTokens.BSE = [bse.symboltoken];
    if (!exchangeTokens.NSE?.length && !exchangeTokens.BSE?.length) {
      return { status: false, message: `Symbol "${symbol}" not found on NSE or BSE` };
    }
    return this.fetchMarginCalculator(exchangeTokens);
  }

  async searchSymbols(query: string, exchangeFilter?: 'ALL' | 'NSE' | 'NFO' | 'BSE'): Promise<SearchResult[]> {
    console.log('[angelOne.searchSymbols] query:', JSON.stringify(query), 'exchangeFilter:', exchangeFilter ?? 'ALL');
    if (!query || query.length < 1) {
      console.log('[angelOne.searchSymbols] Early return: empty query');
      return [];
    }
    await this.ensureSession();
    const searchscrip = query.toUpperCase().trim();
    const results: SearchResult[] = [];
    const seen = new Set<string>();
    const exchangesToSearch: ('NSE' | 'NFO' | 'BSE')[] =
      exchangeFilter && exchangeFilter !== 'ALL'
        ? [exchangeFilter]
        : ['NSE', 'NFO', 'BSE'];

    // FIX: For NFO, searchScrip only works with trading-symbol-like input
    // (e.g. "NIFTY17MAR26", "BANKNIFTY28DEC2347700CE"). Human queries like
    // "Nifty 50", "Bank Nifty", "Ni" cause the server to return HTML errors.
    // Skip the API call for NFO when the query is clearly a human name search
    // and rely on the scrip master (which runs in parallel anyway).
    const useSearchScripForNfo = looksLikeNfoSymbol(searchscrip);
    if (!useSearchScripForNfo && exchangesToSearch.includes('NFO')) {
      console.log(`[angelOne.searchSymbols] NFO: query "${searchscrip}" is a human name, skipping searchScrip → scrip master only`);
    }

    const searchOne = async (exchange: string): Promise<{ status: boolean; data?: Array<{ symboltoken?: string; tradingsymbol?: string }> }> => {
      // FIX: Skip searchScrip for NFO human-name queries — avoids the 3-round
      // auth retry spiral and 30s+ wasted time per search
      if (exchange === 'NFO' && !useSearchScripForNfo) {
        return { status: false };
      }
      try {
        return await this.searchScripApi(exchange, searchscrip);
      } catch (authErr: any) {
        if (authErr?.message !== 'Auth') return { status: false };
        await this.refreshToken();
        try {
          return await this.searchScripApi(exchange, searchscrip);
        } catch (retryErr: any) {
          if (retryErr?.message === 'Auth') {
            console.warn('[angelOne.searchSymbols]', exchange, 'Auth again after refresh — trying full login (per SmartAPI docs)');
            // FIX: Don't null out this.session here — it creates a race condition
            // with NSE/BSE searches running in parallel. Use a fresh login
            // but don't invalidate the session that other callers may be using.
            const loggedIn = await this.login();
            if (loggedIn) {
              try {
                return await this.searchScripApi(exchange, searchscrip);
              } catch {
                return { status: false };
              }
            }
            console.warn('[angelOne.searchSymbols]', exchange, 'still failing after full login, will use scrip master for this exchange');
          }
          return { status: false };
        }
      }
    };

    // Run API and scrip master in parallel so we never skip an exchange and NFO is faster (use fallback when API fails/slow)
    try {
      const [resMap, fallbackAll] = await Promise.all([
        Promise.all(exchangesToSearch.map((ex) => searchOne(ex).then((r) => ({ ex, r })))),
        this.searchSymbolsFromScripMaster(searchscrip, exchangeFilter),
      ]);
      const nseRes = exchangesToSearch.includes('NSE') ? resMap.find((x) => x.ex === 'NSE')?.r : { status: false };
      const nfoRes = exchangesToSearch.includes('NFO') ? resMap.find((x) => x.ex === 'NFO')?.r : { status: false };
      const bseRes = exchangesToSearch.includes('BSE') ? resMap.find((x) => x.ex === 'BSE')?.r : { status: false };
      const fallbackByExchange = {
        NSE: fallbackAll.filter((r) => r.exchange === 'NSE'),
        NFO: fallbackAll.filter((r) => r.exchange === 'NFO'),
        BSE: fallbackAll.filter((r) => r.exchange === 'BSE'),
      };

      // Build a canonical-name lookup from the scrip master fallback so we can
      // override the API's casing for NSE non-EQ symbols (the API sometimes
      // returns "NIFTY 50" but the scrip master has the authoritative
      // "Nifty 50" — and Angel One's getCandleData only accepts the latter).
      const nseCanonicalByUpper = new Map<string, string>();
      for (const r of fallbackByExchange.NSE) {
        nseCanonicalByUpper.set(r.symbol.toUpperCase(), r.symbol);
      }

      // NSE: equity (-EQ) first, then indices/other; if API failed, use scrip master so we never skip
      if (nseRes?.status && Array.isArray(nseRes.data)) {
        for (const r of nseRes.data) {
          if (!r.tradingsymbol) continue;
          if (r.tradingsymbol.endsWith('-EQ')) {
            const symbol = r.tradingsymbol.replace(/-EQ$/, '');
            const key = `NSE:${symbol}`;
            if (seen.has(key)) continue;
            seen.add(key);
            results.push({
              symbol,
              name: `${symbol} (NSE Equity)`,
              exchange: 'NSE',
              currency: 'INR',
              country: 'India',
              type: 'Equity',
            });
          }
        }
        for (const r of nseRes.data) {
          if (!r.tradingsymbol || r.tradingsymbol.endsWith('-EQ')) continue;
          // Canonicalize casing using the scrip master (e.g. "NIFTY 50" → "Nifty 50").
          // Without this, Angel One's getCandleData returns "symbol not found".
          const apiSym = r.tradingsymbol;
          const canonical = nseCanonicalByUpper.get(apiSym.toUpperCase()) ?? apiSym;
          const key = `NSE:${canonical}-${r.symboltoken ?? ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push({
            symbol: canonical,
            name: `${canonical} (NSE)`,
            exchange: 'NSE',
            currency: 'INR',
            country: 'India',
            type: 'Index',
          });
        }
      } else if (fallbackByExchange.NSE.length > 0) {
        for (const r of fallbackByExchange.NSE) {
          const key = `NSE:${r.symbol}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push(r);
        }
      }

      // NFO: futures and options; if API failed, use scrip master so we never skip
      if (nfoRes?.status && Array.isArray(nfoRes.data)) {
        for (const r of nfoRes.data) {
          if (!r.tradingsymbol) continue;
          const key = `NFO:${r.tradingsymbol}-${r.symboltoken ?? ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const t = r.tradingsymbol;
          const isFut = t.includes('FUT');
          const isCE = t.endsWith('CE');
          const isPE = t.endsWith('PE');
          let type = 'Derivative';
          if (isFut) type = 'Future';
          else if (isCE || isPE) type = 'Option';
          results.push({
            symbol: t,
            name: `${t} (NFO ${type})`,
            exchange: 'NFO',
            currency: 'INR',
            country: 'India',
            type,
          });
        }
      } else if (fallbackByExchange.NFO.length > 0) {
        for (const r of fallbackByExchange.NFO) {
          const key = `NFO:${r.symbol}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push(r);
        }
      }

      // BSE: equity; if API failed, use scrip master so we never skip
      if (bseRes?.status && Array.isArray(bseRes.data)) {
        for (const r of bseRes.data) {
          if (!r.tradingsymbol) continue;
          const key = `BSE:${r.tradingsymbol}-${r.symboltoken ?? ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const symbol = r.tradingsymbol.replace(/-EQ$/, '') || r.tradingsymbol;
          results.push({
            symbol: r.tradingsymbol,
            name: `${symbol} (BSE)`,
            exchange: 'BSE',
            currency: 'INR',
            country: 'India',
            type: 'Equity',
          });
        }
      } else if (fallbackByExchange.BSE.length > 0) {
        for (const r of fallbackByExchange.BSE) {
          const key = `BSE:${r.symbol}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push(r);
        }
      }

      let out = results.slice(0, 30);
      console.log('[angelOne.searchSymbols] Returning', out.length, 'results (NSE/NFO/BSE):', out.map((r) => `${r.exchange}:${r.symbol}`).slice(0, 8));
      return out;
    } catch (e: any) {
      console.error('[angelOne.searchSymbols] Error:', e?.message, e);
      return [];
    }
  }
}

// Persist on globalThis so the singleton (and its session) survives
// Next.js dev-mode module reloads. Without this, API routes can get a
// fresh instance with no session while the monitoring service still
// holds the old one — causing /api/fetch-price to fail with "No data".
const g = globalThis as unknown as { __angelOneSource?: AngelOneDataSource };
export function getAngelOneSource(): AngelOneDataSource {
  if (!g.__angelOneSource) g.__angelOneSource = new AngelOneDataSource();
  return g.__angelOneSource;
}
