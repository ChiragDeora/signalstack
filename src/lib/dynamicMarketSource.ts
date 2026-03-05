// ============================================
// Market Data Source — Angel One only
// ============================================

import { PriceData, SearchResult } from './types';
import { AngelOneDataSource, getAngelOneSource } from './angelOneSource';

export class UniversalMarketDataSource {
  private angelSource: AngelOneDataSource;

  constructor(
    _alphaVantageApiKey?: string,
    _finnhubApiKey?: string,
    _breezeSource?: unknown,
    _dhanSource?: unknown,
    angelSource?: AngelOneDataSource,
  ) {
    this.angelSource = angelSource || getAngelOneSource();
  }

  async fetchTimeframeData(symbol: string, timeframe: string): Promise<PriceData | null> {
    try {
      console.log(`🔍 Fetching ${symbol} (${timeframe}) via Angel One`);

      if (!this.angelSource.isAvailable()) {
        console.error('❌ Angel One credentials not configured');
        return null;
      }

      const data = await this.angelSource.fetchTimeframeData(symbol, timeframe);
      if (data) {
        console.log(`✅ Angel One: ${symbol} = ${data.price}`);
        return data;
      }

      console.error(`❌ Angel One returned no data for ${symbol}`);
      return null;
    } catch (error) {
      console.error(`❌ Error fetching ${symbol}:`, error);
      return null;
    }
  }

  async searchSymbols(query: string): Promise<SearchResult[]> {
    try {
      if (!this.angelSource.isAvailable()) return [];
      return await this.angelSource.searchSymbols(query);
    } catch (error) {
      console.error('Symbol search error:', error);
      return [];
    }
  }

  getAvailableSources(): string[] {
    return this.angelSource.isAvailable() ? ['Angel One'] : [];
  }
}
