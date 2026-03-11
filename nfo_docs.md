# Angel One SmartAPI — NFO (F&O) reference

Summary of what the Angel One SmartAPI docs and forum say about **NFO** (NSE Futures & Options). The main docs site is a JS SPA that doesn’t render as static HTML, so this is pieced together from the official forum, SDK source, and knowledge center.

---

## 1. Exchange constant for NFO

The Java SDK defines the exchange constants as `EXCHANGE_BSE` for BSE Equity, `EXCHANGE_NSE` for NSE Equity, and `EXCHANGE_NFO` for NSE Futures and Options. In the historical data docs, the exchange values are listed as `"NSE"` for NSE stocks and indices, `"NFO"` for NSE Futures and Options, `"BFO"` for BSE Futures and Options, `"CDS"` for currency symbols, and `"MCX"` for commodity symbols.

## 2. Place Order for NFO

The same placeOrder, modifyOrder, and cancelOrder APIs work for both Equity and F&O — you just need to mention the correct exchange and token in the request body. The endpoint is `POST /rest/secure/angelbroking/order/v1/placeOrder`.

A typical NFO order body looks like this (from forum examples): `{'exchange': 'NFO', 'tradingsymbol': 'BANKNIFTY07JAN2131400CE', 'quantity': 1, 'transactiontype': 'BUY', 'ordertype': 'MARKET', 'variety': 'NORMAL', 'producttype': 'CARRYFORWARD', 'price': '177.35', 'symboltoken': '43099', 'duration': 'DAY'}`.

Key product types for NFO: `PRODUCT_CARRYFORWARD` is Normal for futures and options (NRML), and `PRODUCT_INTRADAY` is Margin Intraday Squareoff (MIS).

A critical gotcha: quantity must be in multiples of the lot size — if you want 2 lots of BANKNIFTY, you must enter 2×15 (i.e. 30), not just 2.

Order types supported for NFO: `ORDER_TYPE_MARKET`, `ORDER_TYPE_LIMIT`, `ORDER_TYPE_STOPLOSS_LIMIT` (SL), and `ORDER_TYPE_STOPLOSS_MARKET` (SL-M). Varieties include `VARIETY_NORMAL` (Regular), `VARIETY_AMO` (After Market), `VARIETY_STOPLOSS`, and `VARIETY_ROBO` (Bracket).

## 3. Search Scrip API

The Search Scrip endpoint is `POST https://apiconnect.angelbroking.com/rest/secure/angelbroking/order/v1/searchScrip`. The request body for NFO is `{"exchange": "NFO", "searchscrip": "BANKNIFTY28DEC2347700CE"}` and the response returns `exchange`, `tradingsymbol`, and `symboltoken`.

The `searchscrip` field expects the trading symbol format like `BANKNIFTY27FEB2548300PE`. The Angel One admin also recommends using the instrument master data file as an alternative.

## 4. Scrip Master (Instrument List)

The public instrument file is at `https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json`. NFO entries have fields like `token`, `symbol`, `name`, `expiry`, `strike`, `lotsize`, `instrumenttype`, and `exch_seg`. For example, a BANKNIFTY futures entry shows `instrumenttype: "FUTIDX"` and `exch_seg: "NFO"`. Options show `instrumenttype: "OPTIDX"` (for index options) or `OPTSTK` (for stock options).

The scrip master only provides tokens for currently live F&O contracts, not expired ones.

## 5. Historical Candle Data for NFO

Endpoint: `POST /rest/secure/angelbroking/historical/v1/getCandleData`. You pass `NFO` for the exchange param to get F&O historical data.

Request format:
```json
{"exchange": "NFO", "symboltoken": "46823", "interval": "THREE_MINUTE", "fromdate": "2024-06-07 09:15", "todate": "2024-06-07 15:30"}
```

Maximum days per interval: ONE_MINUTE at 30 days (capped at 8000 records), THREE_MINUTE at 60 days, FIVE_MINUTE at 100, TEN_MINUTE at 100, FIFTEEN_MINUTE at 200, THIRTY_MINUTE at 200, ONE_HOUR at 400, ONE_DAY at 2000.

Response returns arrays of `[DateTime, Open, High, Low, Close, Volume]`.

The historical data API can only provide data for live F&O contracts, not expired ones — this is confirmed multiple times by the admin on the forum.

## 6. Historical OI Data

There's a separate endpoint that some forum users reference: `POST https://apiconnect.angelone.in/rest/secure/angelbroking/historical/v1/getOIData` with `exchange: 'NFO'` and `symboltoken`. However, the docs note that change in OI (absolute or percentage) is not yet supported by the API.

## 7. LTP for NFO

The LTP endpoint works with NFO the same way as equities — pass `exchange`, `tradingsymbol`, and `symboltoken`. The Java SDK example calls `smartConnect.getLTP(exchange, tradingSymbol, symboltoken)`.

## 8. Market Data API (REST)

The Market Data API endpoint is at `https://apiconnect.angelbroking.com/rest/secure/angelbroking/market/v1/quote/` and supports modes like `FULL`, `OHLC`, and `LTP`. For NFO tokens, you pass them under the `NFO` exchange key.

## 9. WebSocket (Real-time Streaming) for NFO

The WebSocket exchange type mapping is: `nse_cm: 1`, `nse_fo: 2`, `bse_cm: 3`, `bse_fo: 4`, `mcx_fo: 5`, `ncx_fo: 7`, `cde_fo: 13`. So NFO maps to `nse_fo` which is `exchangeType: 2`.

WebSocket subscriptions support up to 1,000 tokens per session, with up to three simultaneous connections per client. You subscribe by passing action (1=subscribe, 2=unsubscribe) and mode (1=LTP, 2=quote, 3=snap quote).

Example subscription for NFO: `{"exchangeType": 2, "tokens": ["57920", ...]}`.

## 10. Index Spot vs NFO distinction

The Nifty 50 index spot token (`99926000`) has `instrumenttype: "AMXIDX"` and `exch_seg: "NSE"` — it is not an NFO instrument. Passing this index token with `exchange: "NFO"` to the historical or LTP APIs does not work.

## 11. GTT Orders

SmartAPI supports GTT (Good Till Triggered) orders on NSE and BSE in DELIVERY and MARGIN segments. The docs don't explicitly confirm GTT for NFO.

## 12. Rate Limits

The API restricts requests per second — for example, no more than 10 order requests per second, which works out to 600 per minute.

---

## Implementation notes (this repo)

| Doc section | Where in code | Notes |
|-------------|----------------|--------|
| **§3 Search Scrip** | `angelOneSource.ts` → `searchScripApi()`, `searchSymbols()` | We use `apiconnect.angelone.in` (same path). `searchscrip` expects trading-symbol style (e.g. `NIFTY17MAR2624000CE`); for "Nifty 50" we fall back to scrip master with underlying prefix match (NIFTY/BANKNIFTY). |
| **§4 Scrip Master** | `SCRIP_MASTER_URL`, `ensureScripMaster()`, `searchSymbolsFromScripMaster()` | Same JSON URL. We filter by `exch_seg`, match symbol/name and NFO underlying prefix. 30s fetch timeout can abort on slow networks (Railway). |
| **§5 Historical candles** | `fetchHistoricalCandles()` → `getCandleData` | Exchange `NFO`, `symboltoken` + `tradingsymbol` from `resolveSymbolForExchange()`. We cap lookback via `INTERVAL_MAX_DAYS` (e.g. ONE_MINUTE: 30 days) to avoid Angel returning no data. |
| **§7 LTP** | `fetchLTP()` → `getLtpData` | Same pattern: `exchange`, `tradingsymbol`, `symboltoken` for NFO. |
| **§10 Index vs NFO** | N/A | We never pass index spot token with `exchange: "NFO"`; we resolve to the actual F&O contract token first. |

---

## What’s in the doc but not in the code

Things the NFO docs describe that **this repo does not implement**:

| Doc section | What’s in the doc | In this repo |
|-------------|-------------------|--------------|
| **§2 Place Order** | `placeOrder`, `modifyOrder`, `cancelOrder` for NFO (exchange + token + producttype CARRYFORWARD/MIS, lot-size quantity, etc.) | Not implemented. No order placement or modification. |
| **§6 Historical OI** | `POST …/historical/v1/getOIData` with `exchange: 'NFO'` and `symboltoken` (OI change not fully supported by API) | Not implemented. No OI or OI history. |
| **§8 Market Data (REST)** | `…/market/v1/quote/` with modes FULL, OHLC, LTP; NFO tokens under `NFO` key | Not implemented. We use getCandleData + getLtpData only. |
| **§9 WebSocket** | Real-time streaming: NFO = `exchangeType: 2` (nse_fo), subscribe with tokens, 1=LTP, 2=quote, 3=snap quote, up to 1k tokens/session | Not implemented. No Angel WebSocket client; we use Socket.IO for our own alerts. |
| **§11 GTT** | GTT orders on NSE/BSE (DELIVERY/MARGIN); not confirmed for NFO | Not implemented. No GTT. |
| **§12 Rate limits** | e.g. ≤10 order requests/sec (600/min) | Not implemented. No client-side throttling or rate-limit handling. |
| **§1 Other exchanges** | Doc lists `BFO`, `CDS`, `MCX` alongside NSE/NFO | We only use NSE, NFO, BSE. No BFO/CDS/MCX. |
| **§5 Interval caps** | Doc: THREE_MINUTE 60d, TEN_MINUTE 100d, FIFTEEN 200d, THIRTY 200d, ONE_HOUR 400d | We have different caps (e.g. FIVE_MINUTE 90, no THREE_MINUTE/TEN_MINUTE). We don’t use 3m/10m. |

So: **order APIs, OI API, market quote REST, WebSocket streaming, GTT, and rate-limit handling** are all in the doc but not in this codebase. The app focuses on **search, resolve, candles, and LTP** for NFO (plus our own alerting), not trading or real-time market feed.

That's the full picture from the docs, forum, SDKs, and knowledge center. The main docs site at `smartapi.angelbroking.com/docs` is a JavaScript SPA that can't be crawled; the forum and SDKs cover the same content.