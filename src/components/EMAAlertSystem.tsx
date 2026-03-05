'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Bell, Plus, TrendingUp, TrendingDown,
  Target, Search, Trash2, BarChart3, Zap,
  ArrowRight, Activity, Power, Wifi, WifiOff,
} from 'lucide-react';
import axios from 'axios';
import { io, Socket } from 'socket.io-client';

// ===================================
// TYPES
// ===================================
interface EMA {
  id: number;
  period: number;
  color: string;
}

interface AlertData {
  id: string;
  symbol: string;
  timeframe: string;
  fastPeriod: number;
  slowPeriod: number;
  fastEmaValue: number;
  slowEmaValue: number;
  crossoverType: 'bullish' | 'bearish';
  price: number;
  currency: string;
  timestamp: string;
  source: string;
}

interface SearchResult {
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
  type: string;
}

const TIMEFRAMES = [
  { id: '1m', label: '1 Min' },
  { id: '5m', label: '5 Min' },
  { id: '15m', label: '15 Min' },
  { id: '30m', label: '30 Min' },
  { id: '1h', label: '1 Hour' },
  { id: '4h', label: '4 Hour' },
  { id: '1d', label: '1 Day' },
];

const COLORS = [
  '#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#f97316', '#84cc16', '#ec4899', '#6366f1',
];

export default function EMAAlertSystem() {
  // Socket
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);

  // Symbol & price
  const [symbol, setSymbol] = useState('');
  const [timeframe, setTimeframe] = useState('5m');
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [priceChange, setPriceChange] = useState(0);
  const [priceChangePercent, setPriceChangePercent] = useState(0);
  const [currency, setCurrency] = useState('INR');
  const [priceSource, setPriceSource] = useState('');
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [showSearch, setShowSearch] = useState(false);
  const [isSearching, setIsSearching] = useState(false);

  // EMAs
  const [emas, setEmas] = useState<EMA[]>([]);
  const [showAddEma, setShowAddEma] = useState(false);
  const [newEmaPeriod, setNewEmaPeriod] = useState('');
  const [emaValues, setEmaValues] = useState<Record<number, number | null>>({});
  const [warmupProgress, setWarmupProgress] = useState<Record<number, number>>({});

  // Monitoring
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [monitorStatus, setMonitorStatus] = useState('');
  const [trackBullish, setTrackBullish] = useState(true);
  const [trackBearish, setTrackBearish] = useState(true);

  // Alerts
  const [alerts, setAlerts] = useState<AlertData[]>([]);

  // Push notifications
  const [pushEnabled, setPushEnabled] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // ===================================
  // SOCKET.IO CONNECTION
  // ===================================
  useEffect(() => {
    const socket = io(window.location.origin, { transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('price:update', (data: any) => {
      setCurrentPrice(data.price);
      setPriceChange(data.change || 0);
      setPriceChangePercent(data.changePercent || 0);
      if (data.currency) setCurrency(data.currency);
      if (data.source) setPriceSource(data.source);
      setLastUpdate(new Date());
    });

    socket.on('ema:update', (data: any) => {
      setEmaValues(data.emas || {});
      setWarmupProgress(data.warmupProgress || {});
    });

    socket.on('alert:crossover', (alert: AlertData) => {
      setAlerts((prev) => [alert, ...prev].slice(0, 100));

      // Browser notification
      if ('Notification' in window && Notification.permission === 'granted') {
        const emoji = alert.crossoverType === 'bullish' ? '📈' : '📉';
        new Notification(`${emoji} ${alert.symbol} EMA Alert`, {
          body: `${alert.crossoverType.toUpperCase()}: EMA(${alert.fastPeriod}) crossed ${alert.crossoverType === 'bullish' ? 'above' : 'below'} EMA(${alert.slowPeriod}) at ${getCurrencySymbol(alert.currency)}${alert.price}`,
          icon: '/signalstack-logo.png',
          tag: `alert-${alert.id}`,
        });
      }
    });

    socket.on('monitor:status', (data: any) => {
      setMonitorStatus(data.message || data.status || '');
      if (data.status === 'stopped') setIsMonitoring(false);
      if (data.status === 'running') setIsMonitoring(true);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  // Request notification permission on mount
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  // ===================================
  // HELPERS
  // ===================================
  const getCurrencySymbol = (c: string) => {
    const symbols: Record<string, string> = { USD: '$', INR: '₹', GBP: '£', JPY: '¥', EUR: '€' };
    return symbols[c] || c;
  };

  // ===================================
  // SEARCH
  // ===================================
  const searchStocks = useCallback(async (query: string) => {
    if (!query || query.length < 1) {
      setSearchResults([]);
      setShowSearch(false);
      return;
    }
    setIsSearching(true);
    try {
      const res = await axios.post('/api/search-symbols', { query });
      if (res.data.success) {
        setSearchResults(res.data.results);
        setShowSearch(true);
      }
    } catch {
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  }, []);

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedSearch = useCallback((query: string) => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (!query) {
      setSearchResults([]);
      setShowSearch(false);
      return;
    }
    searchDebounceRef.current = setTimeout(() => searchStocks(query), 400);
  }, [searchStocks]);

  const selectSymbol = async (result: SearchResult) => {
    setSymbol(result.symbol);
    setSearchQuery(result.symbol);
    setCurrency(result.currency || 'INR');
    setShowSearch(false);

    // Fetch initial price
    try {
      const res = await axios.post('/api/fetch-price', {
        symbol: result.symbol,
        timeframe,
      });
      if (res.data.success && res.data.data) {
        setCurrentPrice(res.data.data.price);
        setPriceChange(res.data.data.change || 0);
        setPriceChangePercent(res.data.data.changePercent || 0);
        setPriceSource(res.data.data.source || '');
        setLastUpdate(new Date());
      }
    } catch {
      // ignore
    }
  };

  // ===================================
  // EMA MANAGEMENT
  // ===================================
  const addEma = (period?: number) => {
    const p = period || parseInt(newEmaPeriod);
    if (!p || p <= 0) return;
    if (emas.find((e) => e.period === p)) return;

    setEmas([...emas, { id: Date.now(), period: p, color: COLORS[emas.length % COLORS.length] }]);
    setNewEmaPeriod('');
    setShowAddEma(false);
  };

  const removeEma = (id: number) => setEmas(emas.filter((e) => e.id !== id));

  // ===================================
  // MONITORING
  // ===================================
  const startMonitoring = async () => {
    if (!symbol || emas.length < 2) {
      alert('Select a symbol and add at least 2 EMAs');
      return;
    }

    try {
      setMonitorStatus('Starting...');
      const res = await axios.post('/api/monitor', {
        symbol,
        timeframe,
        emaPeriods: emas.map((e) => e.period),
        trackBullish,
        trackBearish,
        exchange: 'NSE',
        currency,
      });
      if (res.data.success) {
        setIsMonitoring(true);
      } else {
        setMonitorStatus(res.data.message || 'Failed');
      }
    } catch (err: any) {
      setMonitorStatus('Error starting monitoring');
      console.error(err);
    }
  };

  const stopMonitoring = async () => {
    try {
      await axios.delete('/api/monitor', { data: { symbol, timeframe } });
      setIsMonitoring(false);
      setMonitorStatus('');
      setEmaValues({});
      setWarmupProgress({});
    } catch {
      // ignore
    }
  };

  // ===================================
  // PUSH NOTIFICATIONS
  // ===================================
  const enablePush = async () => {
    try {
      if (!('serviceWorker' in navigator)) return;
      const registration = await navigator.serviceWorker.ready;
      const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!vapidKey) {
        console.warn('VAPID public key not set');
        return;
      }
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKey,
      });
      await axios.post('/api/push-subscribe', subscription.toJSON());
      setPushEnabled(true);
    } catch (err) {
      console.error('Push subscription failed:', err);
    }
  };

  // ===================================
  // CROSSOVER PAIRS
  // ===================================
  const getCrossoverPairs = (): [EMA, EMA][] => {
    const pairs: [EMA, EMA][] = [];
    const sorted = [...emas].sort((a, b) => a.period - b.period);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        pairs.push([sorted[i], sorted[j]]);
      }
    }
    return pairs;
  };

  // ===================================
  // RENDER
  // ===================================
  return (
    <div className="min-h-screen bg-gray-900 text-white p-4 sm:p-6">
      <div className="max-w-7xl mx-auto">

        {/* Header */}
        <header className="flex items-center justify-between mb-6">
          <div className="flex items-center space-x-3">
            <div className="bg-gradient-to-r from-blue-600 to-purple-600 p-2.5 rounded-xl">
              <img src="/signalstack-logo.png" alt="Logo" className="w-7 h-7" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">SignalStack</h1>
              <p className="text-gray-400 text-xs">EMA Crossover Alerts</p>
            </div>
          </div>
          <div className="flex items-center space-x-3">
            <div className={`flex items-center space-x-1.5 text-xs px-3 py-1.5 rounded-full ${connected ? 'bg-green-900/50 text-green-400' : 'bg-red-900/50 text-red-400'}`}>
              {connected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
              <span>{connected ? 'Live' : 'Offline'}</span>
            </div>
            {mounted && !pushEnabled && 'serviceWorker' in navigator && (
              <button
                onClick={enablePush}
                className="bg-gray-700 hover:bg-gray-600 text-xs px-3 py-1.5 rounded-full flex items-center space-x-1.5 transition-colors"
              >
                <Bell className="w-3 h-3" />
                <span>Enable Push</span>
              </button>
            )}
          </div>
        </header>

        {/* Monitoring Banner */}
        {isMonitoring && (
          <div className="bg-gradient-to-r from-green-900/40 to-emerald-900/40 border border-green-700/50 rounded-xl p-3 mb-6 flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="relative">
                <Activity className="w-5 h-5 text-green-400" />
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-green-400 rounded-full animate-ping" />
              </div>
              <div>
                <span className="font-semibold text-green-300">{symbol}</span>
                <span className="text-green-400/70 text-sm ml-2">({timeframe}) — {monitorStatus || 'Monitoring active'}</span>
              </div>
            </div>
            <button
              onClick={stopMonitoring}
              className="bg-red-600/20 hover:bg-red-600/40 text-red-400 px-3 py-1.5 rounded-lg text-sm flex items-center space-x-1.5 transition-colors"
            >
              <Power className="w-4 h-4" />
              <span>Stop</span>
            </button>
          </div>
        )}

        {/* Main Grid */}
        <main className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* Left Column: Controls */}
          <div className="lg:col-span-1 space-y-6">

            {/* Symbol Search + Price */}
            <div className="bg-gray-800 rounded-2xl p-5">
              <h2 className="text-lg font-semibold mb-3 flex items-center">
                <Search className="w-5 h-5 mr-2 text-blue-400" />
                Symbol & Timeframe
              </h2>

              <div className="relative mb-3">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    debouncedSearch(e.target.value);
                  }}
                  onFocus={() => searchResults.length > 0 && setShowSearch(true)}
                  className="w-full bg-gray-700 border-2 border-gray-600 focus:border-blue-500 rounded-lg px-4 py-2.5 text-white placeholder-gray-400 text-lg font-semibold transition-colors"
                  placeholder="Search symbol (e.g. RELIANCE)"
                />
                <Search className={`absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 ${isSearching ? 'animate-spin' : ''}`} />

                {showSearch && searchResults.length > 0 && (
                  <div className="absolute top-full left-0 right-0 bg-gray-800 border-2 border-gray-600 rounded-lg mt-1 max-h-64 overflow-y-auto z-50 shadow-2xl">
                    {searchResults.map((r, i) => (
                      <button
                        key={i}
                        onClick={() => selectSymbol(r)}
                        className="w-full p-3 text-left hover:bg-gray-700 border-b border-gray-700 last:border-b-0 transition-colors"
                      >
                        <div className="flex justify-between items-center">
                          <div>
                            <div className="font-bold text-blue-400">{r.symbol}</div>
                            <div className="text-xs text-gray-300">{r.name}</div>
                          </div>
                          <div className="text-right">
                            <div className="text-xs text-orange-400">{r.exchange}</div>
                            <div className="text-xs text-gray-400">{r.currency}</div>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Timeframe selector */}
              <div className="flex flex-wrap gap-1.5 mb-4">
                {TIMEFRAMES.map((tf) => (
                  <button
                    key={tf.id}
                    onClick={() => setTimeframe(tf.id)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${timeframe === tf.id ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}`}
                  >
                    {tf.label}
                  </button>
                ))}
              </div>

              {/* Price display */}
              {symbol && (
                <div className="bg-gray-900 rounded-xl p-4 text-center">
                  <div className="text-3xl font-bold tracking-wide">
                    {currentPrice !== null ? `${getCurrencySymbol(currency)}${currentPrice.toFixed(2)}` : '—'}
                  </div>
                  {currentPrice !== null && (
                    <>
                      <div className={`flex items-center justify-center space-x-2 mt-1 text-sm ${priceChangePercent >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        <span>{priceChange >= 0 ? '+' : ''}{priceChange.toFixed(2)}</span>
                        <span>({priceChangePercent >= 0 ? '+' : ''}{priceChangePercent.toFixed(2)}%)</span>
                      </div>
                      <div className="text-xs text-gray-500 mt-1">
                        {priceSource && <span>{priceSource} · </span>}
                        {lastUpdate && <span>{lastUpdate.toLocaleTimeString()}</span>}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* EMA Configuration */}
            <div className="bg-gray-800 rounded-2xl p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-lg font-semibold flex items-center">
                  <BarChart3 className="w-5 h-5 mr-2 text-blue-400" />
                  EMAs
                </h3>
                <span className="bg-blue-600 text-white px-2.5 py-0.5 rounded-full text-xs font-bold">{emas.length}</span>
              </div>

              <div className="space-y-2 mb-3">
                {emas.length === 0 ? (
                  <div className="text-center py-6 text-gray-500 text-sm">
                    <BarChart3 className="w-10 h-10 mx-auto mb-2 opacity-40" />
                    <p>Add at least 2 EMAs to start monitoring</p>
                  </div>
                ) : (
                  emas.map((ema) => (
                    <div
                      key={ema.id}
                      className="bg-gray-700 px-3 py-2 rounded-lg border-l-4 flex items-center justify-between"
                      style={{ borderLeftColor: ema.color }}
                    >
                      <div className="flex items-center space-x-3">
                        <span className="font-bold text-sm">EMA({ema.period})</span>
                        {emaValues[ema.period] !== undefined && emaValues[ema.period] !== null && (
                          <span className="text-xs text-gray-400">= {emaValues[ema.period]!.toFixed(2)}</span>
                        )}
                        {warmupProgress[ema.period] !== undefined && warmupProgress[ema.period] < 1 && (
                          <div className="flex items-center space-x-1">
                            <div className="w-16 h-1.5 bg-gray-600 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-blue-500 rounded-full transition-all"
                                style={{ width: `${warmupProgress[ema.period] * 100}%` }}
                              />
                            </div>
                            <span className="text-xs text-gray-500">{Math.round(warmupProgress[ema.period] * 100)}%</span>
                          </div>
                        )}
                      </div>
                      <button onClick={() => removeEma(ema.id)} className="text-gray-400 hover:text-red-400 transition-colors">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))
                )}
              </div>

              {/* Quick add */}
              <div className="grid grid-cols-5 gap-1.5 mb-2">
                {[9, 21, 50, 100, 200].map((p) => (
                  <button
                    key={p}
                    onClick={() => addEma(p)}
                    disabled={!!emas.find((e) => e.period === p)}
                    className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 py-1.5 rounded-lg text-xs font-bold transition-colors"
                  >
                    {p}
                  </button>
                ))}
              </div>

              <button
                onClick={() => setShowAddEma(!showAddEma)}
                className="w-full bg-gray-700 hover:bg-gray-600 py-2 rounded-lg text-sm flex items-center justify-center space-x-1.5 transition-colors"
              >
                <Plus className="w-4 h-4" />
                <span>Custom Period</span>
              </button>
              {showAddEma && (
                <div className="mt-2 flex space-x-2">
                  <input
                    type="number"
                    value={newEmaPeriod}
                    onChange={(e) => setNewEmaPeriod(e.target.value)}
                    className="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-sm"
                    placeholder="e.g. 55"
                    min="1"
                  />
                  <button
                    onClick={() => addEma()}
                    disabled={!newEmaPeriod || parseInt(newEmaPeriod) <= 0}
                    className="bg-blue-600 hover:bg-blue-700 px-4 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50"
                  >
                    Add
                  </button>
                </div>
              )}

              {/* Crossover type toggles */}
              <div className="flex space-x-2 mt-3">
                <button
                  onClick={() => setTrackBullish(!trackBullish)}
                  className={`flex-1 py-2 rounded-lg text-xs font-medium flex items-center justify-center space-x-1.5 transition-colors ${trackBullish ? 'bg-green-600/30 text-green-400 border border-green-600/50' : 'bg-gray-700 text-gray-400'}`}
                >
                  <TrendingUp className="w-3.5 h-3.5" />
                  <span>Bullish</span>
                </button>
                <button
                  onClick={() => setTrackBearish(!trackBearish)}
                  className={`flex-1 py-2 rounded-lg text-xs font-medium flex items-center justify-center space-x-1.5 transition-colors ${trackBearish ? 'bg-red-600/30 text-red-400 border border-red-600/50' : 'bg-gray-700 text-gray-400'}`}
                >
                  <TrendingDown className="w-3.5 h-3.5" />
                  <span>Bearish</span>
                </button>
              </div>

              {/* Start/Stop */}
              <button
                onClick={isMonitoring ? stopMonitoring : startMonitoring}
                disabled={!symbol || emas.length < 2}
                className={`w-full mt-4 py-3 rounded-xl text-sm font-bold flex items-center justify-center space-x-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  isMonitoring
                    ? 'bg-red-600 hover:bg-red-700 text-white'
                    : 'bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700 text-white'
                }`}
              >
                {isMonitoring ? (
                  <>
                    <Power className="w-5 h-5" />
                    <span>Stop Monitoring</span>
                  </>
                ) : (
                  <>
                    <Zap className="w-5 h-5" />
                    <span>Start Monitoring</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Right Column */}
          <div className="lg:col-span-2 space-y-6">

            {/* Crossover Pairs */}
            <div className="bg-gray-800 rounded-2xl p-5">
              <h3 className="text-lg font-semibold mb-3 flex items-center">
                <Target className="w-5 h-5 mr-2 text-purple-400" />
                Crossover Pairs
                <span className="bg-purple-600 text-white px-2.5 py-0.5 rounded-full text-xs font-bold ml-auto">
                  {getCrossoverPairs().length}
                </span>
              </h3>

              {getCrossoverPairs().length === 0 ? (
                <div className="text-center py-8 text-gray-500 text-sm">
                  <Target className="w-10 h-10 mx-auto mb-2 opacity-40" />
                  <p>Add at least 2 EMAs to see crossover pairs</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {getCrossoverPairs().map(([fast, slow], i) => {
                    const fastVal = emaValues[fast.period];
                    const slowVal = emaValues[slow.period];
                    const fastAbove = fastVal != null && slowVal != null ? fastVal > slowVal : null;

                    return (
                      <div key={i} className="bg-gray-700 p-3 rounded-lg">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center space-x-2">
                            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: fast.color }} />
                            <span className="text-sm font-medium">EMA({fast.period})</span>
                            <ArrowRight className="w-3 h-3 text-gray-500" />
                            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: slow.color }} />
                            <span className="text-sm font-medium">EMA({slow.period})</span>
                          </div>
                          {isMonitoring && fastAbove !== null && (
                            <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${fastAbove ? 'bg-green-900/50 text-green-400' : 'bg-red-900/50 text-red-400'}`}>
                              {fastAbove ? 'BULLISH' : 'BEARISH'}
                            </span>
                          )}
                        </div>
                        {isMonitoring && fastVal != null && slowVal != null ? (
                          <div className="flex justify-between text-xs text-gray-400">
                            <span>Fast: {fastVal.toFixed(2)}</span>
                            <span>Slow: {slowVal.toFixed(2)}</span>
                            <span>Diff: {(fastVal - slowVal).toFixed(2)}</span>
                          </div>
                        ) : (
                          <div className="text-xs text-gray-500">
                            {isMonitoring ? 'Warming up...' : 'Start monitoring to see live values'}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Alert History */}
            <div className="bg-gray-800 rounded-2xl p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-lg font-semibold flex items-center">
                  <Bell className="w-5 h-5 mr-2 text-yellow-400" />
                  Alerts
                </h3>
                <span className="bg-yellow-600 text-white px-2.5 py-0.5 rounded-full text-xs font-bold">
                  {alerts.length}
                </span>
              </div>

              <div className="space-y-3 max-h-[500px] overflow-y-auto pr-1">
                {alerts.length === 0 ? (
                  <div className="text-center py-10 text-gray-500 text-sm">
                    <Bell className="w-10 h-10 mx-auto mb-2 opacity-40" />
                    <p>No alerts yet</p>
                    <p className="text-xs mt-1">Crossover alerts will appear here when detected</p>
                  </div>
                ) : (
                  alerts.map((a) => (
                    <div
                      key={a.id}
                      className={`p-3 rounded-lg border-l-4 ${
                        a.crossoverType === 'bullish'
                          ? 'border-green-500 bg-green-500/10'
                          : 'border-red-500 bg-red-500/10'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-3">
                          <div className={`p-1.5 rounded-full ${a.crossoverType === 'bullish' ? 'bg-green-500/20' : 'bg-red-500/20'}`}>
                            {a.crossoverType === 'bullish' ? (
                              <TrendingUp className="w-4 h-4 text-green-400" />
                            ) : (
                              <TrendingDown className="w-4 h-4 text-red-400" />
                            )}
                          </div>
                          <div>
                            <div className="font-bold">{a.symbol}</div>
                            <div className="text-xs text-gray-300">
                              EMA({a.fastPeriod}) {a.crossoverType === 'bullish' ? '↑ above' : '↓ below'} EMA({a.slowPeriod})
                            </div>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-bold">{getCurrencySymbol(a.currency)}{a.price}</div>
                          <div className="text-xs text-gray-400">
                            {new Date(a.timestamp).toLocaleTimeString()} · {a.timeframe}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

          </div>
        </main>
      </div>
    </div>
  );
}
