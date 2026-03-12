// ============================================
// EMA Engine - Multi-symbol EMA orchestrator
// ============================================
// Manages EMA calculators for each watched symbol-timeframe
// combo. Processes price ticks, detects crossovers.

import { EMACalculator, CrossoverDetector } from './ema';
import { CandleData, CrossoverAlert, WatchConfig, EmaStatus } from './types';
import { randomUUID } from 'crypto';

/** Convert timeframe string to duration in milliseconds */
function timeframeToMs(timeframe: string): number {
  const map: Record<string, number> = {
    '1m': 60_000,
    '5m': 5 * 60_000,
    '15m': 15 * 60_000,
    '30m': 30 * 60_000,
    '1h': 60 * 60_000,
    '4h': 4 * 60 * 60_000,
    '1d': 24 * 60 * 60_000,
  };
  return map[timeframe] || 5 * 60_000;
}

interface SymbolState {
  config: WatchConfig;
  emas: Map<number, EMACalculator>;
  detectors: CrossoverDetector[];
  lastPrice: number | null;
  isWarmedUp: boolean;
  /** Timestamp (ms) of the last candle whose close was fed into the EMAs */
  lastProcessedCandleTs: number;
}

export class EMAEngine {
  private symbols: Map<string, SymbolState> = new Map();

  private makeKey(symbol: string, timeframe: string, userId?: string): string {
    const sym = symbol.toUpperCase();
    return userId ? `${userId}:${sym}:${timeframe}` : `${sym}:${timeframe}`;
  }

  /**
   * Start watching a symbol with the given EMA configuration.
   * Creates EMA calculators and crossover detectors for all pairs.
   */
  addWatch(config: WatchConfig): void {
    const key = this.makeKey(config.symbol, config.timeframe, config.userId);

    // Don't duplicate
    if (this.symbols.has(key)) {
      this.removeWatch(config.symbol, config.timeframe, config.userId);
    }

    // Create EMA calculator for each period
    const emas = new Map<number, EMACalculator>();
    for (const period of config.emaPeriods) {
      emas.set(period, new EMACalculator(period));
    }

    // Create CrossoverDetector for each pair (sorted by period)
    const detectors: CrossoverDetector[] = [];
    const sorted = [...config.emaPeriods].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        detectors.push(
          new CrossoverDetector(sorted[i], sorted[j], config.trackBullish, config.trackBearish)
        );
      }
    }

    this.symbols.set(key, {
      config,
      emas,
      detectors,
      lastPrice: null,
      isWarmedUp: false,
      lastProcessedCandleTs: 0,
    });

    console.log(
      `📊 EMA Engine: watching ${config.symbol} (${config.timeframe}) with EMAs: [${sorted.join(', ')}] → ${detectors.length} crossover pairs`
    );
  }

  /**
   * Stop watching a symbol (optionally scoped by userId)
   */
  removeWatch(symbol: string, timeframe?: string, userId?: string): void {
    const sym = symbol.toUpperCase();
    if (timeframe && userId) {
      this.symbols.delete(this.makeKey(symbol, timeframe, userId));
    } else if (!timeframe && userId) {
      for (const key of this.symbols.keys()) {
        if (key.startsWith(`${userId}:${sym}:`)) this.symbols.delete(key);
      }
    } else if (timeframe) {
      this.symbols.delete(this.makeKey(symbol, timeframe));
    } else {
      for (const key of this.symbols.keys()) {
        if (key.endsWith(`:${sym}`) || key.includes(`:${sym}:`)) this.symbols.delete(key);
      }
    }
  }

  /**
   * Feed historical candles to warm up all EMAs for a symbol.
   * Candles must be sorted by timestamp ascending (oldest first).
   */
  warmUp(symbol: string, timeframe: string, candles: CandleData[], userId?: string): void {
    const key = this.makeKey(symbol, timeframe, userId);
    const state = this.symbols.get(key);
    if (!state) return;

    // Sort candles chronologically
    const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);

    // Exclude the current (still-forming) candle: a candle is "closed" when
    // its open-time + interval duration <= now.  This ensures we only warm up
    // with confirmed close prices, matching what a chart would show.
    const intervalMs = timeframeToMs(timeframe);
    const now = Date.now();
    const closedCandles = sorted.filter((c) => c.timestamp + intervalMs <= now && c.close > 0);

    if (closedCandles.length === 0) {
      console.warn(`⚠️  EMA Engine: no closed candles for warmup of ${symbol}`);
      return;
    }

    const closePrices = closedCandles.map((c) => c.close);

    // Feed all historical closes to each EMA calculator
    for (const [period, calc] of state.emas) {
      calc.bulkLoad(closePrices);
      const progress = calc.warmupProgress();
      if (progress < 1) {
        console.log(
          `📊 EMA(${period}) for ${symbol}: ${Math.round(progress * 100)}% warmed up (${closePrices.length}/${period} candles)`
        );
      }
    }

    // Initialize crossover detectors with current EMA relations
    // (so the first tick after warmup doesn't produce a false crossover)
    for (const detector of state.detectors) {
      const ema1 = state.emas.get(detector.ema1Period)?.getValue();
      const ema2 = state.emas.get(detector.ema2Period)?.getValue();
      if (ema1 !== null && ema1 !== undefined && ema2 !== null && ema2 !== undefined) {
        // Call checkCrossover once to set the initial lastRelation
        // but ignore the result (it's just initializing state)
        detector.checkCrossover(ema1, ema2, closePrices[closePrices.length - 1], symbol);
      }
    }

    state.lastPrice = closePrices[closePrices.length - 1];
    state.isWarmedUp = state.emas.size > 0;
    state.lastProcessedCandleTs = closedCandles[closedCandles.length - 1].timestamp;

    const allReady = [...state.emas.values()].every((c) => c.isReady());
    console.log(
      `📊 EMA Engine: warmup complete for ${symbol} (${timeframe}) — ${closePrices.length} closed candles, all EMAs ready: ${allReady}`
    );
  }

  /**
   * Process a single new price tick.
   * Updates all EMAs and checks all crossover pairs.
   * Returns any crossover alerts detected.
   */
  processTick(
    symbol: string,
    timeframe: string,
    price: number,
    currency: string,
    source: string = 'tick',
    userId?: string,
    priceTimestamp?: string,
  ): CrossoverAlert[] {
    const key = this.makeKey(symbol, timeframe, userId);
    const state = this.symbols.get(key);
    if (!state) return [];

    const alerts: CrossoverAlert[] = [];

    // Update all EMAs with new price
    for (const [, calc] of state.emas) {
      calc.update(price);
    }

    // Check all crossover detectors
    for (const detector of state.detectors) {
      const ema1Val = state.emas.get(detector.ema1Period)?.getValue();
      const ema2Val = state.emas.get(detector.ema2Period)?.getValue();

      if (ema1Val !== null && ema1Val !== undefined && ema2Val !== null && ema2Val !== undefined) {
        const result = detector.checkCrossover(ema1Val, ema2Val, price, symbol);
        if (result) {
          // Use price/candle timestamp so alert shows when crossover occurred, not when we sent it
          const alertTimestamp = priceTimestamp || result.timestamp;
          const alert: CrossoverAlert = {
            id: randomUUID(),
            symbol,
            timeframe,
            fastPeriod: result.ema1Period,
            slowPeriod: result.ema2Period,
            fastEmaValue: parseFloat(result.ema1Value.toFixed(2)),
            slowEmaValue: parseFloat(result.ema2Value.toFixed(2)),
            crossoverType: result.type,
            price: parseFloat(price.toFixed(2)),
            currency,
            timestamp: alertTimestamp,
            source,
          };
          alerts.push(alert);
          console.log(
            `🚨 CROSSOVER: ${alert.crossoverType.toUpperCase()} on ${symbol} — EMA(${alert.fastPeriod}) ${alert.crossoverType === 'bullish' ? '↑ above' : '↓ below'} EMA(${alert.slowPeriod}) at ₹${alert.price}`
          );
        }
      }
    }

    state.lastPrice = price;
    return alerts;
  }

  /**
   * Process only newly-closed candles through the EMA engine.
   *
   * Unlike processTick (which treats every call as a new data point), this
   * method compares candle timestamps against the last processed candle and
   * only feeds candles whose close is confirmed (candle start + interval <=
   * now).  This produces EMA values identical to a chart — no intra-candle
   * noise, no duplicate updates from repeated polling.
   *
   * @param currentPrice  Live LTP — stored for display only, NOT fed into EMAs.
   */
  processNewCandles(
    symbol: string,
    timeframe: string,
    candles: CandleData[],
    currentPrice: number,
    currency: string,
    source: string = 'candle-close',
    userId?: string,
  ): CrossoverAlert[] {
    const key = this.makeKey(symbol, timeframe, userId);
    const state = this.symbols.get(key);
    if (!state) return [];

    const intervalMs = timeframeToMs(timeframe);
    const now = Date.now();

    // Sort candles chronologically
    const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);

    // Only process candles that are:
    //  1. Newer than the last candle we already processed
    //  2. Definitely closed (open-time + interval <= now)
    //  3. Have a valid close price
    const newClosedCandles = sorted.filter(
      (c) =>
        c.timestamp > state.lastProcessedCandleTs &&
        c.timestamp + intervalMs <= now &&
        c.close > 0,
    );

    if (newClosedCandles.length > 0) {
      console.log(
        `📊 EMA Engine: processing ${newClosedCandles.length} new closed candle(s) for ${symbol} (${timeframe})`,
      );
    }

    const alerts: CrossoverAlert[] = [];

    for (const candle of newClosedCandles) {
      // Update all EMAs with the candle's confirmed close price
      for (const [, calc] of state.emas) {
        calc.update(candle.close);
      }

      // Check all crossover detectors
      for (const detector of state.detectors) {
        const ema1Val = state.emas.get(detector.ema1Period)?.getValue();
        const ema2Val = state.emas.get(detector.ema2Period)?.getValue();

        if (ema1Val !== null && ema1Val !== undefined && ema2Val !== null && ema2Val !== undefined) {
          const result = detector.checkCrossover(ema1Val, ema2Val, candle.close, symbol);
          if (result) {
            const alert: CrossoverAlert = {
              id: randomUUID(),
              symbol,
              timeframe,
              fastPeriod: result.ema1Period,
              slowPeriod: result.ema2Period,
              fastEmaValue: parseFloat(result.ema1Value.toFixed(2)),
              slowEmaValue: parseFloat(result.ema2Value.toFixed(2)),
              crossoverType: result.type,
              price: parseFloat(candle.close.toFixed(2)),
              currency,
              timestamp: new Date(candle.timestamp).toISOString(),
              source,
            };
            alerts.push(alert);
            console.log(
              `🚨 CROSSOVER: ${alert.crossoverType.toUpperCase()} on ${symbol} — EMA(${alert.fastPeriod}) ${alert.crossoverType === 'bullish' ? '↑ above' : '↓ below'} EMA(${alert.slowPeriod}) at ₹${alert.price}`,
            );
          }
        }
      }

      state.lastProcessedCandleTs = candle.timestamp;
    }

    // Update lastPrice with live LTP for display — but do NOT feed it into EMAs
    state.lastPrice = currentPrice;
    return alerts;
  }

  /**
   * Get current EMA values and warmup progress for display on frontend
   */
  getStatus(symbol: string, timeframe: string, userId?: string): EmaStatus | null {
    const key = this.makeKey(symbol, timeframe, userId);
    const state = this.symbols.get(key);
    if (!state) return null;

    const emas: Record<number, number | null> = {};
    const warmupProgress: Record<number, number> = {};

    for (const [period, calc] of state.emas) {
      emas[period] = calc.getValue();
      warmupProgress[period] = calc.warmupProgress();
    }

    return { emas, warmupProgress, lastPrice: state.lastPrice };
  }

  /**
   * Get all watched symbol keys
   */
  getWatchedSymbols(): string[] {
    return Array.from(this.symbols.keys());
  }

  /**
   * Check if a symbol is being watched
   */
  isWatching(symbol: string, timeframe?: string, userId?: string): boolean {
    if (timeframe && userId) return this.symbols.has(this.makeKey(symbol, timeframe, userId));
    if (timeframe) return this.symbols.has(this.makeKey(symbol, timeframe));
    const sym = symbol.toUpperCase();
    for (const key of this.symbols.keys()) {
      if (userId && key.startsWith(`${userId}:${sym}:`)) return true;
      if (!userId && (key.startsWith(`${sym}:`) || key.includes(`:${sym}:`))) return true;
    }
    return false;
  }

  /**
   * Get the config for a watched symbol
   */
  getConfig(symbol: string, timeframe: string, userId?: string): WatchConfig | null {
    const state = this.symbols.get(this.makeKey(symbol, timeframe, userId));
    return state?.config || null;
  }
}
