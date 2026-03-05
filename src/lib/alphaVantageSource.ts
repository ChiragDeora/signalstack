
import axios from 'axios';

export interface TimeframeData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface AlphaVantagePriceData {
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

interface DetectedMarket {
  exchange: string;
  currency: string;
  country: string;
  alphaVantageSymbol: string;
}

interface SearchResult {
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
  country: string;
  type: string;
}

export class AlphaVantageDataSource {
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

  detectMarketFromSymbol(symbol: string): DetectedMarket {
    const cleanSymbol = symbol.toUpperCase().trim();

    // Alpha Vantage uses .BSE suffix for Indian stocks (not .NS/.BO)
    if (cleanSymbol.includes('.NS') || cleanSymbol.includes('.BO')) {
      const base = cleanSymbol.replace(/\.(NS|BO)$/, '');
      return {
        exchange: cleanSymbol.includes('.NS') ? 'NSE' : 'BSE',
        currency: 'INR',
        country: 'India',
        alphaVantageSymbol: `${base}.BSE`,
      };
    }

    if (cleanSymbol.includes('.BSE')) {
      return {
        exchange: 'BSE',
        currency: 'INR',
        country: 'India',
        alphaVantageSymbol: cleanSymbol,
      };
    }
    
    if (cleanSymbol.includes('.L')) {
      return {
        exchange: 'LSE',
        currency: 'GBP',
        country: 'United Kingdom',
        alphaVantageSymbol: cleanSymbol
      };
    }
    
    // Default to US market
    return {
      exchange: 'NASDAQ',
      currency: 'USD',
      country: 'United States',
      alphaVantageSymbol: cleanSymbol
    };
  }

  async fetchTimeframeData(symbol: string, timeframe: string): Promise<AlphaVantagePriceData | null> {
    try {
      const marketInfo = this.detectMarketFromSymbol(symbol);
      const alphaVantageSymbol = marketInfo.alphaVantageSymbol;
      
      console.log(`🔍 Fetching ${symbol} (${alphaVantageSymbol}) from Alpha Vantage for ${timeframe} timeframe...`);
      
      const { interval, function: avFunction } = this.getAlphaVantageTimeframeParams(timeframe);
      
      const params: Record<string, string> = {
        function: avFunction,
        symbol: alphaVantageSymbol,
        apikey: this.apiKey,
        outputsize: 'full',   // get up to 20 years of data instead of 100 points
      };
      if (avFunction === 'TIME_SERIES_INTRADAY') {
        params.interval = interval;
      }

      const response = await axios.get(
        `https://www.alphavantage.co/query`,
        { params, timeout: 15000 }
      );
      
      const data = response.data;
      const timeSeriesKey = Object.keys(data).find(key => key.includes('Time Series'));
      
      if (!timeSeriesKey || !data[timeSeriesKey]) {
        throw new Error('Invalid data structure from Alpha Vantage');
      }
      
      const timeSeries = data[timeSeriesKey];

      // AV returns newest-first — sort oldest-first for EMA engine
      const candleData: TimeframeData[] = Object.keys(timeSeries)
        .map(timestamp => {
          const entry = timeSeries[timestamp];
          return {
            timestamp: new Date(timestamp).getTime(),
            open: parseFloat(entry['1. open']),
            high: parseFloat(entry['2. high']),
            low: parseFloat(entry['3. low']),
            close: parseFloat(entry['4. close']),
            volume: parseFloat(entry['5. volume']),
          };
        })
        .sort((a, b) => a.timestamp - b.timestamp);

      const latest = candleData[candleData.length - 1];
      const previous = candleData.length > 1 ? candleData[candleData.length - 2] : latest;
      const currentPrice = latest.close;
      const change = currentPrice - previous.close;
      const changePercent = previous.close !== 0 ? (change / previous.close) * 100 : 0;
      
      return {
        symbol,
        price: parseFloat(currentPrice.toFixed(4)),
        source: `Alpha Vantage (${timeframe})`,
        currency: marketInfo.currency,
        change: parseFloat(change.toFixed(4)),
        changePercent: parseFloat(changePercent.toFixed(2)),
        volume: latest.volume,
        timestamp: new Date().toISOString(),
        timeframe,
        candleData,
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
      
    } catch (error) {
      console.error(`❌ Error fetching ${symbol} from Alpha Vantage:`, error);
      return null;
    }
  }

  private getAlphaVantageTimeframeParams(timeframe: string): { interval: string; function: string } {
    // TIME_SERIES_INTRADAY is premium-only on free keys.
    // Free tier supports: TIME_SERIES_DAILY, TIME_SERIES_WEEKLY, TIME_SERIES_MONTHLY.
    // Intraday timeframes fall back to daily so we still get candle history for EMA warmup.
    const timeframeMap: { [key: string]: { interval: string; function: string } } = {
      '1m':  { interval: '', function: 'TIME_SERIES_DAILY' },
      '5m':  { interval: '', function: 'TIME_SERIES_DAILY' },
      '15m': { interval: '', function: 'TIME_SERIES_DAILY' },
      '30m': { interval: '', function: 'TIME_SERIES_DAILY' },
      '1h':  { interval: '', function: 'TIME_SERIES_DAILY' },
      '4h':  { interval: '', function: 'TIME_SERIES_DAILY' },
      '1d':  { interval: '', function: 'TIME_SERIES_DAILY' },
      '1w':  { interval: '', function: 'TIME_SERIES_WEEKLY' },
      '1M':  { interval: '', function: 'TIME_SERIES_MONTHLY' },
    };
    return timeframeMap[timeframe] || { interval: '', function: 'TIME_SERIES_DAILY' };
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
    return hours[exchange] || { open: '09:00', close: '17:00' };
  }

  async searchSymbols(query: string): Promise<SearchResult[]> {
    try {
      console.log(`🔍 Searching Alpha Vantage for symbols matching: ${query}`);
      
      const response = await axios.get(
        `https://www.alphavantage.co/query`,
        {
          params: {
            function: 'SYMBOL_SEARCH',
            keywords: query,
            apikey: this.apiKey
          },
          timeout: 10000
        }
      );
      
      const bestMatches = response.data.bestMatches;
      
      if (!bestMatches) {
        return [];
      }
      
      return bestMatches.map((match: any) => ({
        symbol: match['1. symbol'],
        name: match['2. name'],
        exchange: match['4. region'],
        currency: match['8. currency'],
        country: match['4. region'],
        type: match['3. type']
      }));
      
    } catch (error) {
      console.error('Alpha Vantage symbol search error:', error);
      return [];
    }
  }
}
