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
  WatchConfig, CrossoverAlert, PriceUpdate, EmaUpdate,
  MonitorStatus, PushSubscriptionData,
} from './types';
import {
  sendCrossoverAlertEmail,
  isBrevoConfigured,
  getAlertRecipientEmails,
} from './brevoEmail';
import { getClerkUserEmail } from './clerkUserEmail';
// marketHours removed — alerts now fire regardless of trading hours

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

    // Validate
    if (!config.symbol || config.emaPeriods.length < 2) {
      return { success: false, message: 'Need a symbol and at least 2 EMA periods' };
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
    this.emitStatus(config.symbol, config.timeframe, 'starting', 'Fetching historical data for EMA warmup...');

    // 1. Add to engine
    this.engine.addWatch(config);

    // 2. Fetch historical data for EMA warmup
    try {
      this.emitStatus(config.symbol, config.timeframe, 'warming_up', 'Loading historical candles...');

      const priceData = await this.dataSource.fetchTimeframeData(config.symbol, config.timeframe, (config.exchange as 'NSE' | 'NFO' | 'BSE') || 'NSE');

      if (priceData?.candleData && priceData.candleData.length > 0) {
        this.engine.warmUp(config.symbol, config.timeframe, priceData.candleData, config.userId);

        // Silent seed tick: feed current LTP so lastRelation matches live data
        // and the first real poll doesn't produce a false crossover.
        if (priceData.price > 0) {
          this.engine.processTick(
            config.symbol, config.timeframe, priceData.price,
            priceData.currency, priceData.source, config.userId,
          ); // discard returned alerts — they are warmup artefacts
        }

        // Emit initial price and EMA data
        this.emitPriceUpdate(config.symbol, config.timeframe, priceData);
        this.emitEmaUpdate(config.symbol, config.timeframe, config.userId);
      } else {
        console.warn(`⚠️  No historical data for warmup of ${config.symbol}`);
        this.emitStatus(config.symbol, config.timeframe, 'running', 'Running without historical warmup — EMAs will initialize from live ticks');
        if (priceData) this.emitPriceUpdate(config.symbol, config.timeframe, priceData);
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

    this.emitStatus(config.symbol, config.timeframe, 'running', 'Monitoring active');
    return { success: true, message: `Monitoring started for ${config.symbol} (${config.timeframe})` };
  }

  /**
   * Restore all persisted watches (call on server startup so monitoring survives restarts).
   */
  async restoreAllWatches(configs: WatchConfig[]): Promise<void> {
    if (!configs?.length) return;
    console.log(`📂 Restoring ${configs.length} persisted watch(es)...`);
    for (const config of configs) {
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
    this.emitStatus(symbol, timeframe || '', 'stopped', 'Monitoring stopped');
    console.log(`🛑 Stopped monitoring ${symbol}${timeframe ? ` (${timeframe})` : ''}${userId ? ' [user]' : ''}`);
  }

  /**
   * Poll price data and process through EMA engine
   */
  private async pollAndProcess(config: WatchConfig): Promise<void> {
    try {
      const priceData = await this.dataSource.fetchTimeframeData(config.symbol, config.timeframe, (config.exchange as 'NSE' | 'NFO' | 'BSE') || 'NSE');
      if (!priceData) return;

      // Emit price update
      this.emitPriceUpdate(config.symbol, config.timeframe, priceData);

      // Process through EMA engine (pass price timestamp so alert time = crossover time, not send time)
      const alerts = this.engine.processTick(
        config.symbol,
        config.timeframe,
        priceData.price,
        priceData.currency,
        priceData.source,
        config.userId,
        priceData.timestamp,
      );

      // Emit EMA update
      this.emitEmaUpdate(config.symbol, config.timeframe, config.userId);

      // Handle crossover alerts (pass userId and exchange so we skip email/push when market closed)
      this.handleAlerts(alerts, config.userId, config.exchange);
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
  private handleAlerts(alerts: CrossoverAlert[], userId?: string, _exchange?: string): void {
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

      addAlert(alert);
      this.io?.emit('alert:crossover', alert);

      this.sendPushNotification(alert, userId);
      userEmailPromise.then((email) => sendCrossoverAlertEmail(alert, email)).catch((e) =>
        console.warn('Crossover email alert failed:', e),
      );
    }
  }

  /**
   * Emit price update via Socket.IO
   */
  private emitPriceUpdate(symbol: string, timeframe: string, priceData: any): void {
    this.io?.emit('price:update', {
      symbol,
      timeframe,
      price: priceData.price,
      change: priceData.change || 0,
      changePercent: priceData.changePercent || 0,
      currency: priceData.currency || 'INR',
      source: priceData.source || 'unknown',
      timestamp: priceData.timestamp || new Date().toISOString(),
    } as PriceUpdate);
  }

  /**
   * Emit EMA status update via Socket.IO
   */
  private emitEmaUpdate(symbol: string, timeframe: string, userId?: string): void {
    const status = this.engine.getStatus(symbol, timeframe, userId);
    if (status) {
      this.io?.emit('ema:update', {
        symbol,
        timeframe,
        emas: status.emas,
        warmupProgress: status.warmupProgress,
      } as EmaUpdate);
    }
  }

  /**
   * Emit monitoring status via Socket.IO
   */
  private emitStatus(
    symbol: string,
    timeframe: string,
    status: MonitorStatus['status'],
    message?: string,
  ): void {
    this.io?.emit('monitor:status', { symbol, timeframe, status, message } as MonitorStatus);
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
    const payload = JSON.stringify({
      title: `${emoji} ${alert.crossoverType === 'bullish' ? 'Bullish' : 'Bearish'} Crossover: ${alert.symbol}`,
      body: `EMA(${alert.fastPeriod}) crossed ${alert.crossoverType === 'bullish' ? 'above' : 'below'} EMA(${alert.slowPeriod}) at ₹${alert.price}`,
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
