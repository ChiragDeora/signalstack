// ============================================
// Market Data Source — Dhan HQ only
// ============================================

import { PriceData, SearchResult } from './types';
import { DhanDataSource, getDhanSource } from './dhanSource';

export class UniversalMarketDataSource {
  private dhanSource: DhanDataSource;

  constructor(
    _alphaVantageApiKey?: string,
    _finnhubApiKey?: string,
    _breezeSource?: unknown,
    dhanSource?: DhanDataSource,
  ) {
    this.dhanSource = dhanSource || getDhanSource();
  }

  async fetchTimeframeData(symbol: string, timeframe: string): Promise<PriceData | null> {
    try {
      console.log(`🔍 Fetching ${symbol} (${timeframe}) via Dhan`);

      if (!this.dhanSource.isAvailable()) {
        console.error('❌ Dhan credentials not configured');
        return null;
      }

      const data = await this.dhanSource.fetchTimeframeData(symbol, timeframe);
      if (data) {
        console.log(`✅ Dhan: ${symbol} = ${data.price}`);
        return data;
      }

      console.error(`❌ Dhan returned no data for ${symbol}`);
      return null;
    } catch (error) {
      console.error(`❌ Error fetching ${symbol}:`, error);
      return null;
    }
  }

  async searchSymbols(query: string): Promise<SearchResult[]> {
    try {
      return await this.dhanSource.searchSymbols(query);
    } catch (error) {
      console.error('Symbol search error:', error);
      return [];
    }
  }

  getAvailableSources(): string[] {
    return this.dhanSource.isAvailable() ? ['Dhan HQ'] : [];
  }
}
