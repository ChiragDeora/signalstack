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

  /**
   * Minimum percentage gap between the two EMAs before we register
   * a change in relation.  Expressed as a fraction of the slow EMA.
   *
   * Example: 0.0005 = 0.05%.  For a stock at ₹1000, the fast EMA must
   * be at least ₹0.50 above/below the slow EMA.
   *
   * Reduced from 0.1% to 0.05% — the previous 0.1% was too aggressive
   * and could swallow legitimate crossovers on low-volatility instruments
   * or options with small absolute price differences between EMAs.
   */
  private static readonly DEAD_ZONE_PCT = 0.0005;

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
   * Uses raw comparison (no dead zone) so the initial state is always correct.
   *
   * Called during warmup / late-warmup to seed the detector.
   */
  initRelation(ema1Value: number, ema2Value: number): void {
    if (!ema1Value || !ema2Value) return;
    // Raw comparison — no dead zone — so the initial state matches reality
    this.lastRelation = ema1Value >= ema2Value ? 'above' : 'below';
  }

  /**
   * Check if a crossover has occurred.
   * ema1Value = fast EMA (shorter period), ema2Value = slow EMA (longer period)
   * Returns crossover info if detected, null otherwise.
   *
   * Dead zone prevents flicker: EMAs must diverge by at least DEAD_ZONE_PCT
   * before the relation changes.  The dead zone only HOLDS previous state; it
   * never INFERS initial state (that's done by initRelation).
   *
   * @param candleTimestamp  ISO timestamp of the candle that produced these EMA
   *                         values.  Used in the alert so the timestamp reflects
   *                         WHEN the crossover occurred, not when we detected it.
   */
  checkCrossover(
    ema1Value: number,
    ema2Value: number,
    price: number,
    symbol: string,
    candleTimestamp?: string,
  ): CrossoverResult | null {
    if (!ema1Value || !ema2Value) return null;

    // ── Dead zone: hold previous relation if EMAs are too close ──
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
      // This ensures the detector stays in sync with reality, so the NEXT
      // crossover in the opposite (tracked) direction fires correctly.
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

      // Crossover detected but not tracked — no alert, but state IS updated (above)
      return null;
    }

    this.lastRelation = currentRelation;
    return null;
  }

  getCurrentRelation(): 'above' | 'below' | null {
    return this.lastRelation;
  }

  reset(): void {
    this.lastRelation = null;
  }
}