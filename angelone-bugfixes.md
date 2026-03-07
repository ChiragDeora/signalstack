# SignalStack – Angel One SmartAPI: Bug Fixes + Multi-Exchange Support (NSE, NFO, BSE)

> Drop this file in your project root. Point Cursor at it for context on all changes needed.

---

## Table of Contents
1. [Bug Fixes (Critical)](#1-bug-fixes-critical)
2. [Multi-Exchange Support: NSE + NFO + BSE](#2-multi-exchange-support-nse--nfo--bse)
3. [Official SmartAPI Reference](#3-official-smartapi-reference)
4. [Scrip Master Reference](#4-scrip-master-reference)
5. [Code Changes Required](#5-code-changes-required)
6. [Search & UI Changes](#6-search--ui-changes)
7. [Testing](#7-testing)

---

## 1. Bug Fixes (Critical)

### Bug #1: "Access Denied" HTML response not triggering re-auth

Angel One returns HTTP 200 with HTML body `"Access Denied"` instead of 401/403. The code tries `JSON.parse()` on HTML, catches a parse error, logs it, and moves on — **never re-authenticating**.

**Log evidence:**
```
[angelOne.searchScrip] https://apiconnect.angelone.in failed: Unexpected token 'A', "Access den"... is not valid JSON
```

**Fix in `searchScripApi()`** — add BEFORE `JSON.parse(raw)`:
```typescript
if (typeof raw === 'string' && (
  raw.startsWith('Access den') ||
  raw.includes('Access Denied') ||
  raw.startsWith('<') ||
  raw.startsWith('<!DOCTYPE')
)) {
  console.log('[angelOne.searchScrip]', base, 'HTML/Access Denied - re-authenticating');
  throw new Error('Auth');
}
```

### Bug #2: Wrong base URL for searchScrip

The official Angel One Python SDK uses ONLY one host for ALL endpoints:
```python
_rootUrl = "https://apiconnect.angelone.in"  # prod endpoint
```

Your code tries `apiconnect.angelbroking.com` first (returns INTERNAL SERVER ERROR), then `apiconnect.angelone.in`. **Remove the dual-host loop. Use only `apiconnect.angelone.in`.**

```typescript
// REMOVE:
const ANGEL_ORDER_BASE = 'https://apiconnect.angelbroking.com';

// USE ONLY:
const ANGEL_BASE = 'https://apiconnect.angelone.in';
```

### Bug #3: Session validated only by local timestamp

`ensureSession()` checks `expiresAt` (set to 23h) but Angel One can revoke tokens anytime. Add session invalidation on repeated failures:

```typescript
// In resolveSymbol(), after searchScripApi returns failure:
if (json.message?.includes('failed on both hosts') || json.message?.includes('INTERNAL')) {
  this.session = null; // Force re-login on next call
  await this.ensureSession();
}
```

### Bug #4: Apply HTML detection to ALL API methods

The same HTML "Access Denied" issue can happen on `getCandleData`, `getLtpData`, and `getMarketData`. In every method that calls `fetch()` and parses JSON, add:

```typescript
const raw = await res.text();
if (raw.startsWith('Access den') || raw.startsWith('<')) {
  await this.refreshToken();
  return this.<methodName>(...args); // retry once
}
const json = JSON.parse(raw);
```

### Bug #5: Scrip master fetch can silently hang

The scrip master file is ~30MB. Add a timeout:
```typescript
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30000);
try {
  const res = await fetch(SCRIP_MASTER_URL, { signal: controller.signal });
  // ...
} finally {
  clearTimeout(timeout);
}
```

---

## 2. Multi-Exchange Support: NSE + NFO + BSE

Currently the app only resolves symbols on NSE equity (`-EQ` suffix). To support NIFTY/BANKNIFTY futures, stock options, and BSE stocks, the following changes are needed.

### Exchange Segments Supported by Angel One

| Exchange | `exchange` param | What it covers | Symbol examples |
|----------|-----------------|----------------|-----------------|
| **NSE** | `"NSE"` | Equities + Indices | `RELIANCE-EQ`, `NIFTY 50`, `NIFTY BANK` |
| **NFO** | `"NFO"` | F&O (Futures & Options on NSE) | `NIFTY28MAR25FUT`, `BANKNIFTY27MAR2524000CE` |
| **BSE** | `"BSE"` | BSE Equities + Indices | `RELIANCE`, `SENSEX` |
| **BFO** | `"BFO"` | BSE F&O | Similar to NFO but on BSE |
| **MCX** | `"MCX"` | Commodities | `CRUDEOIL`, `GOLDM` |
| **CDS** | `"CDS"` | Currency Derivatives | `USDINR` |

### NFO Symbol Format

NFO symbols follow a specific naming convention in the scrip master:

**Futures:**
```
{NAME}{EXPIRY_DATE}FUT
Example: NIFTY27MAR25FUT, BANKNIFTY27MAR25FUT, RELIANCE27MAR25FUT
```

**Options:**
```
{NAME}{EXPIRY_DATE}{STRIKE}{CE/PE}
Example: NIFTY27MAR2523000CE, BANKNIFTY27MAR2548300PE
```

### Scrip Master Fields for NFO

```json
{
  "token": "55317",
  "symbol": "BANKNIFTY25JAN24FUT",
  "name": "BANKNIFTY",
  "expiry": "25JAN2024",
  "strike": "-1.000000",
  "lotsize": "15",
  "instrumenttype": "FUTIDX",
  "exch_seg": "NFO",
  "tick_size": "5.000000"
}
```

```json
{
  "token": "58784",
  "symbol": "NIFTY28OCT2524400CE",
  "name": "NIFTY",
  "expiry": "28OCT2025",
  "strike": "2440000.000000",
  "lotsize": "75",
  "instrumenttype": "OPTIDX",
  "exch_seg": "NFO",
  "tick_size": "5.000000"
}
```

**IMPORTANT: Strike prices in scrip master are in PAISE (x100). Divide by 100 to get actual strike price.** Example: `"2440000.000000"` = strike 24,400.

### NFO Instrument Types

| `instrumenttype` | Meaning |
|-------------------|---------|
| `FUTIDX` | Index Futures (NIFTY, BANKNIFTY) |
| `FUTSTK` | Stock Futures (RELIANCE, TCS, etc.) |
| `OPTIDX` | Index Options |
| `OPTSTK` | Stock Options |

### NSE Instrument Types

| `instrumenttype` | `symbol` suffix | Meaning |
|-------------------|-----------------|---------|
| `""` (empty) | `-EQ` | Equity |
| `""` (empty) | `-BL` | Bonus Listed |
| `INDEX` | varies | Index (NIFTY 50, etc.) |

### Historical Data Limits (per request)

| Interval | Max Days | Max Records |
|----------|----------|-------------|
| ONE_MINUTE | 30 | 8,000 |
| FIVE_MINUTE | 90 | — |
| FIFTEEN_MINUTE | 90 | — |
| THIRTY_MINUTE | 180 | — |
| ONE_HOUR | 365 | — |
| ONE_DAY | 2000 | — |

---

## 3. Official SmartAPI Reference

### Base URL (ONLY this one — from official SDK)
```
https://apiconnect.angelone.in
```

### All API Routes (from official Python SDK `smartConnect.py`)
```
Login:              POST /rest/auth/angelbroking/user/v1/loginByPassword
Logout:             POST /rest/secure/angelbroking/user/v1/logout
Token Refresh:      POST /rest/auth/angelbroking/jwt/v1/generateTokens
Profile:            GET  /rest/secure/angelbroking/user/v1/getProfile
Place Order:        POST /rest/secure/angelbroking/order/v1/placeOrder
Modify Order:       POST /rest/secure/angelbroking/order/v1/modifyOrder
Cancel Order:       POST /rest/secure/angelbroking/order/v1/cancelOrder
Order Book:         GET  /rest/secure/angelbroking/order/v1/getOrderBook
Trade Book:         GET  /rest/secure/angelbroking/order/v1/getTradeBook
LTP:                POST /rest/secure/angelbroking/order/v1/getLtpData
Search Scrip:       POST /rest/secure/angelbroking/order/v1/searchScrip
Historical Candles: POST /rest/secure/angelbroking/historical/v1/getCandleData
OI Data:            POST /rest/secure/angelbroking/historical/v1/getOIData
Market Data:        POST /rest/secure/angelbroking/market/v1/quote
Holdings:           GET  /rest/secure/angelbroking/portfolio/v1/getHolding
All Holdings:       GET  /rest/secure/angelbroking/portfolio/v1/getAllHolding
Positions:          GET  /rest/secure/angelbroking/order/v1/getPosition
Convert Position:   POST /rest/secure/angelbroking/order/v1/convertPosition
Margin:             POST rest/secure/angelbroking/margin/v1/batch
GTT Create:         POST /gtt-service/rest/secure/angelbroking/gtt/v1/createRule
GTT Modify:         POST /gtt-service/rest/secure/angelbroking/gtt/v1/modifyRule
GTT Cancel:         POST /gtt-service/rest/secure/angelbroking/gtt/v1/cancelRule
GTT Details:        POST /rest/secure/angelbroking/gtt/v1/ruleDetails
GTT List:           POST /rest/secure/angelbroking/gtt/v1/ruleList
Option Greek:       POST /rest/secure/angelbroking/marketData/v1/optionGreek
Gainers/Losers:     POST /rest/secure/angelbroking/marketData/v1/gainersLosers
Put/Call Ratio:     GET  /rest/secure/angelbroking/marketData/v1/putCallRatio
OI Buildup:         POST /rest/secure/angelbroking/marketData/v1/OIBuildup
NSE Intraday:       GET  /rest/secure/angelbroking/marketData/v1/nseIntraday
BSE Intraday:       GET  /rest/secure/angelbroking/marketData/v1/bseIntraday
Estimate Charges:   POST rest/secure/angelbroking/brokerage/v1/estimateCharges
```

### Required Headers
```json
{
  "Content-type": "application/json",
  "Accept": "application/json",
  "X-UserType": "USER",
  "X-SourceID": "WEB",
  "X-ClientLocalIP": "<local_ip>",
  "X-ClientPublicIP": "<public_ip>",
  "X-MACAddress": "<mac_address>",
  "X-PrivateKey": "<api_key>",
  "Authorization": "Bearer <jwt_token>"
}
```

### Login
```json
// POST /rest/auth/angelbroking/user/v1/loginByPassword
{ "clientcode": "<client_code>", "password": "<password>", "totp": "<6_digit_totp>" }

// Response
{ "status": true, "data": { "jwtToken": "...", "refreshToken": "...", "feedToken": "..." } }
```

### searchScrip — NSE Equity
```json
// POST /rest/secure/angelbroking/order/v1/searchScrip
{ "exchange": "NSE", "searchscrip": "RELIANCE" }

// Response
{ "status": true, "data": [
  { "exchange": "NSE", "tradingsymbol": "RELIANCE-EQ", "symboltoken": "2885" }
] }
```

### searchScrip — NFO Futures
```json
{ "exchange": "NFO", "searchscrip": "BANKNIFTY27FEB2548300PE" }

// Response
{ "status": true, "data": [
  { "exchange": "NFO", "tradingsymbol": "BANKNIFTY27FEB2548300PE", "symboltoken": "64006" }
] }
```

### searchScrip — NFO (partial search for all NIFTY contracts)
```json
{ "exchange": "NFO", "searchscrip": "NIFTY" }
// Returns ALL matching NIFTY futures + options contracts
```

### searchScrip — BSE
```json
{ "exchange": "BSE", "searchscrip": "Titan" }
// Returns BSE-listed Titan shares
```

### getCandleData — NSE Equity
```json
{
  "exchange": "NSE",
  "symboltoken": "2885",
  "interval": "FIVE_MINUTE",
  "fromdate": "2025-03-01 09:15",
  "todate": "2025-03-07 15:30"
}
```

### getCandleData — NFO Future
```json
{
  "exchange": "NFO",
  "symboltoken": "55317",
  "interval": "FIFTEEN_MINUTE",
  "fromdate": "2025-03-01 09:15",
  "todate": "2025-03-07 15:30"
}
```

### getCandleData — BSE
```json
{
  "exchange": "BSE",
  "symboltoken": "500325",
  "interval": "ONE_DAY",
  "fromdate": "2024-01-01 09:00",
  "todate": "2025-03-07 15:30"
}
```

### getCandleData — NSE Index (NIFTY 50)
```json
{
  "exchange": "NSE",
  "symboltoken": "99926000",
  "interval": "ONE_HOUR",
  "fromdate": "2025-03-01 09:15",
  "todate": "2025-03-07 15:30"
}
```

### getCandleData — BSE Index (SENSEX)
```json
{
  "exchange": "BSE",
  "symboltoken": "99919000",
  "interval": "ONE_DAY",
  "fromdate": "2024-01-01 09:00",
  "todate": "2025-03-07 15:30"
}
```

### getCandleData Response Format
```json
{
  "status": true,
  "message": "SUCCESS",
  "errorcode": "",
  "data": [
    ["2025-03-01T09:15:00+05:30", 1377.00, 1380.50, 1375.20, 1378.90, 234567]
  ]
}
// Each row: [timestamp, open, high, low, close, volume]
```

### getLtpData — works for ALL exchanges
```json
// POST /rest/secure/angelbroking/order/v1/getLtpData
{
  "exchange": "NSE",        // or "NFO" or "BSE" or "MCX" etc.
  "tradingsymbol": "SBIN-EQ",
  "symboltoken": "3045"
}
```

### getMarketData (full quote with depth) — multi-exchange in one call
```json
// POST /rest/secure/angelbroking/market/v1/quote
{
  "mode": "FULL",
  "exchangeTokens": {
    "NSE": ["2885", "3045"],
    "NFO": ["55317"],
    "BSE": ["500325"]
  }
}
```

### Valid Interval Values
```
ONE_MINUTE, FIVE_MINUTE, FIFTEEN_MINUTE, THIRTY_MINUTE, ONE_HOUR, ONE_DAY
```

### Hardcoded Index Tokens (from scrip master)
```
NIFTY 50 (NSE):     99926000
NIFTY BANK (NSE):   99926009
NIFTY IT (NSE):     99926013
NIFTY FIN SVC (NSE):99926037
SENSEX (BSE):       99919000
```

---

## 4. Scrip Master Reference

URL: `https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json`
Alternative: `https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json`

Size: ~30MB JSON array. Each row:

```json
{
  "token": "2885",
  "symbol": "RELIANCE-EQ",
  "name": "RELIANCE",
  "expiry": "",
  "strike": "-1.000000",
  "lotsize": "1",
  "instrumenttype": "",
  "exch_seg": "NSE",
  "tick_size": "5.000000"
}
```

### How to search by exchange segment:

| Segment | Filter | Symbol Pattern |
|---------|--------|---------------|
| NSE Equity | `exch_seg === 'NSE'` and `symbol.endsWith('-EQ')` | `RELIANCE-EQ` |
| NSE Index | `exch_seg === 'NSE'` and `instrumenttype === 'INDEX'` or no `-EQ` | `NIFTY 50` |
| BSE Equity | `exch_seg === 'BSE'` | `RELIANCE` (no suffix) |
| NFO Futures (Index) | `exch_seg === 'NFO'` and `instrumenttype === 'FUTIDX'` | `NIFTY27MAR25FUT` |
| NFO Futures (Stock) | `exch_seg === 'NFO'` and `instrumenttype === 'FUTSTK'` | `RELIANCE27MAR25FUT` |
| NFO Options (Index) | `exch_seg === 'NFO'` and `instrumenttype === 'OPTIDX'` | `NIFTY27MAR2523000CE` |
| NFO Options (Stock) | `exch_seg === 'NFO'` and `instrumenttype === 'OPTSTK'` | `RELIANCE27MAR252000CE` |
| MCX Commodity | `exch_seg === 'MCX'` and `instrumenttype === 'FUTCOM'` | `CRUDEOIL`, `GOLDM` |
| CDS Currency | `exch_seg === 'CDS'` and `instrumenttype === 'FUTCUR'` | `USDINR` |

### All exchange segments in scrip master
```
NSE, BSE, NFO, BFO, CDS, MCX, NCDEX, NCO
```

### All instrument types in scrip master
```
(empty), AMXIDX, OPTSTK, OPTIDX, FUTSTK, FUTIDX,
OPTCUR, OPTIRC, FUTIRC, UNDIRC, UNDCUR, FUTCUR,
FUTIRT, UNDIRD, INDEX, UNDIRT, OPTFUT, FUTCOM,
COMDTY, FUTENR, OPTBLN, FUTBAS, UNDCOM, FUTBLN
```

---

## 5. Code Changes Required

### 5.1 `angelOneSource.ts` — Update `resolveSymbol` for multi-exchange

Currently the method ONLY searches NSE. Add an `exchange` parameter:

```typescript
async resolveSymbol(
  symbol: string,
  exchange: 'NSE' | 'NFO' | 'BSE' | 'MCX' | 'CDS' = 'NSE'
): Promise<{ symboltoken: string; tradingsymbol: string; exchange: string } | null> {
  await this.ensureSession();
  const clean = symbol.toUpperCase().replace(/\.(NS|BO)$/i, '').trim();

  try {
    const json = await this.searchScripApi(exchange, clean);
    if (!json.status || !Array.isArray(json.data) || json.data.length === 0) {
      // Fallback to scrip master
      const fallback = await this.resolveSymbolFromScripMaster(clean, exchange);
      if (fallback) return { ...fallback, exchange };
      return null;
    }

    let match;
    if (exchange === 'NSE') {
      // Prefer -EQ suffix for equities
      match = json.data.find(r => r.tradingsymbol?.endsWith('-EQ'))
           ?? json.data.find(r => r.tradingsymbol?.trim() === clean)
           ?? json.data[0];
    } else {
      // NFO, BSE, MCX, CDS — exact match preferred, then first result
      match = json.data.find(r => r.tradingsymbol?.trim() === clean)
           ?? json.data[0];
    }

    if (!match?.symboltoken || !match?.tradingsymbol) return null;
    return { symboltoken: match.symboltoken, tradingsymbol: match.tradingsymbol, exchange };
  } catch (e: any) {
    if (e?.message === 'Auth') {
      await this.refreshToken();
      return this.resolveSymbol(symbol, exchange);
    }
    return null;
  }
}
```

### 5.2 `angelOneSource.ts` — Update `resolveSymbolFromScripMaster` for multi-exchange

```typescript
private async resolveSymbolFromScripMaster(
  symbol: string,
  exchange: string = 'NSE'
): Promise<{ symboltoken: string; tradingsymbol: string } | null> {
  const clean = symbol.toUpperCase().trim();
  // ... (load scrip master cache same as before) ...

  const row = scripMasterCache.find((r) => {
    if ((r.exch_seg || '') !== exchange) return false;
    const s = (r.symbol || '').toUpperCase();
    const n = (r.name || '').toUpperCase();

    if (exchange === 'NSE') {
      return s === `${clean}-EQ` || s === clean || n === clean;
    } else if (exchange === 'NFO') {
      // Exact symbol match for NFO (futures/options have specific names)
      // Also match nearest future by name (e.g., search "NIFTY" → first FUTIDX with name "NIFTY")
      return s === clean || (n === clean && (r.instrumenttype === 'FUTIDX' || r.instrumenttype === 'FUTSTK'));
    } else {
      // BSE, MCX, CDS — match by symbol or name
      return s === clean || n === clean || n.startsWith(clean);
    }
  });

  if (!row?.token || !row?.symbol) return null;
  return { symboltoken: String(row.token), tradingsymbol: row.symbol };
}
```

### 5.3 Update `fetchHistoricalCandles` — pass exchange

```typescript
async fetchHistoricalCandles(
  symbol: string,
  timeframe: string,
  candleCount = 500,
  exchange: 'NSE' | 'NFO' | 'BSE' = 'NSE'
): Promise<CandleData[]> {
  if (!(await this.ensureSession())) return [];
  const resolved = await this.resolveSymbol(symbol, exchange);
  if (!resolved) {
    console.warn(`Angel: symbol "${symbol}" not found on ${exchange}`);
    return [];
  }
  // ... same logic, but use resolved.exchange:
  body: JSON.stringify({
    exchange: resolved.exchange,  // was hardcoded 'NSE'
    symboltoken: resolved.symboltoken,
    interval,
    fromdate: fromStr,
    todate: toStr,
  })
}
```

### 5.4 Update `fetchLTP` — pass exchange

```typescript
async fetchLTP(
  symbol: string,
  exchange: 'NSE' | 'NFO' | 'BSE' = 'NSE'
): Promise<...> {
  const resolved = await this.resolveSymbol(symbol, exchange);
  // ... use resolved.exchange in body
}
```

### 5.5 Update `searchSymbols` — search across NSE + NFO + BSE

```typescript
async searchSymbols(query: string): Promise<SearchResult[]> {
  if (!query || query.length < 1) return [];
  await this.ensureSession();
  const searchscrip = query.toUpperCase().trim();
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  // Search all three exchanges in parallel
  const [nseJson, nfoJson, bseJson] = await Promise.allSettled([
    this.searchScripApi('NSE', searchscrip),
    this.searchScripApi('NFO', searchscrip),
    this.searchScripApi('BSE', searchscrip),
  ]);

  // Process NSE results
  if (nseJson.status === 'fulfilled' && nseJson.value.status && Array.isArray(nseJson.value.data)) {
    for (const r of nseJson.value.data) {
      if (!r.tradingsymbol) continue;
      const key = `NSE:${r.tradingsymbol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const isEq = r.tradingsymbol.endsWith('-EQ');
      results.push({
        symbol: r.tradingsymbol,
        name: `${isEq ? r.tradingsymbol.replace(/-EQ$/, '') : r.tradingsymbol} (NSE${isEq ? ' Equity' : ''})`,
        exchange: 'NSE',
        currency: 'INR',
        country: 'India',
        type: isEq ? 'Equity' : 'Index',
      });
    }
  }

  // Process NFO results
  if (nfoJson.status === 'fulfilled' && nfoJson.value.status && Array.isArray(nfoJson.value.data)) {
    for (const r of nfoJson.value.data) {
      if (!r.tradingsymbol) continue;
      const key = `NFO:${r.tradingsymbol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const isFut = r.tradingsymbol.includes('FUT');
      const isCE = r.tradingsymbol.endsWith('CE');
      const isPE = r.tradingsymbol.endsWith('PE');
      let type = 'Derivative';
      if (isFut) type = 'Future';
      else if (isCE || isPE) type = 'Option';
      results.push({
        symbol: r.tradingsymbol,
        name: `${r.tradingsymbol} (NFO ${type})`,
        exchange: 'NFO',
        currency: 'INR',
        country: 'India',
        type,
      });
    }
  }

  // Process BSE results
  if (bseJson.status === 'fulfilled' && bseJson.value.status && Array.isArray(bseJson.value.data)) {
    for (const r of bseJson.value.data) {
      if (!r.tradingsymbol) continue;
      const key = `BSE:${r.tradingsymbol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        symbol: r.tradingsymbol,
        name: `${r.tradingsymbol} (BSE)`,
        exchange: 'BSE',
        currency: 'INR',
        country: 'India',
        type: 'Equity',
      });
    }
  }

  return results.slice(0, 30);
}
```

### 5.6 Update `fetchTimeframeData` — pass exchange through

```typescript
async fetchTimeframeData(
  symbol: string,
  timeframe: string,
  exchange: 'NSE' | 'NFO' | 'BSE' = 'NSE'
): Promise<PriceData | null> {
  const candles = await this.fetchHistoricalCandles(symbol, timeframe, 500, exchange);
  if (candles.length === 0) return null;
  const ltpData = await this.fetchLTP(symbol, exchange);
  // ... rest same
}
```

### 5.7 Add retry utility

```typescript
async function withRetry<T>(fn: () => Promise<T>, retries = 2, delay = 2000): Promise<T> {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, delay * (i + 1)));
    }
  }
  throw new Error('Unreachable');
}
```

---

## 6. Search & UI Changes

### 6.1 Types — add exchange everywhere

```typescript
interface SearchResult {
  symbol: string;      // Full tradingsymbol (e.g., "RELIANCE-EQ", "NIFTY27MAR25FUT")
  name: string;
  exchange: string;    // "NSE" | "NFO" | "BSE"
  currency: string;
  country: string;
  type: string;        // "Equity" | "Index" | "Future" | "Option"
}

interface MonitoredSymbol {
  symbol: string;
  name?: string;
  currency: string;
  exchange: string;    // NEW
}
```

### 6.2 Pass exchange through all API calls

```typescript
// /api/monitor, /api/fetch-price, etc.
const res = await axios.post('/api/monitor', {
  symbol: s.symbol,
  timeframe: tf,
  emaPeriods,
  trackBullish,
  trackBearish,
  exchange: s.exchange,  // was hardcoded 'NSE'
  currency: s.currency,
});
```

### 6.3 Backend routes — accept exchange param

Update `route.ts` to accept `exchange` in request body, default to `'NSE'`:

```typescript
const exchange = body.exchange || 'NSE';
const data = await angelOne.fetchTimeframeData(symbol, timeframe, exchange);
```

### 6.4 UI display

Show exchange badge in search results and tabs so users can distinguish:
- `RELIANCE (NSE Equity)` vs `RELIANCE (BSE)`
- `NIFTY27MAR25FUT (NFO Future)`
- `BANKNIFTY27MAR2524000CE (NFO Option)`

---

## 7. Testing

```bash
# 1. Restart server
npm run dev

# 2. Test NSE equity — search "RELIANCE"
# Should show: RELIANCE-EQ (NSE Equity)

# 3. Test NFO — search "NIFTY"
# Should show: NIFTY 50 (NSE), NIFTY futures (NFO Future), NIFTY options (NFO Option)

# 4. Test NFO specific — search "BANKNIFTY27MAR25"
# Should show matching futures and options contracts

# 5. Test BSE — search "RELIANCE"
# Should also show RELIANCE (BSE)

# 6. Monitor an NFO future — select a NIFTY future, add EMAs, start monitoring
# Should get candle data and LTP from NFO exchange

# 7. Check terminal for clean logs:
# ✅ Angel One session started
# [angelOne.searchScrip] NSE RELIANCE → OK
# [angelOne.searchScrip] NFO NIFTY → OK
# [angelOne.searchScrip] BSE RELIANCE → OK
```

### Health checks:
```bash
curl -s -o /dev/null -w "%{http_code}" https://apiconnect.angelone.in
curl -s -o /dev/null -w "%{http_code}" https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json
```

### Environment Variables
```env
ANGEL_API_KEY=<your_api_key>
ANGEL_CLIENT_CODE=<your_client_code>
ANGEL_PASSWORD=<your_pin>
ANGEL_TOTP_SECRET=<your_totp_base32_secret>
ANGEL_SECRET_KEY=<optional>
```