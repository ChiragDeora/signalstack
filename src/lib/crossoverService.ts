// ============================================
// Crossover Detection Service
// ============================================
// Top-level orchestration: ties data fetching, EMA computation,
// crossover detection, cron polling, Socket.IO broadcasting,
// and push notifications together.

import * as cron from 'node-cron';
import { EMAEngine } from './emaEngine';
import { UniversalMarketDataSource } from './dynamicMarketSource';
import { addAlert, getAlerts } from './alertStore';
import {
  WatchConfig, CrossoverAlert, PriceUpdate, EmaUpdate,
  MonitorStatus, PushSubscriptionData, TIMEFRAMES,
} from './types';
import {
  sendCrossoverAlertEmail,
  isBrevoConfigured,
  getAlertRecipientEmails,
} from './brevoEmail';
import { getClerkUserEmail } from './clerkUserEmail';

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

const REAL_TIME_POLL_MS = 15_000; // Poll 1m every 15s for near real-time alerts
const MAX_WATCHES_PER_USER = 100; // Max symbols×timeframes one user can monitor (segregates API poll load)

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

export class CrossoverService {
  private engine: EMAEngine;
  private dataSource: UniversalMarketDataSource;
  private io: any; // Socket.IO server instance
  private cronJobs: Map<string, cron.ScheduledTask> = new Map();
  private intervalJobs: Map<string, NodeJS.Timeout> = new Map(); // 1m real-time polling
  private pushSubscriptions: Map<string, PushSubscriptionData> = new Map();
  private initialized = false;

  constructor(io: any) {
    this.io = io;
    this.engine = new EMAEngine();
    this.dataSource = new UniversalMarketDataSource();
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

      const priceData = await this.dataSource.fetchTimeframeData(config.symbol, config.timeframe);

      if (priceData?.candleData && priceData.candleData.length > 0) {
        this.engine.warmUp(config.symbol, config.timeframe, priceData.candleData, config.userId);

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

    // 3. Set up polling: 1m uses 30s interval for real-time alerts; others use cron
    if (config.timeframe === '1m') {
      console.log(`⏰ Real-time polling ${config.symbol} (1m) every ${REAL_TIME_POLL_MS / 1000}s${config.userId ? ` [user]` : ''}`);
      const intervalId = setInterval(() => {
        this.pollAndProcess(config).catch((err) =>
          console.error(`Poll error for ${config.symbol}:`, err)
        );
      }, REAL_TIME_POLL_MS);
      this.intervalJobs.set(key, intervalId);
    } else {
      const cronExpr = this.getCronExpression(config.timeframe);
      console.log(`⏰ Scheduling ${config.symbol} (${config.timeframe}) with cron: ${cronExpr}${config.userId ? ` [user]` : ''}`);
      const job = cron.schedule(cronExpr, () => {
        this.pollAndProcess(config).catch((err) =>
          console.error(`Poll error for ${config.symbol}:`, err)
        );
      });
      this.cronJobs.set(key, job);
    }

    // 4. Run first poll immediately so data refreshes right away
    this.pollAndProcess(config).catch((err) =>
      console.error(`Initial poll error for ${config.symbol}:`, err)
    );

    this.emitStatus(config.symbol, config.timeframe, 'running', 'Monitoring active');
    return { success: true, message: `Monitoring started for ${config.symbol} (${config.timeframe})` };
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
      const priceData = await this.dataSource.fetchTimeframeData(config.symbol, config.timeframe);
      if (!priceData) return;

      // Emit price update
      this.emitPriceUpdate(config.symbol, config.timeframe, priceData);

      // Process through EMA engine
      const alerts = this.engine.processTick(
        config.symbol,
        config.timeframe,
        priceData.price,
        priceData.currency,
        priceData.source,
        config.userId,
      );

      // Emit EMA update
      this.emitEmaUpdate(config.symbol, config.timeframe, config.userId);

      // Handle crossover alerts (pass userId so we can email the signed-in user)
      this.handleAlerts(alerts, config.userId);
    } catch (error) {
      console.error(`❌ Poll error for ${config.symbol}:`, error);
    }
  }

  /**
   * Handle detected crossover alerts. When userId is set, fetches that user's email from Clerk and sends the alert there too.
   */
  private handleAlerts(alerts: CrossoverAlert[], userId?: string): void {
    const userEmailPromise =
      userId && alerts.length > 0 ? getClerkUserEmail(userId) : Promise.resolve(null);
    for (const alert of alerts) {
      addAlert(alert);
      this.io?.emit('alert:crossover', alert);
      this.sendPushNotification(alert);
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

  /**
   * Get cron expression for a timeframe
   */
  private getCronExpression(timeframe: string): string {
    const tf = TIMEFRAMES.find((t) => t.id === timeframe);
    return tf?.cronExpr || '*/5 * * * *';
  }

  // =========================
  // Push Notification Methods
  // =========================

  addPushSubscription(sub: PushSubscriptionData): void {
    this.pushSubscriptions.set(sub.endpoint, sub);
    console.log(`🔔 Push subscription added (total: ${this.pushSubscriptions.size})`);
  }

  removePushSubscription(endpoint: string): void {
    this.pushSubscriptions.delete(endpoint);
  }

  private async sendPushNotification(alert: CrossoverAlert): Promise<void> {
    if (!webpush || this.pushSubscriptions.size === 0) return;

    const emoji = alert.crossoverType === 'bullish' ? '📈' : '📉';
    const payload = JSON.stringify({
      title: `${emoji} ${alert.crossoverType === 'bullish' ? 'Bullish' : 'Bearish'} Crossover: ${alert.symbol}`,
      body: `EMA(${alert.fastPeriod}) crossed ${alert.crossoverType === 'bullish' ? 'above' : 'below'} EMA(${alert.slowPeriod}) at ₹${alert.price}`,
      tag: `crossover-${alert.symbol}-${alert.id}`,
      url: '/',
    });

    const options = { TTL: 86400, urgency: 'high' as const };
    const promises = [...this.pushSubscriptions.entries()].map(async ([endpoint, sub]) => {
      try {
        await webpush.sendNotification(sub, payload, options);
      } catch (err: any) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          this.pushSubscriptions.delete(endpoint);
          console.log(`🔔 Removed expired push subscription`);
        }
      }
    });

    await Promise.allSettled(promises);
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
