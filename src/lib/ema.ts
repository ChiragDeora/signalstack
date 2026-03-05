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
   * Check if a crossover has occurred.
   * ema1Value = fast EMA (shorter period), ema2Value = slow EMA (longer period)
   * Returns crossover info if detected, null otherwise.
   */
  checkCrossover(
    ema1Value: number,
    ema2Value: number,
    price: number,
    symbol: string,
  ): CrossoverResult | null {
    if (!ema1Value || !ema2Value) return null;

    const currentRelation: 'above' | 'below' = ema1Value > ema2Value ? 'above' : 'below';

    if (this.lastRelation && this.lastRelation !== currentRelation) {
      const crossoverType = currentRelation === 'above' ? 'bullish' : 'bearish';

      if (
        (crossoverType === 'bullish' && this.trackBullish) ||
        (crossoverType === 'bearish' && this.trackBearish)
      ) {
        this.lastRelation = currentRelation;
        return {
          symbol,
          type: crossoverType,
          ema1Period: this.ema1Period,
          ema2Period: this.ema2Period,
          ema1Value,
          ema2Value,
          price,
          timestamp: new Date().toISOString(),
        };
      }
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
