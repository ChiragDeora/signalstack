// ============================================
// RSI Calculator & Signal Detector
// ============================================
// Wilder's smoothing method (the standard used by every charting platform).
// Period N requires N+1 closes to produce the first RSI value.

export interface RSIState {
  period: number;
  rsi: number | null;
  priceCount: number;
  initialized: boolean;
}

export class RSICalculator {
  private period: number;
  private prevClose: number | null = null;
  private avgGain: number | null = null;
  private avgLoss: number | null = null;
  private seedGains: number[] = [];
  private seedLosses: number[] = [];
  private rsi: number | null = null;
  private initialized = false;

  constructor(period: number) {
    if (!Number.isFinite(period) || period < 2) {
      throw new Error(`RSICalculator: period must be >= 2 (got ${period})`);
    }
    this.period = period;
  }

  /**
   * Update RSI with a single new close price.
   * Returns the current RSI value, or null if not enough data yet.
   */
  update(close: number): number | null {
    if (typeof close !== 'number' || !Number.isFinite(close) || close <= 0) {
      return this.rsi;
    }

    if (this.prevClose === null) {
      this.prevClose = close;
      return this.rsi;
    }

    const change = close - this.prevClose;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    if (!this.initialized) {
      this.seedGains.push(gain);
      this.seedLosses.push(loss);

      if (this.seedGains.length === this.period) {
        // Seed with simple average of the first `period` changes (Wilder)
        const sumG = this.seedGains.reduce((a, b) => a + b, 0);
        const sumL = this.seedLosses.reduce((a, b) => a + b, 0);
        this.avgGain = sumG / this.period;
        this.avgLoss = sumL / this.period;
        this.initialized = true;
        this.rsi = this.computeRSI(this.avgGain, this.avgLoss);
        // Free seed arrays
        this.seedGains = [];
        this.seedLosses = [];
      }
    } else if (this.avgGain !== null && this.avgLoss !== null) {
      // Wilder smoothing: avg = (prevAvg * (period - 1) + current) / period
      this.avgGain = (this.avgGain * (this.period - 1) + gain) / this.period;
      this.avgLoss = (this.avgLoss * (this.period - 1) + loss) / this.period;
      this.rsi = this.computeRSI(this.avgGain, this.avgLoss);
    }

    this.prevClose = close;
    return this.rsi;
  }

  private computeRSI(avgGain: number, avgLoss: number): number {
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  /**
   * Bulk-load historical closes (oldest first). Used for warmup.
   */
  bulkLoad(closes: number[]): void {
    for (const c of closes) {
      this.update(c);
    }
  }

  getValue(): number | null {
    return this.rsi;
  }

  getPeriod(): number {
    return this.period;
  }

  isReady(): boolean {
    return this.initialized && this.rsi !== null;
  }

  /**
   * Warmup progress 0..1. We need `period + 1` closes for the first value.
   */
  warmupProgress(): number {
    if (this.initialized) return 1;
    const have = this.seedGains.length + (this.prevClose !== null ? 1 : 0);
    return Math.min(have / (this.period + 1), 1);
  }

  getState(): RSIState {
    return {
      period: this.period,
      rsi: this.rsi,
      priceCount: this.initialized ? this.period + 1 : this.seedGains.length,
      initialized: this.initialized,
    };
  }

  reset(): void {
    this.prevClose = null;
    this.avgGain = null;
    this.avgLoss = null;
    this.seedGains = [];
    this.seedLosses = [];
    this.rsi = null;
    this.initialized = false;
  }
}

export type RsiSignalType =
  | 'overboughtCross'   // crossed back below overbought → bearish
  | 'oversoldCross'     // crossed back above oversold → bullish
  | 'thresholdBreach'   // entered overbought zone (bearish warn) or oversold zone (bullish warn)
  | 'centerlineCross';  // crossed above 50 (bullish) or below 50 (bearish)

export interface RsiSignalResult {
  symbol: string;
  signalType: RsiSignalType;
  direction: 'bullish' | 'bearish';
  rsiValue: number;
  previousRsi: number;
  price: number;
  timestamp: string;
}

export interface RsiSignalConfig {
  overbought: number;
  oversold: number;
  overboughtCross: boolean;
  oversoldCross: boolean;
  thresholdBreach: boolean;
  centerlineCross: boolean;
}

export class RSISignalDetector {
  private cfg: RsiSignalConfig;
  private prevRsi: number | null = null;
  private inOverboughtZone = false;
  private inOversoldZone = false;

  constructor(cfg: RsiSignalConfig) {
    if (cfg.overbought <= 50 || cfg.overbought > 100) {
      throw new Error(`RSISignalDetector: overbought must be in (50, 100] (got ${cfg.overbought})`);
    }
    if (cfg.oversold >= 50 || cfg.oversold < 0) {
      throw new Error(`RSISignalDetector: oversold must be in [0, 50) (got ${cfg.oversold})`);
    }
    this.cfg = cfg;
  }

  /**
   * Initialise zone state from a known RSI value WITHOUT firing alerts.
   * Used during warmup so the first live candle doesn't produce a false
   * thresholdBreach if RSI was already inside a zone.
   */
  initFromValue(rsi: number): void {
    this.prevRsi = rsi;
    this.inOverboughtZone = rsi >= this.cfg.overbought;
    this.inOversoldZone = rsi <= this.cfg.oversold;
  }

  /**
   * Feed a new RSI value and return any signals fired.
   * Returns an array because a single candle can trigger more than one
   * configured signal (e.g. a strong move can cross both overbought and 50).
   */
  check(
    rsi: number,
    price: number,
    symbol: string,
    candleTimestamp?: string,
  ): RsiSignalResult[] {
    const signals: RsiSignalResult[] = [];
    if (!Number.isFinite(rsi)) return signals;

    const prev = this.prevRsi;
    const ts = candleTimestamp || new Date().toISOString();

    if (prev !== null) {
      // overboughtCross: was >= overbought, now < overbought → bearish
      if (this.cfg.overboughtCross && prev >= this.cfg.overbought && rsi < this.cfg.overbought) {
        signals.push({
          symbol, signalType: 'overboughtCross', direction: 'bearish',
          rsiValue: rsi, previousRsi: prev, price, timestamp: ts,
        });
      }

      // oversoldCross: was <= oversold, now > oversold → bullish
      if (this.cfg.oversoldCross && prev <= this.cfg.oversold && rsi > this.cfg.oversold) {
        signals.push({
          symbol, signalType: 'oversoldCross', direction: 'bullish',
          rsiValue: rsi, previousRsi: prev, price, timestamp: ts,
        });
      }

      // centerlineCross: crossed 50 in either direction
      if (this.cfg.centerlineCross) {
        if (prev < 50 && rsi >= 50) {
          signals.push({
            symbol, signalType: 'centerlineCross', direction: 'bullish',
            rsiValue: rsi, previousRsi: prev, price, timestamp: ts,
          });
        } else if (prev >= 50 && rsi < 50) {
          signals.push({
            symbol, signalType: 'centerlineCross', direction: 'bearish',
            rsiValue: rsi, previousRsi: prev, price, timestamp: ts,
          });
        }
      }

      // thresholdBreach: ENTERS overbought zone (bearish warn) or oversold zone (bullish warn).
      // Edge-triggered using the in-zone flag so we only fire on entry, not on every
      // candle that stays in the zone.
      if (this.cfg.thresholdBreach) {
        const nowInOver = rsi >= this.cfg.overbought;
        const nowInUnder = rsi <= this.cfg.oversold;

        if (nowInOver && !this.inOverboughtZone) {
          signals.push({
            symbol, signalType: 'thresholdBreach', direction: 'bearish',
            rsiValue: rsi, previousRsi: prev, price, timestamp: ts,
          });
        }
        if (nowInUnder && !this.inOversoldZone) {
          signals.push({
            symbol, signalType: 'thresholdBreach', direction: 'bullish',
            rsiValue: rsi, previousRsi: prev, price, timestamp: ts,
          });
        }
      }
    }

    this.inOverboughtZone = rsi >= this.cfg.overbought;
    this.inOversoldZone = rsi <= this.cfg.oversold;
    this.prevRsi = rsi;

    return signals;
  }

  getCurrentRsi(): number | null {
    return this.prevRsi;
  }

  reset(): void {
    this.prevRsi = null;
    this.inOverboughtZone = false;
    this.inOversoldZone = false;
  }
}
