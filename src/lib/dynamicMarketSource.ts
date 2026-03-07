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

  async fetchLTP(symbol: string, exchange: 'NSE' | 'NFO' | 'BSE' = 'NSE'): Promise<{ ltp: number; open: number; high: number; low: number; close: number } | null> {
    try {
      if (!this.angelSource.isAvailable()) return null;
      return await this.angelSource.fetchLTP(symbol, exchange);
    } catch {
      return null;
    }
  }

  async fetchTimeframeData(symbol: string, timeframe: string, exchange: 'NSE' | 'NFO' | 'BSE' = 'NSE'): Promise<PriceData | null> {
    try {
      console.log(`🔍 Fetching ${symbol} (${timeframe}) via Angel One [${exchange}]`);

      if (!this.angelSource.isAvailable()) {
        console.error('❌ Angel One credentials not configured');
        return null;
      }

      const data = await this.angelSource.fetchTimeframeData(symbol, timeframe, exchange);
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

  async searchSymbols(query: string, exchangeFilter?: 'ALL' | 'NSE' | 'NFO' | 'BSE'): Promise<SearchResult[]> {
    console.log('[dynamicMarketSource.searchSymbols] query:', JSON.stringify(query), 'exchangeFilter:', exchangeFilter ?? 'ALL');
    try {
      const available = this.angelSource.isAvailable();
      console.log('[dynamicMarketSource.searchSymbols] Angel One available:', available);
      if (!available) {
        console.log('[dynamicMarketSource.searchSymbols] Returning [] (Angel not configured)');
        return [];
      }
      const results = await this.angelSource.searchSymbols(query, exchangeFilter);
      console.log('[dynamicMarketSource.searchSymbols] Angel returned:', results.length, 'results');
      return results;
    } catch (error) {
      console.error('[dynamicMarketSource.searchSymbols] Error:', error);
      return [];
    }
  }

  getAvailableSources(): string[] {
    return this.angelSource.isAvailable() ? ['Angel One'] : [];
  }
}
