// ============================================
// Crossover Detection Service
// ============================================
// Top-level orchestration: ties data fetching, EMA computation,
// crossover detection, interval polling, Socket.IO broadcasting,
// and push notifications together.

import * as cron from 'node-cron';
import { EMAEngine } from './emaEngine';
import { UniversalMarketDataSource } from './dynamicMarketSource';
import { addAlert, getAlerts } from './alertStore';
import {
  WatchConfig, CrossoverAlert, RsiAlert, LevelCrossAlert, PriceUpdate, EmaUpdate,
  MonitorStatus, PushSubscriptionData, PriceData,
} from './types';
import {
  sendCrossoverAlertEmail,
  sendRsiAlertEmail,
  sendLevelCrossAlertEmail,
  sendEndOfDaySummaryEmail,
  isBrevoConfigured,
  getAlertRecipientEmails,
  type DaySummaryItem,
} from './brevoEmail';
import { sendCrossoverTelegramAlert, sendRsiTelegramAlert, sendLevelCrossTelegramAlert } from './telegram';
import { pushCrossoverToUser, pushRsiToUser, pushLevelCrossToUser } from './expoPush';
import { getClerkUserEmail } from './clerkUserEmail';
import { buildCrossoverChartAttachment } from './alertChart';
import { appendAlertLog, appendRsiAlertLog } from './alertLogger';
import { getAllWatches } from './watchPersistence';
import { fetchDaySummary, fetchPrevDayOHLC, deriveDaySummaryFromCandles, detectLevelCrosses, buildOhlcContextBlock, istDateOf, OHLC_UNAVAILABLE } from './daySummary';
import { randomUUID } from 'crypto';
import { CandleData } from './types';

// web-push is optional — only needed for push notifications (see OpenReplay Web Push guide)
let webpush: any = null;
try {
  webpush = require('web-push');
  const { getVapidKeys } = require('./pushKeys');
  const keys = getVapidKeys();
  if (keys) {
    webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
    console.log('✅ Web Push VAPID configured');
  } else {
    console.log('⚠️  Web Push VAPID keys not set — push notifications disabled');
    webpush = null;
  }
} catch {
  console.log('⚠️  web-push not installed — push notifications disabled');
}

const REAL_TIME_POLL_MS = 30_000;
const MAX_WATCHES_PER_USER = 100;

// Local copy (emaEngine keeps its own private one) — used to decide which
// candles are closed when checking prev-day level crosses.
function timeframeToMs(timeframe: string): number {
  const map: Record<string, number> = {
    '1m': 60_000, '5m': 5 * 60_000, '15m': 15 * 60_000, '30m': 30 * 60_000,
    '1h': 60 * 60_000, '4h': 4 * 60 * 60_000, '1d': 24 * 60 * 60_000,
  };
  return map[timeframe] || 5 * 60_000;
}

function watchJobKey(config: WatchConfig): string {
  const sym = config.symbol.toUpperCase();
  return config.userId ? `${config.userId}:${sym}:${config.timeframe}` : `${sym}:${config.timeframe}`;
}

function countWatchesForUser(userId: string, cronJobs: Map<string, unknown>, intervalJobs: Map<string, unknown>): number {
  let n = 0;
  const prefix = `${userId}:`;
  for (const key of cronJobs.keys()) if (key.startsWith(prefix)) n++;
  for (const key of intervalJobs.keys()) if (key.startsWith(prefix)) n++;
  return n;
}

export type OnSubscriptionExpired = (endpoint: string) => void | Promise<void>;

export class CrossoverService {
  private engine: EMAEngine;
  private dataSource: UniversalMarketDataSource;
  private io: any; // Socket.IO server instance
  private cronJobs: Map<string, cron.ScheduledTask> = new Map();
  private intervalJobs: Map<string, NodeJS.Timeout> = new Map(); // 1m real-time polling
  private pushSubscriptions: Map<string, PushSubscriptionData> = new Map();
  private onSubscriptionExpired?: OnSubscriptionExpired;
  private initialized = false;
  /** Per-EMA-pair, per-candle de-duplication: key = userId|symbol|timeframe|fast|slow|type, value = last alert timestamp */
  private lastAlertByPairAndCandle: Map<string, string> = new Map();
  /** Per-RSI-signal, per-candle de-duplication: key = userId|symbol|timeframe|signalType|direction, value = last alert timestamp */
  private lastRsiAlertByKey: Map<string, string> = new Map();
  /** Consecutive null/empty-data poll responses per watch — used only for periodic warning logs. */
  private nullPollStreak: Map<string, number> = new Map();
  // Cache of latest day summary (yesterday OHLC + today's open) per symbol+exchange.
  // Populated each poll by updateDaySummaryFromCandles (derived from the poll's
  // own candles — no network) so handleAlerts can read it synchronously.
  private daySummaryCache: Map<string, { ts: number; data: import('./daySummary').DaySummary | null }> = new Map();
  /** Prev-day OHLC warmed by the 09:10 IST pre-market cron (same key scheme as
   *  daySummaryCache). Prev-day data is final before open, so fetching it
   *  before 09:15 keeps the heavy getCandleData calls out of market hours. */
  private prevDayCache: Map<string, import('./daySummary').DayRange> = new Map();
  /** Last closed-candle timestamp we've already evaluated for prev-day level
   *  crosses, per watch key — so each candle is checked once (fire-once). */
  private lastLevelCandleTs: Map<string, number> = new Map();
  /** TTL cache for the separate RSI-timeframe fetch (e.g. 1d), keyed by
   *  symbol:exchange:rsiTf — avoids re-pulling daily candles every 30s. */
  private rsiTfCache: Map<string, { at: number; data: PriceData | null }> = new Map();

  constructor(io: any, options?: { onSubscriptionExpired?: OnSubscriptionExpired }) {
    this.io = io;
    this.engine = new EMAEngine();
    this.dataSource = new UniversalMarketDataSource();
    this.onSubscriptionExpired = options?.onSubscriptionExpired;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    console.log('✅ Crossover Service initialized');
    console.log(`📡 Available sources: ${this.dataSource.getAvailableSources().join(', ') || 'None configured'}`);
  }

  /**
   * Start monitoring a symbol for EMA crossovers (per-user when config.userId is set)
   */
  async startMonitoring(config: WatchConfig): Promise<{ success: boolean; message: string }> {
    const key = watchJobKey(config);

    // Validate — need EMA alerts and/or RSI
    const emaAlertsOn = config.trackBullish || config.trackBearish;
    const rsiOn = config.rsi?.enabled === true;
    if (!config.symbol) {
      return { success: false, message: 'Need a symbol' };
    }
    if (!emaAlertsOn && !rsiOn) {
      return { success: false, message: 'Enable EMA crossover alerts, RSI alerts, or both' };
    }
    if (emaAlertsOn && config.emaPeriods.length < 2) {
      return { success: false, message: 'Need at least 2 EMA periods when EMA alerts are enabled' };
    }

    // Per-user limit to segregate API poll load
    if (config.userId) {
      const count = countWatchesForUser(config.userId, this.cronJobs, this.intervalJobs);
      if (count >= MAX_WATCHES_PER_USER) {
        return {
          success: false,
          message: `Limit reached: max ${MAX_WATCHES_PER_USER} symbols per account. Stop one to add another.`,
        };
      }
    }

    // Stop existing monitoring for this key
    if (this.cronJobs.has(key) || this.intervalJobs.has(key)) {
      await this.stopMonitoring(config.symbol, config.timeframe, config.userId);
    }

    // Emit status
    this.emitStatus(config.symbol, config.timeframe, 'starting', 'Fetching historical data for EMA warmup...', config.userId);

    // 1. Add to engine
    this.engine.addWatch(config);

    // 2. Fetch historical data for EMA warmup
    try {
      this.emitStatus(config.symbol, config.timeframe, 'warming_up', 'Loading historical candles...', config.userId);

      const priceData = await this.dataSource.fetchTimeframeData(config.symbol, config.timeframe, (config.exchange as 'NSE' | 'NFO' | 'BSE') || 'NSE');

      if (priceData?.candleData && priceData.candleData.length > 0) {
        this.engine.warmUp(config.symbol, config.timeframe, priceData.candleData, config.userId);

        // Emit initial price and EMA data
        this.emitPriceUpdate(config.symbol, config.timeframe, priceData, config.userId);
        this.emitEmaUpdate(config.symbol, config.timeframe, config.userId);
      } else {
        console.warn(`⚠️  No historical data for warmup of ${config.symbol}`);
        this.emitStatus(config.symbol, config.timeframe, 'running', 'Running without historical warmup — EMAs will initialize from live ticks', config.userId);
        if (priceData) this.emitPriceUpdate(config.symbol, config.timeframe, priceData, config.userId);
        this.emitEmaUpdate(config.symbol, config.timeframe, config.userId);
      }

      // Separate RSI warmup when RSI uses a different timeframe
      const rsiTf = config.rsi?.timeframe;
      if (config.rsi?.enabled && rsiTf && rsiTf !== config.timeframe) {
        const rsiData = await this.dataSource.fetchTimeframeData(config.symbol, rsiTf, (config.exchange as 'NSE' | 'NFO' | 'BSE') || 'NSE');
        if (rsiData?.candleData && rsiData.candleData.length > 0) {
          this.engine.warmUpRsi(config.symbol, config.timeframe, rsiData.candleData, config.userId);
        } else {
          console.warn(`⚠️  No historical RSI data for warmup of ${config.symbol} (RSI tf=${rsiTf})`);
        }
        this.emitEmaUpdate(config.symbol, config.timeframe, config.userId);
      }
    } catch (error: any) {
      console.error(`❌ Warmup error for ${config.symbol}:`, error?.message || error);
      this.emitEmaUpdate(config.symbol, config.timeframe, config.userId);
    }

    // 3. Set up polling: all timeframes use 15s interval so alerts arrive within ~15 seconds
    console.log(`⏰ Polling ${config.symbol} (${config.timeframe}) every ${REAL_TIME_POLL_MS / 1000}s${config.userId ? ` [user]` : ''}`);
    const intervalId = setInterval(() => {
      this.pollAndProcess(config).catch((err) =>
        console.error(`Poll error for ${config.symbol}:`, err)
      );
    }, REAL_TIME_POLL_MS);
    this.intervalJobs.set(key, intervalId);

    // 4. Run first poll immediately so data refreshes right away
    this.pollAndProcess(config).catch((err) =>
      console.error(`Initial poll error for ${config.symbol}:`, err)
    );

    this.emitStatus(config.symbol, config.timeframe, 'running', 'Monitoring active', config.userId);
    // OHLC context is derived from each poll's own candle data
    // (updateDaySummaryFromCandles) — no pre-warm fetch needed here.
    return { success: true, message: `Monitoring started for ${config.symbol} (${config.timeframe})` };
  }

  /**
   * Restore all persisted watches (call on server startup so monitoring survives restarts).
   *
   * Watches are started sequentially with a 2-second delay between each to
   * avoid slamming the Angel One API with concurrent requests (which triggers
   * "Too many requests" rate limiting and causes warmup failures + alert floods).
   */
  async restoreAllWatches(configs: WatchConfig[]): Promise<void> {
    if (!configs?.length) return;
    console.log(`📂 Restoring ${configs.length} persisted watch(es) (staggered, 250ms apart)...`);
    // The 2s stagger was needed before the global request throttle existed.
    // The throttle (2 concurrent + 250ms spacing) now handles burst protection,
    // so we only need a tiny gap between starts to avoid scheduling all warmups
    // at exactly the same instant. 250ms × 20 watches = 5s startup instead of 40s.
    for (let i = 0; i < configs.length; i++) {
      const config = configs[i];
      if (i > 0) {
        await new Promise((r) => setTimeout(r, 250));
      }
      try {
        const result = await this.startMonitoring(config);
        if (result.success) console.log(`   ✓ ${config.symbol} (${config.timeframe})`);
        else console.warn(`   ✗ ${config.symbol}: ${result.message}`);
      } catch (err: any) {
        console.warn(`   ✗ ${config.symbol} (${config.timeframe}):`, err?.message || err);
      }
    }
  }

  /**
   * Stop monitoring a symbol (optionally scoped by userId)
   */
  async stopMonitoring(symbol: string, timeframe?: string, userId?: string): Promise<void> {
    const upperSymbol = symbol.toUpperCase();

    const _matchKey = (k: string) => {
      if (userId) return k === `${userId}:${upperSymbol}:${timeframe}` || (timeframe && k.startsWith(`${userId}:${upperSymbol}:`)) || (!timeframe && k.startsWith(`${userId}:${upperSymbol}:`));
      return k === `${upperSymbol}:${timeframe}` || (timeframe && k.endsWith(`:${upperSymbol}:${timeframe}`)) || (!timeframe && k.includes(`:${upperSymbol}:`));
    };

    for (const [key, job] of this.cronJobs) {
      if (userId) {
        if (timeframe && key === `${userId}:${upperSymbol}:${timeframe}`) { job.stop(); this.cronJobs.delete(key); }
        else if (!timeframe && key.startsWith(`${userId}:${upperSymbol}:`)) { job.stop(); this.cronJobs.delete(key); }
      } else {
        if (timeframe && key === `${upperSymbol}:${timeframe}`) { job.stop(); this.cronJobs.delete(key); }
        else if (!timeframe && key.startsWith(`${upperSymbol}:`)) { job.stop(); this.cronJobs.delete(key); }
      }
    }
    for (const [key, intervalId] of this.intervalJobs) {
      if (userId) {
        if (timeframe && key === `${userId}:${upperSymbol}:${timeframe}`) { clearInterval(intervalId); this.intervalJobs.delete(key); }
        else if (!timeframe && key.startsWith(`${userId}:${upperSymbol}:`)) { clearInterval(intervalId); this.intervalJobs.delete(key); }
      } else {
        if (timeframe && key === `${upperSymbol}:${timeframe}`) { clearInterval(intervalId); this.intervalJobs.delete(key); }
        else if (!timeframe && key.startsWith(`${upperSymbol}:`)) { clearInterval(intervalId); this.intervalJobs.delete(key); }
      }
    }

    this.engine.removeWatch(symbol, timeframe, userId);

    // Clear any auto-disable streak counters for keys matching this stop scope
    const upper = symbol.toUpperCase();
    for (const key of [...this.nullPollStreak.keys()]) {
      if (userId) {
        if (timeframe && key === `${userId}:${upper}:${timeframe}`) this.nullPollStreak.delete(key);
        else if (!timeframe && key.startsWith(`${userId}:${upper}:`)) this.nullPollStreak.delete(key);
      } else {
        if (timeframe && key === `${upper}:${timeframe}`) this.nullPollStreak.delete(key);
        else if (!timeframe && key.startsWith(`${upper}:`)) this.nullPollStreak.delete(key);
      }
    }

    this.emitStatus(symbol, timeframe || '', 'stopped', 'Monitoring stopped', userId);
    console.log(`🛑 Stopped monitoring ${symbol}${timeframe ? ` (${timeframe})` : ''}${userId ? ' [user]' : ''}`);
  }

  /**
   * Poll price data and process through EMA engine.
   *
   * FIX: Only update EMAs with confirmed candle closes (not live LTP).
   * Previously, every poll fed the live LTP into the EMA as if it were a
   * new candle close.  For a 5m timeframe polled every 30s, this meant the
   * EMA received ~10 data points per candle instead of 1, producing values
   * that diverged from the chart and triggering false crossover alerts.
   */
  private async pollAndProcess(config: WatchConfig): Promise<void> {
    const watchKey = watchJobKey(config);
    try {
      const priceData = await this.dataSource.fetchTimeframeData(config.symbol, config.timeframe, (config.exchange as 'NSE' | 'NFO' | 'BSE') || 'NSE');
      if (!priceData) {
        // Track consecutive empty responses for logging only. We no longer
        // auto-disable / delete dead watches — the user explicitly trusts
        // their watchlist and prefers to manage it themselves. Persistent
        // failures will only log a warning every 10 misses.
        const streak = (this.nullPollStreak.get(watchKey) ?? 0) + 1;
        this.nullPollStreak.set(watchKey, streak);
        if (streak === 10 || (streak > 10 && streak % 50 === 0)) {
          console.warn(
            `⚠️  ${config.symbol} (${config.timeframe}): ${streak} consecutive empty responses from Angel One — will keep retrying`,
          );
        }
        return;
      }
      // Got data — reset the streak
      this.nullPollStreak.delete(watchKey);

      // OHLC context: derive from the candles we just fetched — ZERO extra API
      // calls, so it never competes with poll fetches in the Angel throttle
      // (that competition was delaying crossover detection at market open).
      this.updateDaySummaryFromCandles(config.symbol, config.exchange, priceData.candleData ?? []);

      // Emit price update for UI display
      this.emitPriceUpdate(config.symbol, config.timeframe, priceData, config.userId);

      // Process only newly-closed candles through the EMA engine.
      // The live LTP is passed for display only — it is NOT fed into the EMAs.
      const { crossovers, rsi } = this.engine.processNewCandles(
        config.symbol,
        config.timeframe,
        priceData.candleData || [],
        priceData.price,
        priceData.currency,
        priceData.source,
        config.userId,
      );

      // Emit EMA update (now also carries RSI value if enabled)
      this.emitEmaUpdate(config.symbol, config.timeframe, config.userId);

      // Handle alerts (crossover + RSI from same timeframe)
      this.handleAlerts(crossovers, config.userId, config.exchange, priceData.candleData);
      if (rsi.length > 0) {
        this.handleRsiAlerts(rsi, config.userId, config.exchange);
      }

      // Prev-day level crosses — independent of EMA/RSI, fired once per cross.
      // Uses candles already fetched; no extra API call.
      this.handleLevelCrosses(config, priceData.candleData || []);

      // Separate RSI timeframe: fetch and process RSI candles independently.
      // Cached with a TTL scaled to the candle interval — a 1d RSI candle
      // barely moves in a few minutes, so re-fetching it every 30s poll was
      // pure waste (and the biggest chunk of redundant getCandleData traffic).
      const rsiTf = config.rsi?.timeframe;
      if (config.rsi?.enabled && rsiTf && rsiTf !== config.timeframe) {
        try {
          const rsiData = await this.fetchRsiTimeframeCached(config.symbol, rsiTf, (config.exchange as 'NSE' | 'NFO' | 'BSE') || 'NSE');
          if (rsiData?.candleData && rsiData.candleData.length > 0) {
            const rsiAlerts = this.engine.processNewRsiCandles(
              config.symbol,
              config.timeframe,
              rsiData.candleData,
              priceData.price,
              priceData.currency,
              priceData.source,
              config.userId,
            );
            if (rsiAlerts.length > 0) {
              this.handleRsiAlerts(rsiAlerts, config.userId, config.exchange);
            }
            this.emitEmaUpdate(config.symbol, config.timeframe, config.userId);
          }
        } catch (rsiErr) {
          console.error(`❌ RSI poll error for ${config.symbol} (RSI tf=${rsiTf}):`, rsiErr);
        }
      }
    } catch (error) {
      console.error(`❌ Poll error for ${config.symbol}:`, error);
    }
  }

  /**
   * Handle detected crossover alerts. When userId is set, fetches that user's email from Clerk and sends the alert there too.
   *
   * Additional guard on top of the EMA engine:
   * - Only send **one** alert per symbol + timeframe + EMA pair + direction **per candle timestamp**.
   *   This means late data corrections or repeated polls for the same candle (including 1m candles) will not spam extra emails.
   */
  /**
   * Cache key includes the IST trading date so the prev-day OHLC we cached
   * yesterday can't leak into today's alerts. At midnight IST the key
   * naturally rotates, forcing a fresh fetch on the next poll.
   */
  private daySummaryKey(symbol: string, exchange: string): string {
    const exch = (exchange as 'NSE' | 'NFO' | 'BSE') || 'NSE';
    return `${symbol.toUpperCase()}:${exch}:${istDateOf()}`;
  }

  /**
   * Update the day-summary cache from candles the poll ALREADY fetched — no
   * network call. For 5m/15m/… the ~500-candle window spans several trading
   * days, so today's open + yesterday's session are derivable directly. For
   * short windows (1m) that don't reach yesterday, we keep whatever prev-day
   * the 09:10 pre-market cron cached and only refresh today's numbers.
   */
  private updateDaySummaryFromCandles(symbol: string, exchange: string, candles: CandleData[]): void {
    if (!candles.length) return;
    const key = this.daySummaryKey(symbol, exchange);
    const derived = deriveDaySummaryFromCandles(candles);
    if (!derived) return; // no candles for today yet — leave cache as-is

    // If the intraday window didn't reach a prior trading day, fall back to the
    // pre-market cron's prev-day so the block still shows "Prev day: …".
    if (!derived.yesterday) {
      const warmedPrev = this.prevDayCache.get(key);
      if (warmedPrev) derived.yesterday = warmedPrev;
    }
    this.daySummaryCache.set(key, { ts: Date.now(), data: derived });
  }

  /**
   * Fetch the separate RSI-timeframe candles with a TTL cache. A higher-
   * timeframe RSI candle (esp. 1d) barely changes between 30s polls, so we
   * re-fetch at most once per (interval/6), clamped to [60s, 5min]. Cuts the
   * bulk of redundant daily-candle traffic that was hammering the throttle.
   */
  private async fetchRsiTimeframeCached(symbol: string, rsiTf: string, exchange: 'NSE' | 'NFO' | 'BSE'): Promise<PriceData | null> {
    const key = `${symbol.toUpperCase()}:${exchange}:${rsiTf}`;
    const ttl = Math.min(5 * 60_000, Math.max(60_000, Math.floor(timeframeToMs(rsiTf) / 6)));
    const cached = this.rsiTfCache.get(key);
    if (cached && Date.now() - cached.at < ttl) return cached.data;
    const data = await this.dataSource.fetchTimeframeData(symbol, rsiTf, exchange);
    this.rsiTfCache.set(key, { at: Date.now(), data });
    return data;
  }

  /**
   * Synchronous read of the cached day summary keyed by today's trading day.
   * Returns null if nothing is cached yet — caller then emits the
   * `OHLC data unavailable` fallback block (never silently drops the section).
   */
  private getCachedDaySummary(symbol: string, exchange: string): import('./daySummary').DaySummary | null {
    const entry = this.daySummaryCache.get(this.daySummaryKey(symbol, exchange));
    return entry?.data ?? null;
  }

  /**
   * Fire a standalone alert the moment price crosses a prev-day reference level
   * (high / low / close). Independent of EMA/RSI. Evaluated on the two most
   * recent CLOSED candles (candle-close based, like the crossover engine) and
   * gated by lastLevelCandleTs so each candle is only checked once — the alert
   * fires exactly on the breaking candle, never repeated while price stays
   * beyond the level. Zero extra API calls (candles already fetched).
   */
  private handleLevelCrosses(config: WatchConfig, candles: CandleData[]): void {
    if (candles.length < 2) return;
    const summary = this.getCachedDaySummary(config.symbol, config.exchange);
    if (!summary?.yesterday) return;

    const intervalMs = timeframeToMs(config.timeframe);
    const now = Date.now();
    const closed = [...candles]
      .filter((c) => c.close > 0 && c.timestamp + intervalMs <= now)
      .sort((a, b) => a.timestamp - b.timestamp);
    if (closed.length < 2) return;

    const cur = closed[closed.length - 1];
    const prev = closed[closed.length - 2];

    const watchKey = watchJobKey(config);
    // Only evaluate a given candle once.
    if (this.lastLevelCandleTs.get(watchKey) === cur.timestamp) return;
    this.lastLevelCandleTs.set(watchKey, cur.timestamp);

    const crosses = detectLevelCrosses(prev.close, cur.close, summary.yesterday);
    if (crosses.length === 0) return;

    const currency = config.currency || 'INR';
    const tsIso = new Date(cur.timestamp).toISOString();

    for (const x of crosses) {
      const alert: LevelCrossAlert = {
        id: randomUUID(),
        type: 'levelCross',
        symbol: config.symbol,
        timeframe: config.timeframe,
        level: x.level,
        crossDirection: x.direction,
        levelValue: parseFloat(x.levelValue.toFixed(2)),
        price: parseFloat(cur.close.toFixed(2)),
        currency,
        timestamp: tsIso,
        source: 'level-cross',
      };
      console.log(
        `🚨 LEVEL CROSS: ${alert.symbol} crossed ${alert.crossDirection} prev day ${alert.level} (${alert.levelValue}) at ₹${alert.price}`,
      );

      // Socket broadcast
      if (config.userId && this.io) this.io.to(`user:${config.userId}`).emit('alert:levelCross', alert);
      else this.io?.emit('alert:levelCross', alert);

      if (config.userId) {
        sendLevelCrossTelegramAlert(config.userId, alert).catch((e) =>
          console.warn('Level-cross Telegram alert failed:', e?.message || e),
        );
        pushLevelCrossToUser(config.userId, alert).catch((e) =>
          console.warn('Level-cross Expo push failed:', e?.message || e),
        );
        getClerkUserEmail(config.userId)
          .then((email) => sendLevelCrossAlertEmail(alert, email, summary))
          .catch((e) => console.warn('Level-cross email alert failed:', e));
      } else {
        sendLevelCrossAlertEmail(alert, null, summary).catch((e) =>
          console.warn('Level-cross email alert failed:', e),
        );
      }
    }
  }

  private handleAlerts(alerts: CrossoverAlert[], userId?: string, exchange?: string, candleData?: CandleData[]): void {
    const userEmailPromise =
      userId && alerts.length > 0 ? getClerkUserEmail(userId) : Promise.resolve(null);

    for (const alert of alerts) {
      const pairKey = [
        userId ?? 'global',
        alert.symbol.toUpperCase(),
        alert.timeframe,
        alert.fastPeriod,
        alert.slowPeriod,
        alert.crossoverType,
      ].join('|');
      const lastTs = this.lastAlertByPairAndCandle.get(pairKey);
      // If we've already sent an alert for this exact candle timestamp for this EMA pair + direction, skip it
      if (lastTs && lastTs === alert.timestamp) {
        continue;
      }
      this.lastAlertByPairAndCandle.set(pairKey, alert.timestamp);

      addAlert(alert, userId);

      // Synchronously read cached OHLC reference levels (refreshed in the
      // background by pollSymbol). No wait, no fallback fetch: if the cache
      // is empty for this symbol, buildOhlcContextBlock returns the
      // "OHLC data unavailable" string per spec so the block is never
      // silently dropped from the alert.
      const cachedDaySummary = this.getCachedDaySummary(alert.symbol, exchange ?? 'NSE');
      alert.ohlcContext = buildOhlcContextBlock(
        alert.crossoverType,
        alert.price,
        cachedDaySummary,
        alert.currency,
      );
      if (alert.ohlcContext === OHLC_UNAVAILABLE) {
        console.warn(`[ohlc-context] unavailable at alert time for ${alert.symbol} ${exchange ?? 'NSE'}`);
      }

      // Emit to user-specific room if userId is set, otherwise broadcast
      if (userId && this.io) {
        this.io.to(`user:${userId}`).emit('alert:crossover', alert);
      } else {
        this.io?.emit('alert:crossover', alert);
      }

      this.sendPushNotification(alert, userId);

      // Telegram (best-effort, per-user chat id)
      if (userId) {
        sendCrossoverTelegramAlert(userId, alert).catch((e) =>
          console.warn('Crossover Telegram alert failed:', e?.message || e),
        );
        // Expo / React Native push (best-effort)
        pushCrossoverToUser(userId, alert).catch((e) =>
          console.warn('Crossover Expo push failed:', e?.message || e),
        );
      }

      // Find the candle that produced this alert (for the close price column)
      const matchedCandle = candleData?.find(
        (c) => new Date(c.timestamp).toISOString() === alert.timestamp,
      );

      // Chart generation is async (sharp SVG→PNG) — run in parallel with email lookup
      const chartPromise = buildCrossoverChartAttachment(alert, candleData).catch((e) => {
        console.warn('Chart generation failed:', e);
        return null;
      });
      Promise.all([userEmailPromise, chartPromise]).then(([email, chartAttachment]) => {
        const attachments = chartAttachment ? [chartAttachment] : undefined;
        return sendCrossoverAlertEmail(alert, email, attachments, cachedDaySummary);
      })
        .then(() => {
          // Log to xlsx after the email has been dispatched (best-effort)
          appendAlertLog(alert, {
            userId,
            emailSentAt: Date.now(),
            candleClosePrice: matchedCandle?.close,
            daySummary: cachedDaySummary,
          }).catch((e) => console.warn('Alert log append failed:', e));
        })
        .catch((e) => {
          console.warn('Crossover email alert failed:', e);
          // Still log the alert even if email failed
          appendAlertLog(alert, {
            userId,
            candleClosePrice: matchedCandle?.close,
            daySummary: cachedDaySummary,
          }).catch((err) => console.warn('Alert log append failed:', err));
        });
    }
  }

  /**
   * Dispatch RSI alerts: dedupe per candle, broadcast over socket, push, email, log.
   * No DB persistence yet — RSI history will not survive a refresh in this first pass.
   */
  private handleRsiAlerts(alerts: RsiAlert[], userId?: string, exchange?: string): void {
    const userEmailPromise =
      userId && alerts.length > 0 ? getClerkUserEmail(userId) : Promise.resolve(null);

    for (const alert of alerts) {
      const dedupKey = [
        userId ?? 'global',
        alert.symbol.toUpperCase(),
        alert.timeframe,
        alert.signalType,
        alert.direction,
      ].join('|');
      const lastTs = this.lastRsiAlertByKey.get(dedupKey);
      if (lastTs && lastTs === alert.timestamp) continue;
      this.lastRsiAlertByKey.set(dedupKey, alert.timestamp);

      // Synchronously read cached OHLC reference levels (refreshed in the
      // background by pollAndProcess). Empty cache → attach the
      // "OHLC data unavailable" fallback so the block is never dropped.
      const cachedDaySummary = this.getCachedDaySummary(alert.symbol, exchange ?? 'NSE');
      alert.ohlcContext = buildOhlcContextBlock(
        alert.direction,
        alert.price,
        cachedDaySummary,
        alert.currency,
      );
      if (alert.ohlcContext === OHLC_UNAVAILABLE) {
        console.warn(`[ohlc-context] unavailable at alert time for ${alert.symbol} ${exchange ?? 'NSE'}`);
      }

      // Socket broadcast
      if (userId && this.io) {
        this.io.to(`user:${userId}`).emit('alert:rsi', alert);
      } else {
        this.io?.emit('alert:rsi', alert);
      }

      // Push notification
      this.sendRsiPushNotification(alert, userId);

      // Email
      userEmailPromise
        .then((email) => sendRsiAlertEmail(alert, email, cachedDaySummary))
        .catch((e) => console.warn('RSI email alert failed:', e));

      // xlsx log — best-effort, fire-and-forget, does not block channels above
      appendRsiAlertLog(alert, {
        userId,
        daySummary: cachedDaySummary,
        ohlcContext: alert.ohlcContext,
      }).catch((e) => console.warn('RSI alert log append failed:', e));

      // Telegram (best-effort, per-user chat id)
      if (userId) {
        sendRsiTelegramAlert(userId, alert).catch((e) =>
          console.warn('RSI Telegram alert failed:', e?.message || e),
        );
        // Expo / React Native push (best-effort)
        pushRsiToUser(userId, alert).catch((e) =>
          console.warn('RSI Expo push failed:', e?.message || e),
        );
      }
    }
  }

  /**
   * Emit price update via Socket.IO (to user room if userId set)
   */
  private emitPriceUpdate(symbol: string, timeframe: string, priceData: any, userId?: string): void {
    const payload: PriceUpdate = {
      symbol,
      timeframe,
      price: priceData.price,
      change: priceData.change || 0,
      changePercent: priceData.changePercent || 0,
      currency: priceData.currency || 'INR',
      source: priceData.source || 'unknown',
      timestamp: priceData.timestamp || new Date().toISOString(),
    };
    if (userId && this.io) {
      this.io.to(`user:${userId}`).emit('price:update', payload);
    } else {
      this.io?.emit('price:update', payload);
    }
  }

  /**
   * Emit EMA status update via Socket.IO (to user room if userId set)
   */
  private emitEmaUpdate(symbol: string, timeframe: string, userId?: string): void {
    const status = this.engine.getStatus(symbol, timeframe, userId);
    if (status) {
      const payload: EmaUpdate = {
        symbol,
        timeframe,
        emas: status.emas,
        warmupProgress: status.warmupProgress,
      };
      if (status.rsi) payload.rsi = status.rsi;
      if (userId && this.io) {
        this.io.to(`user:${userId}`).emit('ema:update', payload);
      } else {
        this.io?.emit('ema:update', payload);
      }
    }
  }

  /**
   * Emit monitoring status via Socket.IO (to user room if userId set)
   */
  private emitStatus(
    symbol: string,
    timeframe: string,
    status: MonitorStatus['status'],
    message?: string,
    userId?: string,
  ): void {
    const payload: MonitorStatus = { symbol, timeframe, status, message };
    if (userId && this.io) {
      this.io.to(`user:${userId}`).emit('monitor:status', payload);
    } else {
      this.io?.emit('monitor:status', payload);
    }
  }

  // =========================
  // Push Notification Methods
  // =========================

  addPushSubscription(sub: PushSubscriptionData, userId?: string): void {
    const stored = { ...sub, userId: userId ?? sub.userId };
    this.pushSubscriptions.set(sub.endpoint, stored);
    console.log(`🔔 Push subscription added for user ${stored.userId ?? '(anonymous)'} (total: ${this.pushSubscriptions.size})`);
  }

  removePushSubscription(endpoint: string): void {
    this.pushSubscriptions.delete(endpoint);
  }

  private async sendPushNotification(alert: CrossoverAlert, userId?: string): Promise<void> {
    if (!webpush || this.pushSubscriptions.size === 0) return;

    const emoji = alert.crossoverType === 'bullish' ? '📈' : '📉';
    const base = `EMA(${alert.fastPeriod}) crossed ${alert.crossoverType === 'bullish' ? 'above' : 'below'} EMA(${alert.slowPeriod}) at ₹${alert.price}`;
    const body = alert.ohlcContext ? `${base}\n${alert.ohlcContext}` : base;
    const payload = JSON.stringify({
      title: `${emoji} ${alert.crossoverType === 'bullish' ? 'Bullish' : 'Bearish'} Crossover: ${alert.symbol}`,
      body,
      tag: `crossover-${alert.symbol}-${alert.id}`,
      url: '/',
    });

    const options = { TTL: 86400, urgency: 'high' as const };
    // Only send to subscriptions belonging to the user whose watch triggered the alert
    const targets = [...this.pushSubscriptions.entries()].filter(([, sub]) => {
      if (!userId) return true; // no userId attached to watch — send to all (legacy)
      if (!sub.userId) return true; // subscription has no user — send (legacy device)
      return sub.userId === userId;
    });
    const promises = targets.map(async ([endpoint, sub]) => {
      try {
        await webpush.sendNotification(sub, payload, options);
      } catch (err: any) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          this.pushSubscriptions.delete(endpoint);
          console.log(`🔔 Removed expired push subscription`);
          await this.onSubscriptionExpired?.(endpoint);
        }
      }
    });

    await Promise.allSettled(promises);
  }

  private async sendRsiPushNotification(alert: RsiAlert, userId?: string): Promise<void> {
    if (!webpush || this.pushSubscriptions.size === 0) return;

    const emoji = alert.direction === 'bullish' ? '📈' : '📉';
    const labelMap: Record<RsiAlert['signalType'], string> = {
      overboughtCross: 'Overbought cross',
      oversoldCross: 'Oversold cross',
      thresholdBreach: 'Threshold breach',
      centerlineCross: 'Centerline (50) cross',
      signalLineCross: 'Signal line cross',
    };
    const label = labelMap[alert.signalType];
    const base = `RSI(${alert.period}) = ${alert.rsiValue} (${alert.direction}) at ₹${alert.price}`;
    const body = alert.ohlcContext ? `${base}\n${alert.ohlcContext}` : base;

    const payload = JSON.stringify({
      title: `${emoji} RSI ${label}: ${alert.symbol}`,
      body,
      tag: `rsi-${alert.symbol}-${alert.id}`,
      url: '/',
    });

    const options = { TTL: 86400, urgency: 'high' as const };
    const targets = [...this.pushSubscriptions.entries()].filter(([, sub]) => {
      if (!userId) return true;
      if (!sub.userId) return true;
      return sub.userId === userId;
    });
    const promises = targets.map(async ([endpoint, sub]) => {
      try {
        await webpush.sendNotification(sub, payload, options);
      } catch (err: any) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          this.pushSubscriptions.delete(endpoint);
          await this.onSubscriptionExpired?.(endpoint);
        }
      }
    });

    await Promise.allSettled(promises);
  }

  /**
   * Send a test push notification to all subscriptions (for "Test notification" button).
   */
  async sendTestPushNotification(): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    if (!webpush || this.pushSubscriptions.size === 0) return { sent: 0, failed: 0 };

    const payload = JSON.stringify({
      title: '🔔 SignalStack – Test notification',
      body: "If you see this, push alerts are working. You'll get crossover alerts the same way.",
      tag: 'signalstack-test',
      url: '/',
    });
    const options = { TTL: 60, urgency: 'high' as const };

    for (const [endpoint, sub] of this.pushSubscriptions) {
      try {
        await webpush.sendNotification(sub, payload, options);
        sent++;
      } catch (err: any) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          this.pushSubscriptions.delete(endpoint);
          await this.onSubscriptionExpired?.(endpoint);
        }
        failed++;
      }
    }
    return { sent, failed };
  }

  // =========================
  // Pre-market OHLC warm-up
  // =========================

  private preMarketCronJob: cron.ScheduledTask | null = null;

  schedulePreMarketWarmup(): void {
    if (this.preMarketCronJob) return;
    // 9:10 AM IST (Mon–Fri) — 5 minutes before NSE open. Prev-day OHLC is
    // final by then, so we pull it while the Angel One API is idle. During
    // market hours the OHLC context then needs only one cheap LTP call per
    // symbol (today's open) instead of the heavy getCandleData fetch.
    this.preMarketCronJob = cron.schedule('10 9 * * 1-5', () => {
      console.log('🌅 Pre-market OHLC warm-up: triggered');
      this.warmUpPrevDayOHLC().catch((e) => console.error('Pre-market warm-up failed:', e));
    }, { timezone: 'Asia/Kolkata' });
    console.log('🌅 Pre-market OHLC warm-up scheduled: 9:10 AM IST, Mon–Fri');
  }

  /**
   * Fetch and cache prev-day OHLC for every persisted watch. Requests are
   * staggered 600ms apart so the warm-up never saturates the shared Angel One
   * throttle. Failures are logged and skipped — the lazy per-poll refresh
   * remains as fallback for any symbol the warm-up misses.
   */
  async warmUpPrevDayOHLC(): Promise<void> {
    const watches = await getAllWatches();
    const unique = new Map<string, { symbol: string; exchange: string }>();
    for (const w of watches) {
      const exch = (w.exchange as string) || 'NSE';
      unique.set(`${w.symbol.toUpperCase()}:${exch}`, { symbol: w.symbol, exchange: exch });
    }
    if (unique.size === 0) {
      console.log('🌅 Pre-market warm-up: no active watches');
      return;
    }
    console.log(`🌅 Pre-market warm-up: fetching prev-day OHLC for ${unique.size} symbol(s)`);
    let ok = 0;
    for (const { symbol, exchange } of unique.values()) {
      const key = this.daySummaryKey(symbol, exchange);
      if (this.prevDayCache.has(key)) { ok++; continue; }
      const prev = await fetchPrevDayOHLC(symbol, (exchange as 'NSE' | 'NFO' | 'BSE') || 'NSE');
      if (prev) {
        this.prevDayCache.set(key, prev);
        ok++;
      } else {
        console.warn(`🌅 Pre-market warm-up: no prev-day data for ${symbol} (${exchange})`);
      }
      await new Promise((r) => setTimeout(r, 600));
    }
    console.log(`🌅 Pre-market warm-up done: ${ok}/${unique.size} cached`);
  }

  // =========================
  // End-of-day Summary Email
  // =========================

  private eodCronJob: cron.ScheduledTask | null = null;

  scheduleEndOfDaySummary(): void {
    if (this.eodCronJob) return;
    // 3:35 PM IST (Mon–Fri) — 5 minutes after NSE close
    this.eodCronJob = cron.schedule('35 15 * * 1-5', () => {
      console.log('📧 End-of-day summary: triggered');
      this.sendEndOfDaySummary().catch((e) => console.error('EOD summary failed:', e));
    }, { timezone: 'Asia/Kolkata' });
    console.log('📧 End-of-day summary scheduled: 3:35 PM IST, Mon–Fri');
  }

  async sendEndOfDaySummary(): Promise<void> {
    if (!isBrevoConfigured()) {
      console.log('📧 EOD summary: Brevo not configured, skipping');
      return;
    }

    const watches = await getAllWatches();
    if (watches.length === 0) return;

    // Group watches by userId — deduplicate symbols per user
    const byUser = new Map<string, Set<string>>();
    const exchangeBySymbol = new Map<string, string>();
    const currencyBySymbol = new Map<string, string>();
    for (const w of watches) {
      const uid = w.userId || '';
      if (!uid) continue;
      if (!byUser.has(uid)) byUser.set(uid, new Set());
      byUser.get(uid)!.add(w.symbol.toUpperCase());
      exchangeBySymbol.set(w.symbol.toUpperCase(), w.exchange || 'NSE');
      currencyBySymbol.set(w.symbol.toUpperCase(), w.currency || 'INR');
    }

    const today = new Date().toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      weekday: 'short',
    });

    // Collect OHLC data for all unique symbols
    const allSymbols = new Set<string>();
    for (const syms of byUser.values()) for (const s of syms) allSymbols.add(s);

    const ohlcCache = new Map<string, DaySummaryItem>();
    for (const symbol of allSymbols) {
      try {
        const exchange = (exchangeBySymbol.get(symbol) || 'NSE') as 'NSE' | 'NFO' | 'BSE';
        const currency = currencyBySymbol.get(symbol) || 'INR';

        const summary = await fetchDaySummary(symbol, exchange, this.dataSource);
        if (!summary) continue;

        ohlcCache.set(symbol, {
          symbol,
          currency,
          todayOpen: summary.today.open,
          todayHigh: summary.today.high,
          todayLow: summary.today.low,
          todayClose: summary.today.close,
          yesterdayHigh: summary.yesterday?.high ?? null,
          yesterdayLow: summary.yesterday?.low ?? null,
        });
      } catch (e) {
        console.warn(`📧 EOD: failed to fetch ${symbol}:`, e);
      }
    }

    if (ohlcCache.size === 0) {
      console.log('📧 EOD summary: no OHLC data collected, skipping emails');
      return;
    }

    // Send one email per user
    for (const [userId, symbolSet] of byUser) {
      try {
        const email = await getClerkUserEmail(userId);
        if (!email) continue;

        const items: DaySummaryItem[] = [];
        for (const sym of symbolSet) {
          const data = ohlcCache.get(sym);
          if (data) items.push(data);
        }
        if (items.length === 0) continue;

        items.sort((a, b) => a.symbol.localeCompare(b.symbol));
        const result = await sendEndOfDaySummaryEmail(email, items, today);
        if (result.ok) {
          console.log(`📧 EOD summary sent to ${email} (${items.length} symbols)`);
        } else {
          console.warn(`📧 EOD summary failed for ${email}: ${result.error}`);
        }
      } catch (e) {
        console.warn(`📧 EOD summary error for user ${userId}:`, e);
      }
    }
  }

  // =========================
  // Status / Info Methods
  // =========================

  getMonitoringInfo(): {
    watchedSymbols: string[];
    alertCount: number;
    pushSubscriptionCount: number;
    emailAlertsConfigured: boolean;
    availableSources: string[];
  } {
    return {
      watchedSymbols: this.engine.getWatchedSymbols(),
      alertCount: getAlerts().length,
      pushSubscriptionCount: this.pushSubscriptions.size,
      emailAlertsConfigured: isBrevoConfigured() && getAlertRecipientEmails().length > 0,
      availableSources: this.dataSource.getAvailableSources(),
    };
  }

  getEmaStatus(symbol: string, timeframe: string, userId?: string) {
    return this.engine.getStatus(symbol, timeframe, userId);
  }

  isWatching(symbol: string, timeframe?: string): boolean {
    return this.engine.isWatching(symbol, timeframe);
  }
}
