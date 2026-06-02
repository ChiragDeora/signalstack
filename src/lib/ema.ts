// ============================================
// EMA Calculator & Crossover Detector
// ============================================

export interface EMAState {
  period: number;
  ema: number | null;
  priceCount: number;
  initialized: boolean;
}

export class EMACalculator {
  private period: number;
  private multiplier: number;
  private ema: number | null = null;
  private prices: number[] = [];
  private initialized = false;

  constructor(period: number) {
    this.period = period;
    this.multiplier = 2 / (period + 1);
  }

  /**
   * Update EMA with a single new price.
   * Returns the current EMA value or null if not enough data yet.
   */
  update(price: number): number | null {
    if (typeof price !== 'number' || isNaN(price) || price <= 0) {
      return this.ema;
    }

    this.prices.push(price);

    if (!this.initialized) {
      if (this.prices.length >= this.period) {
        // Initialize with SMA of first `period` prices
        const sum = this.prices.slice(-this.period).reduce((a, b) => a + b, 0);
        this.ema = sum / this.period;
        this.initialized = true;
      }
    } else {
      if (this.ema !== null) {
        // Standard EMA formula: EMA = price * k + prevEMA * (1 - k)
        this.ema = (price * this.multiplier) + (this.ema * (1 - this.multiplier));
      }
    }

    return this.ema;
  }

  /**
   * Bulk-load historical prices to warm up the EMA.
   * Prices should be in chronological order (oldest first).
   */
  bulkLoad(closePrices: number[]): void {
    for (const price of closePrices) {
      if (typeof price !== 'number' || isNaN(price) || price <= 0) continue;
      this.update(price);
    }
    // Trim stored prices to save memory after init
    if (this.initialized && this.prices.length > this.period) {
      this.prices = this.prices.slice(-this.period);
    }
  }

  getValue(): number | null {
    return this.ema;
  }

  getPeriod(): number {
    return this.period;
  }

  isReady(): boolean {
    return this.initialized && this.ema !== null;
  }

  /**
   * Returns warmup progress as a fraction 0..1
   * 1.0 means the EMA is fully initialized
   */
  warmupProgress(): number {
    if (this.initialized) return 1;
    return Math.min(this.prices.length / this.period, 1);
  }

  /**
   * Serialize state for persistence
   */
  getState(): EMAState {
    return {
      period: this.period,
      ema: this.ema,
      priceCount: this.prices.length,
      initialized: this.initialized,
    };
  }

  reset(): void {
    this.ema = null;
    this.prices = [];
    this.initialized = false;
  }
}

export interface CrossoverResult {
  symbol: string;
  type: 'bullish' | 'bearish';
  ema1Period: number;
  ema2Period: number;
  ema1Value: number;
  ema2Value: number;
  price: number;
  timestamp: string;
}

export class CrossoverDetector {
  readonly ema1Period: number;
  readonly ema2Period: number;
  private trackBullish: boolean;
  private trackBearish: boolean;
  private lastRelation: 'above' | 'below' | null = null;

  // ================================================================
  // BACKUP: Cooldown approach (commented out — caused missed crossovers)
  //   - Detects crossover on the exact candle (no delay)
  //   - BUT: suppresses real crossovers that happen within 2 candles
  //     of a previous one, causing missed alerts
  // ================================================================
  // private static readonly COOLDOWN_CANDLES = 2;
  // private cooldownRemaining: number = 0;

  // ================================================================
  // ACTIVE: Dead zone approach
  //   - Holds previous state when EMAs are within DEAD_ZONE_PCT of each
  //     other to prevent flicker on tight EMA spreads.
  //   - Tightened from 0.05% → 0.02% on candle-close-only pipeline:
  //     since we no longer feed live ticks, intra-candle flicker is not a
  //     concern and the wider band was suppressing legitimate close
  //     crossovers in tight markets.
  // ================================================================
  private static readonly DEAD_ZONE_PCT = 0.0002;

  constructor(
    ema1Period: number,
    ema2Period: number,
    trackBullish: boolean = true,
    trackBearish: boolean = true,
  ) {
    this.ema1Period = ema1Period;
    this.ema2Period = ema2Period;
    this.trackBullish = trackBullish;
    this.trackBearish = trackBearish;
  }

  /**
   * Initialise the detector's lastRelation WITHOUT triggering any alert.
   * Uses raw comparison so the initial state is always correct.
   *
   * Called during warmup / late-warmup to seed the detector.
   */
  initRelation(ema1Value: number, ema2Value: number): void {
    if (!ema1Value || !ema2Value) return;
    this.lastRelation = ema1Value >= ema2Value ? 'above' : 'below';
  }

  // ================================================================
  // ACTIVE: Dead-zone-based checkCrossover (original proven version)
  // ================================================================
  /**
   * Check if a crossover has occurred.
   * ema1Value = fast EMA (shorter period), ema2Value = slow EMA (longer period)
   *
   * Dead zone prevents flicker: EMAs must diverge by at least DEAD_ZONE_PCT
   * before the relation changes.
   */
  checkCrossover(
    ema1Value: number,
    ema2Value: number,
    price: number,
    symbol: string,
    candleTimestamp?: string,
  ): CrossoverResult | null {
    if (!ema1Value || !ema2Value) return null;

    const threshold = ema2Value * CrossoverDetector.DEAD_ZONE_PCT;
    const diff = ema1Value - ema2Value;

    let currentRelation: 'above' | 'below';

    if (Math.abs(diff) < threshold && this.lastRelation !== null) {
      // Inside the dead zone AND we already have a baseline — hold to prevent flicker
      currentRelation = this.lastRelation;
    } else {
      // Outside dead zone, OR first call (no baseline yet) — use raw comparison
      currentRelation = diff >= 0 ? 'above' : 'below';
    }

    if (this.lastRelation && this.lastRelation !== currentRelation) {
      const crossoverType = currentRelation === 'above' ? 'bullish' : 'bearish';

      // Always update lastRelation even if we don't track this direction.
      this.lastRelation = currentRelation;

      if (
        (crossoverType === 'bullish' && this.trackBullish) ||
        (crossoverType === 'bearish' && this.trackBearish)
      ) {
        return {
          symbol,
          type: crossoverType,
          ema1Period: this.ema1Period,
          ema2Period: this.ema2Period,
          ema1Value,
          ema2Value,
          price,
          timestamp: candleTimestamp || new Date().toISOString(),
        };
      }

      return null;
    }

    this.lastRelation = currentRelation;
    return null;
  }

  // ================================================================
  // BACKUP: Cooldown-based checkCrossover (commented out)
  // Detects immediately but swallows legitimate crossovers that
  // happen within 2 candles of a prior one.
  // ================================================================
  // checkCrossover_cooldown(
  //   ema1Value: number,
  //   ema2Value: number,
  //   price: number,
  //   symbol: string,
  //   candleTimestamp?: string,
  // ): CrossoverResult | null {
  //   if (!ema1Value || !ema2Value) return null;
  //
  //   const diff = ema1Value - ema2Value;
  //   const currentRelation: 'above' | 'below' = diff >= 0 ? 'above' : 'below';
  //
  //   if (this.cooldownRemaining > 0) {
  //     this.cooldownRemaining--;
  //     this.lastRelation = currentRelation;
  //     return null;
  //   }
  //
  //   if (this.lastRelation && this.lastRelation !== currentRelation) {
  //     const crossoverType = currentRelation === 'above' ? 'bullish' : 'bearish';
  //     this.lastRelation = currentRelation;
  //     this.cooldownRemaining = CrossoverDetector.COOLDOWN_CANDLES;
  //
  //     if (
  //       (crossoverType === 'bullish' && this.trackBullish) ||
  //       (crossoverType === 'bearish' && this.trackBearish)
  //     ) {
  //       return {
  //         symbol,
  //         type: crossoverType,
  //         ema1Period: this.ema1Period,
  //         ema2Period: this.ema2Period,
  //         ema1Value,
  //         ema2Value,
  //         price,
  //         timestamp: candleTimestamp || new Date().toISOString(),
  //       };
  //     }
  //     return null;
  //   }
  //
  //   this.lastRelation = currentRelation;
  //   return null;
  // }

  getCurrentRelation(): 'above' | 'below' | null {
    return this.lastRelation;
  }

  reset(): void {
    this.lastRelation = null;
  }
}