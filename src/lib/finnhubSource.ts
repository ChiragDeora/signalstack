import axios from 'axios';

export interface TimeframeData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FinnhubPriceData {
  symbol: string;
  price: number;
  source: string;
  currency: string;
  change: number;
  changePercent: number;
  volume: number;
  timestamp: string;
  timeframe: string;
  candleData?: TimeframeData[];
  market: {
    name: string;
    exchange: string;
    timezone: string;
    currency: string;
    country: string;
    openTime: string;
    closeTime: string;
  };
}

interface MarketInfo {
  name: string;
  exchange: string;
  timezone: string;
  currency: string;
  country: string;
  openTime: string;
  closeTime: string;
}

interface SearchResult {
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
  country: string;
  type: string;
}

export class FinnhubDataSource {
  private apiKey: string;
  private markets: { [key: string]: MarketInfo } = {
    'NASDAQ': {
      name: 'NASDAQ Stock Market',
      exchange: 'NASDAQ',
      timezone: 'America/New_York',
      currency: 'USD',
      country: 'United States',
      openTime: '09:30',
      closeTime: '16:00'
    },
    'NYSE': {
      name: 'New York Stock Exchange',
      exchange: 'NYSE',
      timezone: 'America/New_York',
      currency: 'USD',
      country: 'United States',
      openTime: '09:30',
      closeTime: '16:00'
    },
    'NSE': {
      name: 'National Stock Exchange',
      exchange: 'NSE',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
      country: 'India',
      openTime: '09:15',
      closeTime: '15:30'
    }
  };

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  detectMarketFromSymbol(symbol: string): { exchange: string; currency: string; country: string } {
    const cleanSymbol = symbol.toUpperCase().trim();
    
    if (cleanSymbol.includes('.NS') || cleanSymbol.includes('.BO')) {
      return {
        exchange: cleanSymbol.includes('.NS') ? 'NSE' : 'BSE',
        currency: 'INR',
        country: 'India'
      };
    }
    
    if (cleanSymbol.includes('.L')) {
      return {
        exchange: 'LSE',
        currency: 'GBP',
        country: 'United Kingdom'
      };
    }
    
    // Default to US market
    return {
      exchange: 'NASDAQ',
      currency: 'USD',
      country: 'United States'
    };
  }

  async fetchTimeframeData(symbol: string, timeframe: string): Promise<FinnhubPriceData | null> {
    try {
      const marketInfo = this.detectMarketFromSymbol(symbol);
      const cleanSymbol = symbol.toUpperCase().trim();
      
      console.log(`🔍 Fetching ${symbol} from Finnhub for ${timeframe} timeframe...`);
      
      // First, try to get real-time quote for current price
      let currentPrice = 0;
      let change = 0;
      let changePercent = 0;
      
      try {
        const quoteResponse = await axios.get(
          `https://finnhub.io/api/v1/quote`,
          {
            params: {
              symbol: cleanSymbol,
              token: this.apiKey
            },
            timeout: 5000
          }
        );
        
        if (quoteResponse.data.c && quoteResponse.data.pc) {
          currentPrice = quoteResponse.data.c;
          change = currentPrice - quoteResponse.data.pc;
          changePercent = (change / quoteResponse.data.pc) * 100;
        }
      } catch (quoteError) {
        console.warn(`⚠️ Quote fetch failed for ${symbol}, will use candle data`);
      }
      
      // Get current timestamp and calculate the start time based on timeframe
      const endTime = Math.floor(Date.now() / 1000);
      const startTime = this.calculateStartTime(endTime, timeframe);
      
      // Fetch candle data from Finnhub
      console.log(`🔍 Finnhub request params:`, {
        symbol: cleanSymbol,
        resolution: this.getFinnhubResolution(timeframe),
        from: startTime,
        to: endTime,
        token: this.apiKey ? `${this.apiKey.substring(0, 8)}...` : 'NOT_SET'
      });
      
      const candleResponse = await axios.get(
        `https://finnhub.io/api/v1/stock/candle`,
        {
          params: {
            symbol: cleanSymbol,
            resolution: this.getFinnhubResolution(timeframe),
            from: startTime,
            to: endTime,
            token: this.apiKey
          },
          timeout: 10000
        }
      );
      
      console.log(`🔍 Finnhub response status: ${candleResponse.status}`);
      console.log(`🔍 Finnhub response data:`, candleResponse.data);
      
      if (candleResponse.data.s !== 'ok') {
        throw new Error(`Finnhub error: ${candleResponse.data.s}`);
      }
      
      const candleData = candleResponse.data;
      if (!candleData.t || candleData.t.length === 0) {
        throw new Error('No candle data available');
      }
      
      // Get the latest candle data
      const latestIndex = candleData.t.length - 1;
      const candleCurrentPrice = candleData.c[latestIndex];
      const previousClose = latestIndex > 0 ? candleData.c[latestIndex - 1] : candleData.o[latestIndex];
      const candleChange = candleCurrentPrice - previousClose;
      const candleChangePercent = (candleChange / previousClose) * 100;
      
      // Use quote data if available, otherwise use candle data
      const finalPrice = currentPrice > 0 ? currentPrice : candleCurrentPrice;
      const finalChange = change !== 0 ? change : candleChange;
      const finalChangePercent = changePercent !== 0 ? changePercent : candleChangePercent;
      
      // Build candle data array
      const timeframeData: TimeframeData[] = candleData.t.map((timestamp: number, index: number) => ({
        timestamp: timestamp * 1000, // Convert to milliseconds
        open: candleData.o[index],
        high: candleData.h[index],
        low: candleData.l[index],
        close: candleData.c[index],
        volume: candleData.v[index]
      }));
      
      return {
        symbol,
        price: parseFloat(finalPrice.toFixed(4)),
        source: `Finnhub (${timeframe})`,
        currency: marketInfo.currency,
        change: parseFloat(finalChange.toFixed(4)),
        changePercent: parseFloat(finalChangePercent.toFixed(2)),
        volume: candleData.v[latestIndex],
        timestamp: new Date().toISOString(),
        timeframe,
        candleData: timeframeData,
        market: {
          name: this.getExchangeName(marketInfo.exchange),
          exchange: marketInfo.exchange,
          timezone: this.getTimezone(marketInfo.exchange),
          currency: marketInfo.currency,
          country: marketInfo.country,
          openTime: this.getMarketHours(marketInfo.exchange).open,
          closeTime: this.getMarketHours(marketInfo.exchange).close
        }
      };
      
    } catch (error: any) {
      if (error.response) {
        console.error(`❌ Finnhub API error for ${symbol}:`, {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data
        });
        
        if (error.response.status === 403) {
          console.error(`❌ Finnhub 403 Forbidden - Check your API key`);
        }
      } else {
        console.error(`❌ Error fetching ${symbol} from Finnhub:`, error);
      }
      return null;
    }
  }

  private calculateStartTime(endTime: number, timeframe: string): number {
    const now = new Date(endTime * 1000);
    const timeframes: { [key: string]: number } = {
      '1m': 60,
      '5m': 5 * 60,
      '15m': 15 * 60,
      '30m': 30 * 60,
      '1h': 60 * 60,
      '4h': 4 * 60 * 60,
      '1d': 24 * 60 * 60,
      '1w': 7 * 24 * 60 * 60,
      '1M': 30 * 24 * 60 * 60
    };
    
    const seconds = timeframes[timeframe] || 60 * 60; // Default to 1 hour
    return endTime - seconds;
  }

  private getFinnhubResolution(timeframe: string): string {
    const resolutionMap: { [key: string]: string } = {
      '1m': '1',
      '5m': '5',
      '15m': '15',
      '30m': '30',
      '1h': '60',
      '4h': '60', // Finnhub doesn't support 4h, using 1h
      '1d': 'D',
      '1w': 'W',
      '1M': 'M'
    };
    
    return resolutionMap[timeframe] || '60';
  }

  private getExchangeName(exchange: string): string {
    const names: { [key: string]: string } = {
      'NASDAQ': 'NASDAQ Stock Market',
      'NYSE': 'New York Stock Exchange',
      'NSE': 'National Stock Exchange of India',
      'BSE': 'Bombay Stock Exchange',
      'LSE': 'London Stock Exchange'
    };
    return names[exchange] || exchange;
  }

  private getTimezone(exchange: string): string {
    const timezones: { [key: string]: string } = {
      'NASDAQ': 'America/New_York',
      'NYSE': 'America/New_York',
      'NSE': 'Asia/Kolkata',
      'BSE': 'Asia/Kolkata',
      'LSE': 'Europe/London'
    };
    return timezones[exchange] || 'UTC';
  }

  private getMarketHours(exchange: string): { open: string; close: string } {
    const hours: { [key: string]: { open: string; close: string } } = {
      'NASDAQ': { open: '09:30', close: '16:00' },
      'NYSE': { open: '09:30', close: '16:00' },
      'NSE': { open: '09:15', close: '15:30' },
      'BSE': { open: '09:15', close: '15:30' },
      'LSE': { open: '08:00', close: '16:30' }
    };
    return hours[exchange] || { open: '09:30', close: '16:00' };
  }

  async searchSymbols(query: string): Promise<SearchResult[]> {
    try {
      console.log(`🔍 Searching symbols on Finnhub for: ${query}`);
      
      const response = await axios.get(
        `https://finnhub.io/api/v1/search`,
        {
          params: {
            q: query,
            token: this.apiKey
          },
          timeout: 10000
        }
      );
      
      if (!response.data.result) {
        return [];
      }
      
      // Filter and map results to ensure we have valid data
      const results = response.data.result
        .filter((item: any) => item.symbol && item.symbol.trim() !== '')
        .map((item: any) => ({
          symbol: item.symbol.toUpperCase(),
          name: item.description || item.symbol,
          exchange: item.primaryExchange || this.detectMarketFromSymbol(item.symbol).exchange,
          currency: item.currency || this.detectMarketFromSymbol(item.symbol).currency,
          country: item.country || this.detectMarketFromSymbol(item.symbol).country,
          type: item.type || 'Stock'
        }))
        .slice(0, 20); // Limit to top 20 results
      
      // If no results from search, try to get company profile for the exact symbol
      if (results.length === 0 && query.trim().length > 0) {
        try {
          const profileResponse = await axios.get(
            `https://finnhub.io/api/v1/stock/profile2`,
            {
              params: {
                symbol: query.toUpperCase(),
                token: this.apiKey
              },
              timeout: 5000
            }
          );
          
          if (profileResponse.data && profileResponse.data.name) {
            const marketInfo = this.detectMarketFromSymbol(query);
            results.push({
              symbol: query.toUpperCase(),
              name: profileResponse.data.name,
              exchange: profileResponse.data.exchange || marketInfo.exchange,
              currency: profileResponse.data.currency || marketInfo.currency,
              country: profileResponse.data.country || marketInfo.country,
              type: 'Stock'
            });
          }
        } catch (profileError) {
          console.warn(`⚠️ Company profile fetch failed for ${query}`);
        }
      }
      
      return results;
      
    } catch (error) {
      console.error('❌ Error searching symbols on Finnhub:', error);
      return [];
    }
  }
} 