# SignalStack — Project Documentation

Complete reference for the **SignalStack** app: real-time multi-EMA crossover detection and notifications (push, email) for Indian markets (NSE, NFO, BSE) with data from Angel One SmartAPI.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [API Reference](#3-api-reference)
4. [Library Modules](#4-library-modules)
5. [Components](#5-components)
6. [App Pages & Layout](#6-app-pages--layout)
7. [Database (Supabase)](#7-database-supabase)
8. [Configuration & Environment](#8-configuration--environment)
9. [Server & Deployment](#9-server--deployment)
10. [File Tree Summary](#10-file-tree-summary)

---

## 1. Project Overview

**SignalStack** lets users:

- **Search** symbols across NSE, NFO, and BSE (via Angel One).
- **Add symbols** and configure multiple EMA periods (e.g. 9, 21, 50) and timeframes (1m, 5m, 15m, 30m, 1h, 4h, 1d).
- **Start monitoring** a symbol+timeframe; the server polls price data every 30s, computes EMAs, and detects **bullish** (fast EMA crosses above slow) and **bearish** (fast crosses below) crossovers.
- **Receive alerts** via:
  - **Socket.IO** real-time updates (price, EMA values, crossover events) in the UI.
  - **Web Push** (VAPID) so alerts can be delivered when the browser is closed.
  - **Email** (Brevo) to the signed-in user and/or `BREVO_ALERT_TO` list.

**Tech stack:** Next.js 16 (App Router), React 19, TypeScript, Express + custom Node server (Socket.IO), Clerk (auth), Supabase (PostgreSQL), Angel One SmartAPI (market data), Brevo (email), Web Push (notifications).

---

## 2. Architecture

- **Custom server** (`server.js`): Express + HTTP server + Socket.IO. Next.js handles all routes via `getRequestHandler()`. Socket.IO is attached to the same HTTP server and exposed as `global.__io` for API routes and the crossover service.
- **Crossover service** (singleton): One `CrossoverService` instance per process. It uses `EMAEngine` + `UniversalMarketDataSource` (Angel One), runs interval-based polling (30s) per watch, detects crossovers, and broadcasts via Socket.IO and sends push/email.
- **Persistence:** Watches and push subscriptions are stored in Supabase and restored on server startup so monitoring and push survive restarts.
- **Auth:** Clerk. Protected pages and most APIs require sign-in; a few routes (e.g. `fetch-price`, `search-symbols`, `status`, `warmup`) are public by middleware.

---

## 3. API Reference

All APIs live under `src/app/api/`. Base URL is the app origin (e.g. `http://localhost:3005`).

---

### 3.1 `POST /api/fetch-price`

Fetches OHLC/price and optional candle data for a symbol and timeframe.

| Body (JSON)   | Type   | Description |
|---------------|--------|-------------|
| `symbol`      | string | Required. e.g. `RELIANCE`, `NIFTY 50` |
| `timeframe`   | string | Optional. Default `5m`. One of: `1m`, `5m`, `15m`, `30m`, `1h`, `4h`, `1d` |
| `exchange`    | string | Optional. `NSE` \| `NFO` \| `BSE`. Default `NSE` |

**Response (200):**

- Success: `{ success: true, data: PriceData, timestamp }`
- No data: `{ success: false, error: string }`

Uses `UniversalMarketDataSource.fetchTimeframeData()` (Angel One). **Public** (no auth required by middleware).

---

### 3.2 `POST /api/ltp`

Fetches last traded price (and open/high/low/close) for a symbol.

| Body (JSON) | Type   | Description |
|-------------|--------|-------------|
| `symbol`    | string | Required. |
| `exchange`  | string | Optional. `NSE` \| `NFO` \| `BSE`. Default `NSE` |

**Response (200):**

- Success: `{ success: true, data: { ltp, open, high, low, close }, symbol, exchange, timestamp }`
- No data: `{ success: false, error: string }`

Uses `UniversalMarketDataSource.fetchLTP()`. **Public.**

---

### 3.3 `POST /api/search-symbols`

Search symbols across exchanges (or filtered by one).

| Body (JSON)        | Type   | Description |
|--------------------|--------|-------------|
| `query`            | string | Required. Search term. |
| `exchangeFilter`   | string | Optional. `ALL` \| `NSE` \| `NFO` \| `BSE`. Default all. |

**Response (200):**

- `{ success: true, results: SearchResult[], count }`

Uses `UniversalMarketDataSource.searchSymbols(query, exchangeFilter)`. **Public.**

---

### 3.4 `POST /api/search-symbols/[exchange]`

Search symbols for a **specific** exchange. Path param: `exchange` = `NSE` \| `NFO` \| `BSE`.

| Body (JSON) | Type   | Description |
|-------------|--------|-------------|
| `query`     | string | Required. |

**Response (200):** `{ success: true, results, exchange, count }`. **Public** (path is under `/api/search-symbols/...`; if your middleware treats that as public, no auth).

---

### 3.5 `GET /api/user/watches`

Returns the **current user’s** monitored watches (from Supabase).

**Response (200):** `{ success: true, watches: MonitoredWatch[] }`  
**401:** Sign-in required.  
Uses `getWatchesByUser(userId)` from `watchPersistence`.

---

### 3.6 `GET /api/user/config`

Returns the **current user’s** UI config from Supabase (`user_config`): symbols, timeframe per symbol, EMAs per symbol, track bullish/bearish, selected symbol.

**Response (200):** `{ success: true, config: { symbols, timeframeBySymbol, emasBySymbol, trackBullish, trackBearish, selectedSymbol } }`  
**401:** Sign-in required. **503:** Supabase not configured.

---

### 3.7 `PUT /api/user/config`

Upserts the current user’s config. Body: `UserConfigPayload` (symbols, timeframeBySymbol, emasBySymbol, trackBullish, trackBearish, selectedSymbol). Name/email/phone are filled from Clerk and stored for cross-check. **401** if not signed in. **503** if Supabase missing.

---

### 3.8 `GET /api/ema-status`

EMA values and warmup progress for a symbol+timeframe (polling fallback when Socket.IO is unavailable).

| Query          | Type   | Description |
|----------------|--------|-------------|
| `symbol`       | string | Required. |
| `timeframe`    | string | Optional. Default `5m` |

**Response (200):** `{ emas: Record<number, number|null>, warmupProgress: Record<number, number> }` or `{ emas: {}, warmupProgress: {}, message }` if not monitoring. Auth optional; when signed in, status is for that user’s watch.

---

### 3.9 `POST /api/monitor`

Starts monitoring a symbol for EMA crossovers. **Requires auth.**

| Body (JSON)      | Type    | Description |
|------------------|---------|-------------|
| `symbol`         | string  | Required. |
| `timeframe`      | string  | Required. e.g. `5m` |
| `emaPeriods`     | number[]| Required. At least 2. e.g. `[9, 21, 50]` |
| `trackBullish`   | boolean | Optional. Default true. |
| `trackBearish`   | boolean | Optional. Default true. |
| `exchange`       | string  | Optional. Default `NSE`. |
| `currency`       | string  | Optional. Default `INR`. |

**Response (200):** `{ success: true, message }` or `{ success: false, error }`. On success, watch is persisted via `saveWatch()`.

---

### 3.10 `DELETE /api/monitor`

Stops monitoring a symbol (optionally for a specific timeframe). **Requires auth.**

| Body (JSON) | Type   | Description |
|-------------|--------|-------------|
| `symbol`    | string | Required. |
| `timeframe`| string | Optional. If omitted, all timeframes for that symbol for the user are stopped. |

**Response (200):** `{ success: true, message }`. Also calls `removeWatch()` in Supabase.

---

### 3.11 `GET /api/monitor`

Returns monitoring status: list of watched symbols, push subscription count, etc. **Response (200):** `{ success: true, watchedSymbols?, pushSubscriptionCount?, uptime }`. No auth required for GET.

---

### 3.12 `GET /api/alerts`

Returns in-memory alert history (last 100). **Response (200):** `{ success: true, alerts: CrossoverAlert[], count }`.

---

### 3.13 `DELETE /api/alerts`

Clears in-memory alert history. **Response (200):** `{ success: true, message }`.

---

### 3.14 `GET /api/status`

Health/status: uptime, alert count, whether Angel One, VAPID, Brevo, and email alerts are configured. **Response (200):** `{ status, uptime, alertCount, dataSources, angelConfigured, vapidConfigured, brevoConfigured, emailAlertsConfigured }`. **Public.**

---

### 3.15 `GET /api/warmup`

Pre-warms Angel One: triggers a small search (e.g. `RELIANCE`) to force login/JWT so the first user request doesn’t pay login cost. Called once by `server.js` after the HTTP server listens. **Response (200):** `{ ok: true }` or `{ ok: false, reason }`. **Public.**

---

### 3.16 `POST /api/push-subscribe`

Registers a **push subscription** (from the browser Push API). **Auth optional** (userId used if present).

| Body (JSON)       | Description |
|-------------------|-------------|
| `endpoint`        | Required. Push subscription endpoint. |
| `keys.p256dh`     | Required. |
| `keys.auth`       | Required. |

On success: subscription is added to `CrossoverService`, persisted via `savePushSubscription()`, a test push is sent, and (if signed in and Brevo configured) a one-time test email is sent. **Response (200):** `{ success: true, message }`.

---

### 3.17 `DELETE /api/push-subscribe`

Removes a push subscription by `endpoint`. **Response (200):** `{ success: true, message }`.

---

### 3.18 `GET /api/push-public-key`

Returns the **VAPID public key** for client-side `pushManager.subscribe()`. **Response (200):** `{ publicKey }`. **503** with hint if VAPID not configured.

---

### 3.19 `POST /api/push-test`

Sends a test push to all subscribed devices. Body: `{ delaySeconds?: number }` (optional, max 300). If `delaySeconds > 0`, schedules the test for later (e.g. to test with browser closed). **Response (200):** `{ success: true, message, sent?, failed? }` or `{ success: true, scheduled: true, message, delaySeconds }`. **400** if no subscriptions.

---

### 3.20 `POST /api/send-email`

Sends an email via Brevo (relay). **Requires auth.** Body: `{ to: string | string[], subject: string, text?: string, html?: string }`. **Response (200):** `{ success: true, message }`. **503** if Brevo not configured.

---

### 3.21 `POST /api/test-email`

Sends a test email to the **signed-in user’s** email (from Clerk). **Requires auth.** **Response (200):** `{ success: true, message, email }`. **503** if Brevo not configured. **400** if no email for user.

---

## 4. Library Modules

Located in `src/lib/`. All are server-side unless noted.

---

### 4.1 `types.ts`

Shared TypeScript types:

- **CandleData** — OHLCV candle (timestamp, open, high, low, close, volume).
- **PriceData** — Unified price response (symbol, price, source, currency, change, changePercent, volume, timestamp, timeframe, candleData?, market).
- **MarketInfo** — Exchange/market metadata (name, exchange, timezone, currency, country, openTime, closeTime).
- **SearchResult** — Symbol search hit (symbol, name, exchange, currency, country, type).
- **CrossoverAlert** — Crossover event (id, symbol, timeframe, fastPeriod, slowPeriod, fastEmaValue, slowEmaValue, crossoverType, price, currency, timestamp, source).
- **WatchConfig** — Watch definition (userId?, symbol, timeframe, emaPeriods, trackBullish, trackBearish, exchange, currency).
- **EmaStatus** — EMA values and warmup progress (emas, warmupProgress, lastPrice).
- **MonitorStatus** — Status update (symbol, timeframe, status, message?).
- **PushSubscriptionData** — Push subscription (endpoint, keys, userId?).
- **PriceUpdate**, **EmaUpdate** — Socket.IO payloads.
- **TIMEFRAMES** — Array of timeframe definitions (id, label, description, cronExpr).
- **TimeframeId** — Union of timeframe ids.

---

### 4.2 `ema.ts`

- **EMACalculator** — Single-EMA: `update(price)`, `bulkLoad(closePrices)`, `getValue()`, `warmupProgress()`, `isReady()`. Uses standard EMA formula; initializes with SMA of first `period` prices.
- **CrossoverDetector** — Tracks fast vs slow EMA relation; `checkCrossover(ema1Value, ema2Value, price, symbol)` returns `CrossoverResult | null` (bullish/bearish). Respects `trackBullish` / `trackBearish`.

---

### 4.3 `emaEngine.ts`

- **EMAEngine** — Multi-symbol EMA orchestrator:
  - **addWatch(config)** — Creates EMACalculators per period and CrossoverDetectors for each pair (sorted by period).
  - **removeWatch(symbol, timeframe?, userId?)** — Removes watch(es).
  - **warmUp(symbol, timeframe, candles, userId?)** — Bulk-loads historical closes into EMAs and initializes detector relations.
  - **processTick(symbol, timeframe, price, currency, source, userId?, timestamp?)** — Updates EMAs, runs crossover checks, returns array of **CrossoverAlert**.
  - **getStatus(symbol, timeframe, userId?)** — Returns **EmaStatus** (emas, warmupProgress, lastPrice).

Internal key: `userId:symbol:timeframe` or `symbol:timeframe`.

---

### 4.4 `crossoverService.ts`

- **CrossoverService** — Top-level service (constructed with Socket.IO instance):
  - **initialize()** — One-time setup.
  - **startMonitoring(config)** — Validates, enforces per-user watch limit (100), adds watch to engine, fetches historical data for warmup, seeds one tick, starts **30s interval** polling via `pollAndProcess()`, emits status/price/EMA over Socket.IO. Persistence is done by the caller (monitor API).
  - **stopMonitoring(symbol, timeframe?, userId?)** — Stops cron/interval jobs and removes from engine.
  - **restoreAllWatches(configs)** — Calls `startMonitoring` for each (used on server startup).
  - **addPushSubscription(sub, userId?)** / **removePushSubscription(endpoint)** — In-memory push subscription map.
  - **getEmaStatus(symbol, timeframe, userId?)** — Delegates to engine.
  - **getMonitoringInfo()** — Returns watched symbols and push subscription count.
  - **sendTestPushNotification()** — Sends a test push to all subscriptions.

Private methods:

- **pollAndProcess(config)** — Fetches price via `UniversalMarketDataSource.fetchTimeframeData()`, emits price/EMA, calls `engine.processTick()`, then **handleAlerts()**.
- **handleAlerts()** — Deduplicates by (userId, symbol, timeframe, fast, slow, type) and candle timestamp; then adds to alert store, emits `alert:crossover`, sends push and email (Brevo + optional user email from Clerk).
- **emitPriceUpdate**, **emitEmaUpdate**, **emitStatus** — Socket.IO `price:update`, `ema:update`, `monitor:status`.

Uses **web-push** (VAPID) and **brevoEmail** for sending.

---

### 4.5 `crossoverServiceSingleton.ts`

- **getOrCreateCrossoverService()** — Returns a single **CrossoverService** instance. Creates it with `global.__io`, restores watches from `getAllWatches()` and push subscriptions from `getAllPushSubscriptions()`, and wires `onSubscriptionExpired` to `persistRemovePushSubscription`.

---

### 4.6 `dynamicMarketSource.ts`

- **UniversalMarketDataSource** — Facade over Angel One only:
  - **fetchLTP(symbol, exchange)** — Returns `{ ltp, open, high, low, close } | null`.
  - **fetchTimeframeData(symbol, timeframe, exchange)** — Returns **PriceData** (with candleData when available).
  - **searchSymbols(query, exchangeFilter?)** — Returns **SearchResult[]**.
  - **getAvailableSources()** — `['Angel One']` or `[]`.

---

### 4.7 `angelOneSource.ts`

- **AngelOneDataSource** — Angel One SmartAPI client:
  - Credentials from env: `ANGEL_API_KEY`, `ANGEL_CLIENT_CODE`, `ANGEL_PASSWORD`, `ANGEL_TOTP_SECRET`.
  - **isAvailable()** — True if all four are set.
  - **login()** — Password + TOTP login; stores JWT, refresh token, feed token.
  - **ensureSession()** — Refreshes or logs in when needed.
  - **fetchLTP(symbol, exchange)** — Uses LTP or equivalent API.
  - **fetchTimeframeData(symbol, timeframe, exchange)** — Maps timeframe to Angel interval, fetches historical candles, builds **PriceData**.
  - **searchSymbols(query, exchangeFilter?)** — Uses SmartAPI search and/or public scrip master (OpenAPIScripMaster.json) when search API fails; filters by exchange; for NFO, sorts by expiry.

Singleton: **getAngelOneSource()** returns the same instance.

---

### 4.8 `alertStore.ts`

In-memory alert history (up to 200 items):

- **addAlert(alert)** — Prepends, trims to 200.
- **getAlerts()** — Returns full array.
- **clearAlerts()** — Empties array.

---

### 4.9 `watchPersistence.ts`

Supabase persistence for watches (table `watches`):

- **getAllWatches()** — All rows (for server restore).
- **getWatchesByUser(userId)** — Watches for one user.
- **saveWatch(config)** — Upsert by (user_id, symbol, timeframe).
- **removeWatch(userId, symbol, timeframe?)** — Delete matching row(s).

Uses **getSupabaseAdmin()** from `supabaseServer`.

---

### 4.10 `pushSubscriptionPersistence.ts`

Supabase persistence for push subscriptions (table `push_subscriptions`):

- **getAllPushSubscriptions()** — All rows (for server restore).
- **savePushSubscription(sub, userId?)** — Upsert by endpoint.
- **removePushSubscription(endpoint)** — Delete by endpoint.

---

### 4.11 `pushKeys.ts`

VAPID keys for Web Push:

- **getVapidKeys()** — From env (`NEXT_PUBLIC_VAPID_PUBLIC_KEY` or `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`), or from `.vapid-keys.json`, or auto-generates and writes file (skipped on Vercel).
- **isVapidConfigured()** — True if keys are available.

---

### 4.12 `brevoEmail.ts`

Email via Brevo:

- **isBrevoConfigured()** — True if `BREVO_API_KEY` or SMTP user/pass set.
- **sendEmail({ to, subject, text?, html?, replyTo? })** — Prefers Brevo API, else SMTP (nodemailer).
- **getAlertRecipientEmails()** — From `BREVO_ALERT_TO` (comma-separated).
- **sendCrossoverAlertEmail(alert, userEmail?)** — Sends formatted crossover alert to env recipients and optionally the signed-in user.

---

### 4.13 `clerkUserEmail.ts`

- **getClerkUserEmail(userId)** — Fetches user from Clerk API with `CLERK_SECRET_KEY`, returns primary email. Used for alert emails and test email on push enable.

---

### 4.14 `supabaseServer.ts`

- **getSupabaseAdmin()** — Creates/returns Supabase client with `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Returns null if env missing (logs once).

---

### 4.15 `marketHours.ts`

- **isMarketOpen(exchange)** — True for NSE/BSE if 9:15–15:30 IST, Mon–Fri. Other exchanges treated as open. (Currently crossover service does not block alerts by market hours; this is available for future use.)

---

## 5. Components

---

### 5.1 `EMAAlertSystem.tsx` (client)

Main UI: symbol search (NSE/NFO/BSE), add/remove symbols, set timeframes and EMA periods, start/stop monitoring, live price/EMA via Socket.IO (with polling fallback to `/api/ema-status`), alert list, push enable/disable and test, test email. Restores user config and watches from `/api/user/config` and `/api/user/watches` when signed in. Uses **axios** for API calls and **socket.io-client** for real-time updates. Large component (~2000 lines) containing state, effects, and JSX for the full flow.

---

### 5.2 `ServiceWorkerRegistration.tsx` (client)

Registers `/sw.js` on mount when `serviceWorker` is in navigator. Used in root layout for PWA and push.

---

### 5.3 `SignInForm.tsx` (client)

Renders Clerk `<SignIn />` with redirect to `/`; redirects to home when already signed in.

---

### 5.4 `SignUpForm.tsx` (client)

Same pattern with Clerk `<SignUp />`.

---

### 5.5 `SignInRedirect.tsx`

Used on sign-in layout to redirect or show sign-in (see sign-in page).

---

## 6. App Pages & Layout

- **`src/app/page.tsx`** — Home: renders `<EMAAlertSystem />`.
- **`src/app/layout.tsx`** — Root layout: ClerkProvider, Inter font, metadata (title “SignalStack”, manifest, apple-web-app), viewport, `<ServiceWorkerRegistration />`.
- **`src/app/globals.css`** — Global styles (Tailwind and custom).
- **`src/app/sign-in/[[...sign-in]]/page.tsx`** — Catch-all sign-in page (renders sign-in form).
- **`src/app/sign-in/layout.tsx`** — Layout for sign-in.
- **`src/app/sign-up/[[...sign-up]]/page.tsx`** — Catch-all sign-up page.
- **`src/app/sign-up/layout.tsx`** — Layout for sign-up.

---

## 7. Database (Supabase)

Two migrations in `supabase/migrations/`:

- **20250307000000_signalstack_tables.sql**
  - **user_config** — One row per user: user_id (unique), symbols (JSONB), timeframe_by_symbol (JSONB), emas_by_symbol (JSONB), track_bullish, track_bearish, selected_symbol, updated_at.
  - **watches** — user_id, symbol, timeframe, ema_periods (JSONB), track_bullish, track_bearish, exchange, currency, created_at. Unique (user_id, symbol, timeframe).
  - **push_subscriptions** — user_id, endpoint (unique), keys_p256dh, keys_auth, created_at.
- **20250307180000_user_config_name_email.sql**
  - Adds **name**, **email**, **phone** to `user_config` (from Clerk).

---

## 8. Configuration & Environment

- **Next.js:** `next.config.js` — CSP headers, other headers.
- **Clerk:** Auth and route protection live in `src/proxy.ts`. For Next.js to run it as middleware, the file must be named `middleware.ts` (at project root or in `src/`). The logic there: Public routes: `/sign-in(.*)`, `/sign-up(.*)`, `/api/webhooks(.*)`, `/api/(fetch-price|search-symbols|status|warmup)(.*)`. Redirects signed-in users from sign-in/sign-up to `/`. Protects other pages; API routes still call `auth()` and return 401 when needed.
- **Env vars (summary):**
  - **Clerk:** `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`.
  - **Supabase:** `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
  - **Angel One:** `ANGEL_API_KEY`, `ANGEL_CLIENT_CODE`, `ANGEL_PASSWORD`, `ANGEL_TOTP_SECRET`.
  - **Brevo:** `BREVO_API_KEY` or `BREVO_SMTP_USER` + `BREVO_SMTP_PASS`; optional `BREVO_FROM_EMAIL`, `BREVO_FROM_NAME`, `BREVO_ALERT_TO`.
  - **Web Push:** `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (or `VAPID_PUBLIC_KEY`), `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.
  - **Server:** `PORT`, `HOST` (default 3005, 0.0.0.0).

---

## 9. Server & Deployment

- **server.js** — Express app, HTTP server, Socket.IO. Sets `global.__io`. Serves Next via `handle(req, res)`. On listen: GET `/api/warmup`, GET `/api/monitor` to restore watches. Graceful shutdown on SIGTERM/SIGINT.
- **Scripts:** `npm run dev` → `node server.js` (dev); `npm run build` → `next build`; `npm run start` → `NODE_ENV=production node server.js`.
- **railway.toml** — Build command `npm run build`, start command `npm run start` for Railway.
- **DEPLOY_WITH_NODE.md** — Notes for deploying the custom Node server (e.g. Railway, reverse proxy).

---

## 10. File Tree Summary

```
ema-alert-nextjs/
├── server.js                    # Express + Socket.IO + Next.js handler
├── next.config.js               # CSP and Next config
├── railway.toml                 # Railway deploy
├── package.json
├── src/
│   ├── proxy.ts                 # Clerk middleware (auth + public routes)
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx
│   │   ├── globals.css
│   │   ├── sign-in/[[...sign-in]]/page.tsx, layout.tsx
│   │   ├── sign-up/[[...sign-up]]/page.tsx, layout.tsx
│   │   └── api/
│   │       ├── fetch-price/route.ts
│   │       ├── ltp/route.ts
│   │       ├── search-symbols/route.ts
│   │       ├── search-symbols/[exchange]/route.ts
│   │       ├── user/watches/route.ts
│   │       ├── user/config/route.ts
│   │       ├── ema-status/route.ts
│   │       ├── monitor/route.ts
│   │       ├── alerts/route.ts
│   │       ├── status/route.ts
│   │       ├── warmup/route.ts
│   │       ├── push-subscribe/route.ts
│   │       ├── push-public-key/route.ts
│   │       ├── push-test/route.ts
│   │       ├── send-email/route.ts
│   │       └── test-email/route.ts
│   ├── components/
│   │   ├── EMAAlertSystem.tsx
│   │   ├── ServiceWorkerRegistration.tsx
│   │   ├── SignInForm.tsx
│   │   ├── SignUpForm.tsx
│   │   └── SignInRedirect.tsx
│   └── lib/
│       ├── types.ts
│       ├── ema.ts
│       ├── emaEngine.ts
│       ├── crossoverService.ts
│       ├── crossoverServiceSingleton.ts
│       ├── dynamicMarketSource.ts
│       ├── angelOneSource.ts
│       ├── alertStore.ts
│       ├── watchPersistence.ts
│       ├── pushSubscriptionPersistence.ts
│       ├── pushKeys.ts
│       ├── brevoEmail.ts
│       ├── clerkUserEmail.ts
│       ├── supabaseServer.ts
│       └── marketHours.ts
├── public/
│   ├── manifest.json             # PWA manifest
│   ├── sw.js                     # Service worker (cache + push)
│   └── ...
└── supabase/migrations/
    ├── 20250307000000_signalstack_tables.sql
    └── 20250307180000_user_config_name_email.sql
```

---

**End of documentation.** For NFO-specific symbol formats and Angel One behaviour, see `nfo_docs.md` and `angelone-bugfixes.md` in the repo.
