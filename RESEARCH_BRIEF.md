# Research Brief: EMA Crossover Alert Timing Delay

## Context

I run a Next.js application called **SignalStack** that monitors Indian stock market instruments (NSE/BSE equities, NFO options) for EMA crossovers and sends email + push + in-app alerts when a fast EMA crosses a slow EMA (e.g., EMA(9) crosses EMA(100)). The system has been running in production, serves a small group of users, and **functionally works** — alerts arrive, they are accurate, no missed crossovers.

The **only remaining problem** is a consistent timing delay: alerts arrive approximately **2 candle periods after the visual crossover** on the chart (TradingView). I want to understand the root cause thoroughly before making any code changes, because previous attempts to "fix" the timing introduced regressions (missed crossovers, flicker spam).

---

## Technical Stack

- **Frontend/Backend**: Next.js 15 on a custom Express + Socket.IO server
- **Market data source**: Angel One SmartAPI (`getCandleData` REST endpoint)
  - Docs: https://smartapi.angelbroking.com/docs/Historical
  - Returns OHLCV candles with timestamps
- **Polling model**: `setInterval` every 30 seconds per watched symbol (no WebSocket/streaming feed used currently)
- **Email delivery**: Brevo (Sendinblue) transactional API
- **Realtime push**: Web Push (VAPID) + Socket.IO
- **EMA computation**: In-process, custom TypeScript engine
- **Timezone**: Asia/Kolkata (IST, UTC+5:30). Angel One expects and returns IST timestamps.

---

## How Alerts Work (End-to-End Flow)

1. **User adds a watch**: symbol + timeframe + EMA periods (e.g., "RELIANCE, 5m, EMA 9/100")
2. **Server starts a poll loop**: every 30 seconds, `fetchHistoricalCandles()` calls Angel One's REST API and receives up to 500 recent candles
3. **Closed candle filter**: a candle is considered "closed" when `candle.openTimestamp + intervalMs <= Date.now()`. Open/forming candles are excluded.
4. **EMA update**: for each new closed candle (newer than the last one we processed), the close price is fed into running EMA calculators
5. **Crossover check**: after each candle, compare fast EMA vs. slow EMA. If the relation flipped vs. the previous candle, fire a crossover alert
6. **Dead zone guard**: to prevent flicker when EMAs hover near each other, a crossover is only registered when the EMAs diverge by at least 0.05% of the slow EMA (`DEAD_ZONE_PCT = 0.0005`)
7. **Alert dispatched**: Socket.IO to the user's room, Web Push notification, and Brevo email (including a chart PNG attachment)
8. **Alert timestamp**: set to the candle's **open** time (`new Date(candle.timestamp).toISOString()`)

---

## The Problem

For every confirmed crossover:

| Timeframe | Visual cross on TradingView | Timestamp in alert email | Email arrival time |
|---|---|---|---|
| 1m | 09:16 | 09:17 (1 candle late) | 09:18 (another 1 min later) |
| 5m | 09:25 | 09:30 (1 candle late) | 09:35 (another 5 min later) |

**Observations:**
- The **timestamp shown in the email body** is always exactly 1 candle period later than where the crossover visually appears on TradingView
- The **email arrival time** is always exactly 1 more candle period after the reported timestamp
- So total delay from visual cross to email inbox = 2 candle periods
- This scales perfectly with timeframe, which is suspicious — it suggests the delay is tied to candle boundaries, not network/API latency

The user experience is: "I see the cross happen on my chart, and 10 minutes later (on 5m) I get the email."

---

## What I Understand So Far

### Why the timestamp is 1 candle late (hypothesis)

The **dead zone** at 0.05% holds the previous EMA relation when `|fastEMA - slowEMA| < threshold`. At the **exact crossover candle**, the EMA difference is mathematically ~0 (they just crossed), which is always smaller than any positive threshold. So the dead zone holds the previous "above" state on the actual crossover candle. Only on the **next candle**, when EMAs have diverged enough to exceed the threshold, does the detector register the new relation and fire.

Result: the alert is fired on candle N+1 (one after the true crossover), and the alert's timestamp is candle N+1's open time.

### Why the email arrival is another candle late (hypothesis)

Candle N+1 doesn't pass the "closed" check (`timestamp + intervalMs <= now`) until candle N+1's close time. The next 30-second poll after that close time fetches it, processes it, and fires the email. Total detection delay ≈ 1 candle period + up to 30s polling jitter.

So:
- t=0: visual cross at candle N
- t=+1 candle: dead zone lets crossover register at candle N+1, but N+1 is still forming
- t=+2 candles: candle N+1 closes, next poll picks it up, alert fires, email sent
- t=+2 candles + email transit: user receives email

This matches the observed 2-candle total delay.

### What I've tried (and why it didn't work)

1. **Set `DEAD_ZONE_PCT = 0`** — eliminated timestamp delay in theory, but I was scared of flicker spam so I reverted before testing
2. **Replaced dead zone with a cooldown** — "detect immediately on raw comparison, then suppress reverse crossovers for 2 candles". This broke things: users reported missing legitimate crossovers (stocks that crossed multiple times in a day only triggered one alert). The cooldown was silently swallowing real crossovers that happened to fall within the 2-candle window, because during cooldown my code was still updating `lastRelation`, causing the detector to lose track of subsequent flips.
3. **Reduced dead zone to 0.0003** — user asked if this would help; I told them no because the core issue is that ANY positive dead zone threshold catches the near-zero difference at the exact crossover candle. This is why the delay is exactly 1 candle regardless of threshold size, until threshold = 0.

Current state: reverted to the original dead zone version. It works reliably (no missed crossovers, no flicker) but has the 2-candle delay.

---

## Relevant Code Snippets

### Closed candle filter (`src/lib/emaEngine.ts`)
```typescript
const intervalMs = timeframeToMs(timeframe);
const now = Date.now();
const newClosedCandles = sorted.filter(
  (c) =>
    c.timestamp > state.lastProcessedCandleTs &&
    c.timestamp + intervalMs <= now &&  // only closed candles
    c.close > 0,
);
```

### Dead zone logic (`src/lib/ema.ts`)
```typescript
private static readonly DEAD_ZONE_PCT = 0.0005;

checkCrossover(ema1Value, ema2Value, price, symbol, candleTimestamp) {
  const threshold = ema2Value * CrossoverDetector.DEAD_ZONE_PCT;
  const diff = ema1Value - ema2Value;

  let currentRelation;
  if (Math.abs(diff) < threshold && this.lastRelation !== null) {
    // Inside dead zone — hold previous state to prevent flicker
    currentRelation = this.lastRelation;
  } else {
    currentRelation = diff >= 0 ? 'above' : 'below';
  }

  if (this.lastRelation && this.lastRelation !== currentRelation) {
    // Crossover detected → fire alert with candleTimestamp
    ...
  }
}
```

### Alert timestamp assignment
```typescript
const alert: CrossoverAlert = {
  ...
  timestamp: new Date(candle.timestamp).toISOString(),  // candle open time
  ...
};
```

### Polling interval
```typescript
const REAL_TIME_POLL_MS = 30_000;
setInterval(() => this.pollAndProcess(config), REAL_TIME_POLL_MS);
```

---

## What I Want Research To Investigate

### Primary questions

1. **Is the dead zone really the cause of the 1-candle timestamp delay?**
   - Is there a mathematically rigorous way to detect a true crossover at the exact candle without a dead zone AND without flicker spam?
   - How do TradingView, ThinkOrSwim, MetaTrader, and other serious charting platforms handle this? Do they use dead zones? Confirmation candles? Something else?
   - Is there academic literature on "robust EMA crossover detection with noise rejection"?

2. **Is Angel One's REST API introducing a data lag?**
   - When I query `getCandleData` at wall-clock time 09:17:15 for 1-minute candles, will the response include the candle that opened at 09:16 (and closed at 09:17)?
   - Does Angel One publish candles immediately at close, or with a delay?
   - Are there documented API latency characteristics?
   - Does Angel One offer a WebSocket or streaming feed for candle data (not just ticks) that would eliminate polling jitter?
   - Can I trust candle timestamps to be the candle's **open** time, and is this consistent across timeframes?

3. **Are there better architectural patterns for real-time crossover detection?**
   - Should I be computing EMAs on tick data (forming candle) and firing provisional alerts, then confirming on candle close?
   - Is there a "two-phase alert" pattern: fire immediately on tick-based detection, send confirmation/retraction on candle close?
   - How do algo trading systems handle the "is this really a crossover or just noise" problem?
   - What's the correct way to eliminate flicker WITHOUT delaying the initial detection?

4. **Is the "2 candle" delay actually a fundamental limit of closed-candle detection?**
   - If I only use confirmed closed candles, can the BEST case detection delay ever be less than 1 candle period?
   - Is there a smart way to detect a crossover in the current (forming) candle with high enough confidence to fire an alert early?

### Secondary questions

5. **Email delivery timing via Brevo**
   - Is there a known pattern where Brevo transactional email gets batched or queued in a way that could add a timeframe-proportional delay? (This seems unlikely but the correlation with timeframe is suspicious.)
   - What are Brevo's documented SLAs for transactional email delivery?

6. **Angel One candle timestamp semantics**
   - Confirm whether the returned timestamp represents the candle's open or close time
   - Confirm the exact timezone encoding (IST offset, string format, etc.)

7. **EMA calculation differences**
   - TradingView uses SMA-seeded EMA with a full history. My code uses a custom EMA with a 500-candle warmup. Could the EMA values themselves differ enough to cause the perceived "1 candle shift" on crossover events?
   - What's the industry-standard EMA seeding approach (SMA vs. "EMA starts at first price" vs. Wilder's smoothing)?

8. **Polling vs. streaming trade-offs**
   - At 30-second poll intervals on a 1-minute timeframe, is there a scenario where I could miss a candle entirely?
   - What is the lowest-jitter way to align poll timing with Indian market candle close boundaries?

---

## Constraints and Non-Goals

- **No false positives**: this system is used for real trading decisions. Missing a crossover is bad, but sending a fake crossover is worse.
- **No missed crossovers**: if RELIANCE crosses bullish → bearish → bullish in one trading session, the user must receive all three alerts.
- **No dependency on TradingView's infrastructure**: must work with Angel One data only (or another broker API, if research finds a better one).
- **Must stay within Indian market hours** (09:15–15:30 IST, Mon–Fri).
- **Cost-sensitive**: I'm running this for a small group, not a hedge fund. Solutions requiring paid institutional feeds are out of scope unless absolutely necessary.
- **Don't need tick-level precision**: 1-minute is the finest timeframe I care about.

---

## What a Good Research Output Looks Like

1. A clear diagnosis of the **root cause** of the 2-candle delay, ideally separating API-side vs. dead-zone-side vs. polling-side contributions
2. A comparative analysis of how **other platforms** (TradingView, major algo platforms, open-source libs like `pandas-ta`, `talib`, `tulipindicators`) handle crossover detection and flicker rejection
3. Recommendations for **concrete alternative approaches**, with trade-offs explained (detection delay vs. false positive rate vs. complexity)
4. Answers (or pointers to answers) to the Angel One API specifics — does it publish candles at close, does it have a WebSocket, does it have documented latency?
5. If possible, pseudocode or references to battle-tested implementations of the recommended approach

---

## References and Resources I Already Have

- Angel One SmartAPI docs: https://smartapi.angelbroking.com/docs
- Angel One `getCandleData` endpoint: `/rest/secure/angelbroking/historical/v1/getCandleData`
- My repo structure (key files):
  - `src/lib/emaEngine.ts` — candle processing, closed-candle filter
  - `src/lib/ema.ts` — EMA calculator, dead zone, crossover detector
  - `src/lib/angelOneSource.ts` — Angel One API client
  - `src/lib/crossoverService.ts` — polling orchestrator, alert dispatch
  - `src/lib/brevoEmail.ts` — email sending
