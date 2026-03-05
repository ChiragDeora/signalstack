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

// web-push is optional — only needed for push notifications
let webpush: any = null;
try {
  webpush = require('web-push');
  const vapidPublic = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT;
  if (vapidPublic && vapidPrivate && vapidSubject) {
    webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
    console.log('✅ Web Push VAPID configured');
  } else {
    console.log('⚠️  Web Push VAPID keys not set — push notifications disabled');
    webpush = null;
  }
} catch {
  console.log('⚠️  web-push not installed — push notifications disabled');
}

export class CrossoverService {
  private engine: EMAEngine;
  private dataSource: UniversalMarketDataSource;
  private io: any; // Socket.IO server instance
  private cronJobs: Map<string, cron.ScheduledTask> = new Map();
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
   * Start monitoring a symbol for EMA crossovers
   */
  async startMonitoring(config: WatchConfig): Promise<{ success: boolean; message: string }> {
    const key = `${config.symbol.toUpperCase()}:${config.timeframe}`;

    // Validate
    if (!config.symbol || config.emaPeriods.length < 2) {
      return { success: false, message: 'Need a symbol and at least 2 EMA periods' };
    }

    // Stop existing monitoring for this key
    if (this.cronJobs.has(key)) {
      await this.stopMonitoring(config.symbol, config.timeframe);
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
        this.engine.warmUp(config.symbol, config.timeframe, priceData.candleData);

        // Emit initial price and EMA data
        this.emitPriceUpdate(config.symbol, priceData);
        this.emitEmaUpdate(config.symbol, config.timeframe);
      } else {
        console.warn(`⚠️  No historical data for warmup of ${config.symbol}`);
        this.emitStatus(config.symbol, config.timeframe, 'running', 'Running without historical warmup — EMAs will initialize from live ticks');
      }
    } catch (error: any) {
      console.error(`❌ Warmup error for ${config.symbol}:`, error?.message || error);
    }

    // 3. Set up cron job for periodic polling
    const cronExpr = this.getCronExpression(config.timeframe);
    console.log(`⏰ Scheduling ${config.symbol} (${config.timeframe}) with cron: ${cronExpr}`);

    const job = cron.schedule(cronExpr, () => {
      this.pollAndProcess(config).catch((err) =>
        console.error(`Poll error for ${config.symbol}:`, err)
      );
    });
    this.cronJobs.set(key, job);

    this.emitStatus(config.symbol, config.timeframe, 'running', 'Monitoring active');
    return { success: true, message: `Monitoring started for ${config.symbol} (${config.timeframe})` };
  }

  /**
   * Stop monitoring a symbol
   */
  async stopMonitoring(symbol: string, timeframe?: string): Promise<void> {
    const upperSymbol = symbol.toUpperCase();

    for (const [key, job] of this.cronJobs) {
      if (timeframe) {
        if (key === `${upperSymbol}:${timeframe}`) {
          job.stop();
          this.cronJobs.delete(key);
        }
      } else {
        if (key.startsWith(`${upperSymbol}:`)) {
          job.stop();
          this.cronJobs.delete(key);
        }
      }
    }

    this.engine.removeWatch(symbol, timeframe);
    this.emitStatus(symbol, timeframe || '', 'stopped', 'Monitoring stopped');
    console.log(`🛑 Stopped monitoring ${symbol}${timeframe ? ` (${timeframe})` : ''}`);
  }

  /**
   * Poll price data and process through EMA engine
   */
  private async pollAndProcess(config: WatchConfig): Promise<void> {
    try {
      const priceData = await this.dataSource.fetchTimeframeData(config.symbol, config.timeframe);
      if (!priceData) return;

      // Emit price update
      this.emitPriceUpdate(config.symbol, priceData);

      // Process through EMA engine
      const alerts = this.engine.processTick(
        config.symbol,
        config.timeframe,
        priceData.price,
        priceData.currency,
        priceData.source,
      );

      // Emit EMA update
      this.emitEmaUpdate(config.symbol, config.timeframe);

      // Handle crossover alerts
      this.handleAlerts(alerts);
    } catch (error) {
      console.error(`❌ Poll error for ${config.symbol}:`, error);
    }
  }

  /**
   * Handle detected crossover alerts
   */
  private handleAlerts(alerts: CrossoverAlert[]): void {
    for (const alert of alerts) {
      addAlert(alert);
      this.io?.emit('alert:crossover', alert);
      this.sendPushNotification(alert);
    }
  }

  /**
   * Emit price update via Socket.IO
   */
  private emitPriceUpdate(symbol: string, priceData: any): void {
    this.io?.emit('price:update', {
      symbol,
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
  private emitEmaUpdate(symbol: string, timeframe: string): void {
    const status = this.engine.getStatus(symbol, timeframe);
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

    const promises = [...this.pushSubscriptions.entries()].map(async ([endpoint, sub]) => {
      try {
        await webpush.sendNotification(sub, payload);
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
    availableSources: string[];
  } {
    return {
      watchedSymbols: this.engine.getWatchedSymbols(),
      alertCount: getAlerts().length,
      pushSubscriptionCount: this.pushSubscriptions.size,
      availableSources: this.dataSource.getAvailableSources(),
    };
  }

  getEmaStatus(symbol: string, timeframe: string) {
    return this.engine.getStatus(symbol, timeframe);
  }

  isWatching(symbol: string, timeframe?: string): boolean {
    return this.engine.isWatching(symbol, timeframe);
  }
}
