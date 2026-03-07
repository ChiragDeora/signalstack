'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Bell, Plus, TrendingUp, TrendingDown,
  Target, Search, Trash2, BarChart3, Zap,
  ArrowRight, Activity, Power, Wifi, WifiOff, RefreshCw, X, Pencil, Check, Mail,
} from 'lucide-react';
import { UserButton, useUser } from '@clerk/nextjs';
import axios from 'axios';
import { io, Socket } from 'socket.io-client';

interface MonitoredWatch {
  symbol: string;
  timeframe: string;
  emaPeriods: number[];
  trackBullish: boolean;
  trackBearish: boolean;
  exchange: string;
  currency: string;
}

// ===================================
// TYPES
// ===================================
interface EMA {
  id: number;
  period: number;
  color: string;
}

interface MonitoredSymbol {
  symbol: string;
  name?: string;
  currency: string;
  exchange?: string; // NSE | NFO | BSE — used for polling/fetch so the correct exchange is queried
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

function watchKey(symbol: string, timeframe: string) {
  return `${symbol.toUpperCase()}:${timeframe}`;
}

const TIMEFRAMES = [
  { id: '1m', label: '1m' },
  { id: '5m', label: '5m' },
  { id: '15m', label: '15m' },
  { id: '30m', label: '30m' },
  { id: '1h', label: '1h' },
  { id: '4h', label: '4h' },
  { id: '1d', label: '1D' },
];

const COLORS = [
  '#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#f97316', '#84cc16', '#ec4899', '#6366f1',
];

const DEFAULT_TIMEFRAME = '5m';

export default function EMAAlertSystem() {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [symbols, setSymbols] = useState<MonitoredSymbol[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [timeframeBySymbol, setTimeframeBySymbol] = useState<Record<string, string>>({});
  const [priceByKey, setPriceByKey] = useState<Record<string, { price: number; change: number; changePercent: number; currency: string; source: string; lastUpdate: Date | null }>>({});
  const [emaByKey, setEmaByKey] = useState<Record<string, Record<number, number | null>>>({});
  const [warmupByKey, setWarmupByKey] = useState<Record<string, Record<number, number>>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchExchangeFilter, setSearchExchangeFilter] = useState<'ALL' | 'NSE' | 'NFO' | 'BSE'>('ALL');
  const [showSearch, setShowSearch] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [emasBySymbol, setEmasBySymbol] = useState<Record<string, EMA[]>>({});
  const [showAddEma, setShowAddEma] = useState(false);
  const [newEmaPeriod, setNewEmaPeriod] = useState('');
  const [monitoredSymbols, setMonitoredSymbols] = useState<Set<string>>(new Set());
  const isMonitoring = monitoredSymbols.size > 0;
  const [monitorStatus, setMonitorStatus] = useState('');
  const [trackBullish, setTrackBullish] = useState(true);
  const [trackBearish, setTrackBearish] = useState(true);
  const [alerts, setAlerts] = useState<AlertData[]>([]);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushAvailable, setPushAvailable] = useState<boolean | null>(null);
  const [mounted, setMounted] = useState(false);
  const [isFetchingPrice, setIsFetchingPrice] = useState(false);
  const [editingPairIndex, setEditingPairIndex] = useState<number | null>(null);
  const [editPairFast, setEditPairFast] = useState<number>(9);
  const [editPairSlow, setEditPairSlow] = useState<number>(21);
  const [showRefreshModal, setShowRefreshModal] = useState(true);
  const [refreshModalMinTimeElapsed, setRefreshModalMinTimeElapsed] = useState(false);
  const [testEmailStatus, setTestEmailStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  const [testEmailMessage, setTestEmailMessage] = useState<string | null>(null);
  const [testPushStatus, setTestPushStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  const [testPushMessage, setTestPushMessage] = useState<string | null>(null);
  const hasRestoredRef = useRef(false);
  const hasRestoredMonitoredRef = useRef(false);
  const { user: clerkUser } = useUser();
  const userId = clerkUser?.id ?? null;

  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);

  const getTimeframe = (sym: string) => timeframeBySymbol[sym] ?? DEFAULT_TIMEFRAME;
  const displaySymbol = selectedSymbol ?? symbols[0]?.symbol ?? null;
  const displayTimeframe = displaySymbol ? getTimeframe(displaySymbol) : DEFAULT_TIMEFRAME;
  const displayPrice = displaySymbol ? priceByKey[watchKey(displaySymbol, displayTimeframe)] : null;
  const displayEmaValues = displaySymbol ? emaByKey[watchKey(displaySymbol, displayTimeframe)] ?? {} : {};
  const displayWarmupProgress = displaySymbol ? warmupByKey[watchKey(displaySymbol, displayTimeframe)] ?? {} : {};
  const _currency = displaySymbol ? (symbols.find((s) => s.symbol === displaySymbol)?.currency ?? 'INR') : 'INR';
  const emas = useMemo(
    () => (displaySymbol ? (emasBySymbol[displaySymbol] ?? []) : []),
    [displaySymbol, emasBySymbol]
  );

  useEffect(() => { setMounted(true); }, []);

  // Refresh modal: show on load, hide when connected and monitoring ready (min 1.5s), or after 4s max
  useEffect(() => {
    const minT = setTimeout(() => setRefreshModalMinTimeElapsed(true), 1500);
    const maxT = setTimeout(() => setShowRefreshModal(false), 4000);
    return () => { clearTimeout(minT); clearTimeout(maxT); };
  }, []);
  useEffect(() => {
    if (refreshModalMinTimeElapsed && connected && monitorStatus === '') {
      setShowRefreshModal(false);
    }
  }, [refreshModalMinTimeElapsed, connected, monitorStatus]);

  // Check if push is configured on this deployment (e.g. Vercel returns 503 without VAPID env)
  useEffect(() => {
    if (!mounted) return;
    axios.get<{ vapidConfigured?: boolean }>('/api/status')
      .then((res) => setPushAvailable(!!res.data?.vapidConfigured))
      .catch(() => setPushAvailable(false));
  }, [mounted]);

  // Restore "Alerts on" if this browser already has a push subscription (e.g. after refresh)
  useEffect(() => {
    if (!mounted || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => sub != null && setPushEnabled(true))
      .catch(() => { /* ignore */ });
  }, [mounted]);

  // Refetch watches from Supabase and set local state (call after start/stop monitor)
  const refetchWatches = useCallback(async () => {
    if (!userId) return;
    try {
      const res = await axios.get<{ success: boolean; watches?: MonitoredWatch[] }>('/api/user/watches');
      if (res.data.success && Array.isArray(res.data.watches)) {
        setMonitoredSymbols(new Set(res.data.watches.map((w) => w.symbol)));
      }
    } catch { /* ignore */ }
  }, [userId]);

  // Restore user config from Supabase once on mount (when signed in)
  useEffect(() => {
    if (!mounted || !userId || hasRestoredRef.current) return;
    axios
      .get<{ success: boolean; config?: { symbols: MonitoredSymbol[]; timeframeBySymbol: Record<string, string>; emasBySymbol: Record<string, EMA[]>; trackBullish: boolean; trackBearish: boolean; selectedSymbol: string | null } }>('/api/user/config')
      .then((res) => {
        if (!res.data.success || !res.data.config) return;
        const c = res.data.config;
        if (c.symbols?.length > 0) {
          setSymbols((c.symbols || []).map((s) => ({ ...s, exchange: s.exchange || 'NSE' })));
          setTimeframeBySymbol(c.timeframeBySymbol || {});
          setEmasBySymbol(c.emasBySymbol || {});
          setTrackBullish(c.trackBullish !== false);
          setTrackBearish(c.trackBearish !== false);
          setSelectedSymbol(c.selectedSymbol ?? c.symbols[0]?.symbol ?? null);
        }
      })
      .catch((err: any) => {
        console.error('[EMAAlertSystem] Load config failed:', err.response?.status, err.response?.data?.error ?? err.message);
      })
      .finally(() => {
        hasRestoredRef.current = true;
      });
  }, [mounted, userId]);

  // Persist config to Supabase when it changes (debounced to avoid excessive writes)
  const configPersistRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!mounted || !userId) return;
    if (!hasRestoredRef.current) return;
    if (configPersistRef.current) clearTimeout(configPersistRef.current);
    configPersistRef.current = setTimeout(() => {
      configPersistRef.current = null;
      axios.put('/api/user/config', {
        symbols,
        timeframeBySymbol,
        emasBySymbol,
        trackBullish,
        trackBearish,
        selectedSymbol,
      }).then(() => {
        if (symbols.length > 0) console.log('[EMAAlertSystem] Config saved to Supabase, symbols:', symbols.length);
      }).catch((err: any) => {
        console.error('[EMAAlertSystem] Config save failed:', err.response?.status, err.response?.data?.error ?? err.message);
      });
    }, 800);
    return () => { if (configPersistRef.current) clearTimeout(configPersistRef.current); };
  }, [mounted, userId, symbols, timeframeBySymbol, emasBySymbol, trackBullish, trackBearish, selectedSymbol]);

  // Restore monitoring from Supabase and re-register with server (survives refresh / server restart)
  useEffect(() => {
    if (!mounted || !userId || hasRestoredMonitoredRef.current) return;
    hasRestoredMonitoredRef.current = true;
    axios
      .get<{ success: boolean; watches?: MonitoredWatch[] }>('/api/user/watches')
      .then(async (res) => {
        const watches = res.data.success && Array.isArray(res.data.watches) ? res.data.watches : [];
        if (watches.length === 0) return;
        setMonitorStatus('Restoring monitoring...');
        const restored: string[] = [];
        for (const w of watches) {
          try {
            const r = await axios.post('/api/monitor', {
              symbol: w.symbol,
              timeframe: w.timeframe,
              emaPeriods: w.emaPeriods,
              trackBullish: w.trackBullish,
              trackBearish: w.trackBearish,
              exchange: w.exchange,
              currency: w.currency,
            });
            if (r.data.success) restored.push(w.symbol);
          } catch { /* skip failed */ }
        }
        if (restored.length > 0) {
          setMonitoredSymbols((prev) => new Set([...prev, ...restored]));
        }
        setMonitorStatus('');
      })
      .catch(() => {});
  }, [mounted, userId]);

  // ===================================
  // SOCKET.IO
  // ===================================
  const pendingPriceRef = useRef<Record<string, { price: number; change: number; changePercent: number; currency: string; source: string; lastUpdate: Date }>>({});
  const pendingEmaRef = useRef<Record<string, { emas: Record<number, number | null>; warmup: Record<number, number> }>>({});
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushSocketUpdates = useCallback(() => {
    if (Object.keys(pendingPriceRef.current).length > 0) {
      const batch = pendingPriceRef.current;
      pendingPriceRef.current = {};
      setPriceByKey((prev) => ({ ...prev, ...batch }));
    }
    if (Object.keys(pendingEmaRef.current).length > 0) {
      const batch = pendingEmaRef.current;
      pendingEmaRef.current = {};
      const emaUpdates: Record<string, Record<number, number | null>> = {};
      const warmupUpdates: Record<string, Record<number, number>> = {};
      for (const [k, v] of Object.entries(batch)) {
        warmupUpdates[k] = v.warmup;
        const hasEmaValues = Object.keys(v.emas).some((p) => v.emas[Number(p)] != null);
        if (hasEmaValues) emaUpdates[k] = v.emas;
      }
      setEmaByKey((prev) => (Object.keys(emaUpdates).length > 0 ? { ...prev, ...emaUpdates } : prev));
      setWarmupByKey((prev) => ({ ...prev, ...warmupUpdates }));
    }
    flushTimerRef.current = null;
  }, []);
  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current === null) {
      flushTimerRef.current = setTimeout(flushSocketUpdates, 120);
    }
  }, [flushSocketUpdates]);

  useEffect(() => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const socket = io(origin, {
      path: '/socket.io',
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      timeout: 20000,
    });
    socketRef.current = socket;
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', (reason) => {
      setConnected(false);
      if (reason === 'io server disconnect') socket.connect();
    });
    socket.on('connect_error', (err) => {
      setConnected(false);
      console.warn('Socket connect_error:', err.message);
    });
    socket.on('price:update', (data: any) => {
      const sym = data.symbol;
      if (!sym) return;
      const tf = data.timeframe ?? DEFAULT_TIMEFRAME;
      const key = watchKey(sym, tf);
      pendingPriceRef.current[key] = {
        price: data.price,
        change: data.change ?? 0,
        changePercent: data.changePercent ?? 0,
        currency: data.currency ?? 'INR',
        source: data.source ?? '',
        lastUpdate: new Date(),
      };
      scheduleFlush();
    });
    socket.on('ema:update', (data: any) => {
      const sym = data.symbol;
      const tf = data.timeframe || DEFAULT_TIMEFRAME;
      if (!sym) return;
      const key = watchKey(sym, tf);
      const emas = data.emas || {};
      const warmupProgress = data.warmupProgress || {};
      const hasEmaValues = Object.keys(emas).some((p) => emas[p] != null);
      if (!pendingEmaRef.current[key]) pendingEmaRef.current[key] = { emas: {}, warmup: {} };
      if (hasEmaValues) pendingEmaRef.current[key].emas = emas;
      pendingEmaRef.current[key].warmup = warmupProgress;
      scheduleFlush();
    });
    socket.on('alert:crossover', (alert: AlertData) => {
      setAlerts((prev) => [alert, ...prev].slice(0, 100));
      if ('Notification' in window && Notification.permission === 'granted') {
        const emoji = alert.crossoverType === 'bullish' ? '📈' : '📉';
        new Notification(`${emoji} ${alert.symbol} EMA Alert`, {
          body: `${alert.crossoverType.toUpperCase()}: EMA(${alert.fastPeriod}) crossed ${alert.crossoverType === 'bullish' ? 'above' : 'below'} EMA(${alert.slowPeriod}) at ${getCurrencySymbol(alert.currency)}${alert.price}`,
          icon: '/signalstack-logo.png',
          tag: `alert-${alert.id}`,
        });
      }
    });
    socket.on('monitor:status', (data: { symbol?: string; status?: string; message?: string }) => {
      setMonitorStatus(data.message || data.status || '');
      if (data.status === 'stopped') {
        if (data.symbol) {
          setMonitoredSymbols((prev) => {
            const next = new Set(prev);
            next.delete(data.symbol!);
            return next;
          });
        } else {
          setMonitoredSymbols(new Set());
        }
      }
    });
    return () => {
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      socket.disconnect();
    };
  }, [scheduleFlush, flushSocketUpdates]);

  // Poll EMA status when monitoring and socket may not deliver (e.g. mobile, deploy without persistent WS)
  useEffect(() => {
    const symbol = displaySymbol;
    const timeframe = displayTimeframe;
    if (!symbol || !monitoredSymbols.has(symbol)) return;

    const key = watchKey(symbol, timeframe);
    const poll = async () => {
      try {
        const { data } = await axios.get<{ emas: Record<number, number | null>; warmupProgress: Record<number, number> }>(
          `/api/ema-status?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`
        );
        if (data?.emas && Object.keys(data.emas).length > 0) {
          setEmaByKey((prev) => ({ ...prev, [key]: { ...prev[key], ...data.emas } }));
        }
        if (data?.warmupProgress && Object.keys(data.warmupProgress).length > 0) {
          setWarmupByKey((prev) => ({ ...prev, [key]: { ...prev[key], ...data.warmupProgress } }));
        }
      } catch {
        // ignore (e.g. serverless or no server)
      }
    };

    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [displaySymbol, displayTimeframe, monitoredSymbols]);

  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  }, []);

  // Close search dropdown when clicking outside
  useEffect(() => {
    if (!showSearch) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) {
        setShowSearch(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showSearch]);

  const getCurrencySymbol = (c: string) => {
    const symbols: Record<string, string> = { USD: '$', INR: '₹', GBP: '£', JPY: '¥', EUR: '€' };
    return symbols[c] || c;
  };

  // ===================================
  // SEARCH
  // ===================================
  const searchStocks = useCallback(async (query: string, exchangeFilter?: 'ALL' | 'NSE' | 'NFO' | 'BSE') => {
    if (!query || query.length < 1) { setSearchResults([]); setShowSearch(false); return; }
    const filter = exchangeFilter ?? searchExchangeFilter;
    console.log('[EMAAlertSystem] searchStocks called, query:', query, 'exchange:', filter);
    setIsSearching(true);
    try {
      const res = await axios.post('/api/search-symbols', { query, exchangeFilter: filter });
      console.log('[EMAAlertSystem] search-symbols response:', res.data?.success, 'count:', res.data?.results?.length);
      if (res.data.success) { setSearchResults(res.data.results); setShowSearch(true); }
      else setSearchResults([]);
    } catch (err: any) {
      console.error('[EMAAlertSystem] search-symbols request failed:', err?.message, err?.response?.data);
      setSearchResults([]);
    } finally { setIsSearching(false); }
  }, [searchExchangeFilter]);

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedSearch = useCallback((query: string) => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (!query) { setSearchResults([]); setShowSearch(false); return; }
    searchDebounceRef.current = setTimeout(() => searchStocks(query, searchExchangeFilter), 400);
  }, [searchStocks, searchExchangeFilter]);

  const addSymbol = async (result: SearchResult) => {
    if (symbols.some((s) => s.symbol.toUpperCase() === result.symbol.toUpperCase())) {
      setShowSearch(false);
      setSearchQuery('');
      return;
    }
    const newEntry: MonitoredSymbol = {
      symbol: result.symbol,
      name: result.name,
      currency: result.currency || 'INR',
      exchange: result.exchange || 'NSE',
    };
    setSymbols((prev) => [...prev, newEntry]);
    setTimeframeBySymbol((prev) => ({ ...prev, [result.symbol]: DEFAULT_TIMEFRAME }));
    setEmasBySymbol((prev) => ({
      ...prev,
      [result.symbol]: prev[result.symbol] ?? [],
    }));
    setSearchQuery('');
    setShowSearch(false);
    setSelectedSymbol(result.symbol);
    // Price for all symbols (including this one) is fetched by the effect when symbolKeys/timeframes change
  };

  const removeSymbol = async (sym: string) => {
    const tf = getTimeframe(sym);
    if (monitoredSymbols.has(sym)) {
      try {
        await axios.delete('/api/monitor', { data: { symbol: sym, timeframe: tf } });
      } catch { /* ignore */ }
      setMonitoredSymbols((prev) => {
        const next = new Set(prev);
        next.delete(sym);
        return next;
      });
    }
    const remaining = symbols.filter((s) => s.symbol !== sym);
    setSymbols(remaining);
    setTimeframeBySymbol((prev) => { const next = { ...prev }; delete next[sym]; return next; });
    setEmasBySymbol((prev) => { const next = { ...prev }; delete next[sym]; return next; });
    if (selectedSymbol === sym) setSelectedSymbol(remaining[0]?.symbol ?? null);
    const key = watchKey(sym, tf);
    setPriceByKey((prev) => { const next = { ...prev }; delete next[key]; return next; });
    setEmaByKey((prev) => { const next = { ...prev }; delete next[key]; return next; });
    setWarmupByKey((prev) => { const next = { ...prev }; delete next[key]; return next; });
  };

  const stopMonitoringForSymbol = async (sym: string) => {
    const tf = getTimeframe(sym);
    try {
      await axios.delete('/api/monitor', { data: { symbol: sym, timeframe: tf } });
    } catch { /* ignore */ }
    setMonitoredSymbols((prev) => {
      const next = new Set(prev);
      next.delete(sym);
      return next;
    });
    if (userId) refetchWatches();
    const key = watchKey(sym, tf);
    setPriceByKey((prev) => { const n = { ...prev }; delete n[key]; return n; });
    setEmaByKey((prev) => { const n = { ...prev }; delete n[key]; return n; });
    setWarmupByKey((prev) => { const n = { ...prev }; delete n[key]; return n; });
  };

  const getExchange = useCallback((sym: string): string => {
    const s = symbols.find((x) => x.symbol === sym);
    return s?.exchange || 'NSE';
  }, [symbols]);

  const fetchPrice = useCallback(async (sym: string, tf: string, exchange?: string) => {
    if (!sym) return;
    const exch = exchange ?? getExchange(sym);
    setIsFetchingPrice(true);
    try {
      const res = await axios.post('/api/fetch-price', { symbol: sym, timeframe: tf, exchange: exch });
      if (res.data.success && res.data.data) {
        const key = watchKey(sym, tf);
        setPriceByKey((prev) => ({
          ...prev,
          [key]: {
            price: res.data.data.price,
            change: res.data.data.change || 0,
            changePercent: res.data.data.changePercent || 0,
            currency: res.data.data.currency || 'INR',
            source: res.data.data.source || '',
            lastUpdate: new Date(),
          },
        }));
      }
    } catch { /* ignore */ } finally { setIsFetchingPrice(false); }
  }, []);

  const symbolKeys = symbols.map((s) => s.symbol).join(',');
  const timeframeFetchKey = useMemo(
    () => symbols.map((s) => `${s.symbol}:${timeframeBySymbol[s.symbol] ?? DEFAULT_TIMEFRAME}`).sort().join(','),
    [symbols, timeframeBySymbol]
  );
  const symbolsRef = useRef<MonitoredSymbol[]>(symbols);
  symbolsRef.current = symbols;
  const timeframeBySymbolRef = useRef<Record<string, string>>(timeframeBySymbol);
  timeframeBySymbolRef.current = timeframeBySymbol;
  const lastFetchedRef = useRef('');

  useEffect(() => {
    if (!symbolKeys) return;
    if (lastFetchedRef.current === timeframeFetchKey) return;
    lastFetchedRef.current = timeframeFetchKey;
    const list = symbolsRef.current;
    const tfBySym = timeframeBySymbolRef.current;
    list.forEach((s) => fetchPrice(s.symbol, tfBySym[s.symbol] ?? DEFAULT_TIMEFRAME, s.exchange));
  }, [timeframeFetchKey, symbolKeys, fetchPrice]);

  // ===================================
  // EMA MANAGEMENT
  // ===================================
  const addEma = (period?: number) => {
    if (!displaySymbol) return;
    const p = period || parseInt(newEmaPeriod);
    if (!p || p <= 0) return;
    const current = emasBySymbol[displaySymbol] ?? [];
    if (current.some((e) => e.period === p)) return;
    setEmasBySymbol((prev) => ({
      ...prev,
      [displaySymbol]: [...(prev[displaySymbol] ?? []), { id: Date.now(), period: p, color: COLORS[(prev[displaySymbol]?.length ?? 0) % COLORS.length] }],
    }));
    setNewEmaPeriod('');
    setShowAddEma(false);
  };
  const removeEma = (id: number) => {
    if (!displaySymbol) return;
    setEmasBySymbol((prev) => ({
      ...prev,
      [displaySymbol]: (prev[displaySymbol] ?? []).filter((e) => e.id !== id),
    }));
  };

  const startMonitoringForSymbol = async (sym: string) => {
    const symbolEmas = emasBySymbol[sym] ?? [];
    if (symbolEmas.length < 2) {
      setMonitorStatus(`${sym}: add at least 2 EMAs`);
      return;
    }
    const s = symbols.find((x) => x.symbol === sym);
    if (!s) return;
    const tf = getTimeframe(sym);
    try {
      setMonitorStatus(`Starting ${sym}...`);
      const res = await axios.post('/api/monitor', {
        symbol: s.symbol,
        timeframe: tf,
        emaPeriods: symbolEmas.map((e) => e.period),
        trackBullish,
        trackBearish,
        exchange: s.exchange || 'NSE',
        currency: s.currency,
      });
      if (res.data.success) {
        setMonitoredSymbols((prev) => new Set(prev).add(sym));
        setMonitorStatus('');
        if (userId) refetchWatches();
      } else {
        setMonitorStatus(res.data.message || 'Failed');
      }
    } catch (err: any) {
      setMonitorStatus('Error');
      console.error(err);
    }
  };

  const _startMonitoring = async () => {
    if (symbols.length === 0) {
      alert('Add at least one symbol');
      return;
    }
    try {
      setMonitorStatus('Starting...');
      const started: string[] = [];
      const startedWatches: MonitoredWatch[] = [];
      for (const s of symbols) {
        const symbolEmas = emasBySymbol[s.symbol] ?? [];
        const emaPeriods = symbolEmas.map((e) => e.period);
        if (emaPeriods.length < 2) {
          setMonitorStatus(`${s.symbol}: add at least 2 EMAs`);
          break;
        }
        const tf = getTimeframe(s.symbol);
        const res = await axios.post('/api/monitor', {
          symbol: s.symbol,
          timeframe: tf,
          emaPeriods,
          trackBullish,
          trackBearish,
          exchange: s.exchange || 'NSE',
          currency: s.currency,
        });
        if (!res.data.success) {
          setMonitorStatus(res.data.message || 'Failed');
          break;
        }
        started.push(s.symbol);
        startedWatches.push({
          symbol: s.symbol,
          timeframe: tf,
          emaPeriods,
          trackBullish,
          trackBearish,
          exchange: s.exchange || 'NSE',
          currency: s.currency,
        });
      }
      if (started.length > 0) {
        setMonitoredSymbols((prev) => new Set([...prev, ...started]));
        if (userId) refetchWatches();
      }
      setMonitorStatus(prev => (started.length > 0 ? '' : prev));
    } catch (err: any) {
      setMonitorStatus('Error');
      console.error(err);
    }
  };

  const stopMonitoring = async () => {
    try {
      for (const sym of monitoredSymbols) {
        await axios.delete('/api/monitor', { data: { symbol: sym, timeframe: getTimeframe(sym) } });
      }
      setMonitoredSymbols(new Set());
      setMonitorStatus('');
      if (userId) refetchWatches();
    } catch { /* ignore */ }
  };

  const _resetAll = async () => {
    if (monitoredSymbols.size > 0) {
      try {
        for (const sym of monitoredSymbols) {
          await axios.delete('/api/monitor', { data: { symbol: sym, timeframe: getTimeframe(sym) } });
        }
      } catch { /* ignore */ }
    }
    setMonitoredSymbols(new Set());
    setMonitorStatus('');
    setSymbols([]);
    setSelectedSymbol(null);
    setTimeframeBySymbol({});
    setPriceByKey({});
    setEmaByKey({});
    setWarmupByKey({});
    setSearchQuery('');
    setEmasBySymbol({});
    setShowAddEma(false);
    setNewEmaPeriod('');
    setEditingPairIndex(null);
    if (userId) {
      axios.put('/api/user/config', { symbols: [], timeframeBySymbol: {}, emasBySymbol: {}, trackBullish: true, trackBearish: true, selectedSymbol: null }).catch(() => {});
      refetchWatches();
    }
  };

  /** Reset: stop all monitoring and clear live data only. Keeps symbol list and EMA config. */
  const resetConfigKeepSymbols = () => {
    setMonitoredSymbols(new Set());
    setMonitorStatus('');
    setPriceByKey({});
    setEmaByKey({});
    setWarmupByKey({});
    setSearchQuery('');
    setShowAddEma(false);
    setNewEmaPeriod('');
    setEditingPairIndex(null);
    setSelectedSymbol((prev) => (symbols.length > 0 ? (prev && symbols.some((s) => s.symbol === prev) ? prev : symbols[0].symbol) : null));
    if (userId) refetchWatches();
  };

  const handleReset = async () => {
    if (monitoredSymbols.size > 0) {
      try {
        for (const sym of monitoredSymbols) {
          await axios.delete('/api/monitor', { data: { symbol: sym, timeframe: getTimeframe(sym) } });
        }
      } catch { /* ignore */ }
    }
    resetConfigKeepSymbols();
  };

  /** Decode base64url VAPID public key for PushManager (see OpenReplay Web Push guide) */
  const urlBase64ToUint8Array = (base64String: string): Uint8Array => {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  };

  const enablePush = async () => {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
      // Request permission on user gesture (required by browsers)
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return;
      const registration = await navigator.serviceWorker.ready;
      const { data } = await axios.get<{ publicKey: string }>('/api/push-public-key');
      if (!data?.publicKey) return;
      const applicationServerKey = urlBase64ToUint8Array(data.publicKey);
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey as BufferSource,
      });
      await axios.post('/api/push-subscribe', subscription.toJSON());
      setPushEnabled(true);
    } catch (err) {
      console.error('Push subscription failed:', err);
    }
  };

  const disablePush = useCallback(async () => {
    if (!window.confirm('Confirm you want to turn alerts off? You will stop receiving push and in-app crossover alerts until you enable them again.')) return;
    setPushEnabled(false);
    try {
      const registration = await navigator.serviceWorker?.ready;
      const subscription = await registration?.pushManager?.getSubscription();
      if (subscription?.endpoint) {
        await axios.delete('/api/push-subscribe', { data: { endpoint: subscription.endpoint } });
        await subscription.unsubscribe();
      }
    } catch (err) {
      console.error('Push unsubscribe failed:', err);
    }
  }, []);

  const sendTestEmail = async () => {
    setTestEmailStatus('sending');
    setTestEmailMessage(null);
    try {
      const res = await axios.post<{ success: boolean; message?: string; error?: string; email?: string }>('/api/test-email');
      if (res.data.success) {
        setTestEmailStatus('success');
        setTestEmailMessage(res.data.message ?? (res.data.email ? `Sent to ${res.data.email}` : null));
        setTimeout(() => { setTestEmailStatus('idle'); setTestEmailMessage(null); }, 5000);
      } else {
        setTestEmailStatus('error');
        setTestEmailMessage(res.data.error ?? 'Send failed');
        setTimeout(() => { setTestEmailStatus('idle'); setTestEmailMessage(null); }, 5000);
      }
    } catch (err: unknown) {
      setTestEmailStatus('error');
      const msg = err && typeof err === 'object' && 'response' in err && err.response && typeof err.response === 'object' && 'data' in err.response
        ? (err.response.data as { error?: string })?.error
        : 'Request failed';
      setTestEmailMessage(msg ?? 'Request failed');
      setTimeout(() => { setTestEmailStatus('idle'); setTestEmailMessage(null); }, 5000);
    }
  };

  const sendTestPush = async (delaySeconds = 0) => {
    setTestPushStatus('sending');
    setTestPushMessage(null);
    try {
      const res = await axios.post<{ success: boolean; message?: string; error?: string; sent?: number; failed?: number; scheduled?: boolean; delaySeconds?: number }>(
        '/api/push-test',
        delaySeconds > 0 ? { delaySeconds } : {},
      );
      if (res.data.success) {
        setTestPushStatus('success');
        const msg = res.data.message ?? (res.data.sent != null ? `Sent to ${res.data.sent} device(s). Check browser or system tray.` : 'Check your browser or system tray.');
        setTestPushMessage(msg);
        // Show a local notification only for immediate test (not delayed "when closed" test)
        if (!res.data.scheduled && res.data.sent && res.data.sent > 0 && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          try {
            new Notification('🔔 SignalStack – Test notification', {
              body: "If you see this, browser notifications are working. You'll get crossover alerts the same way.",
              icon: '/signalstack-logo.png',
              tag: 'signalstack-test-local',
            });
          } catch { /* ignore */ }
        }
        setTimeout(() => { setTestPushStatus('idle'); setTestPushMessage(null); }, res.data.scheduled ? 10000 : 6000);
      } else {
        setTestPushStatus('error');
        const errMsg = res.data.error ?? 'Send failed';
        setTestPushMessage(errMsg.includes('Enable alerts') ? 'No subscriptions on server. Click "Enable alerts", then try again.' : errMsg);
        setTimeout(() => { setTestPushStatus('idle'); setTestPushMessage(null); }, 6000);
      }
    } catch (err: unknown) {
      setTestPushStatus('error');
      const resData = err && typeof err === 'object' && 'response' in err && err.response && typeof err.response === 'object' && 'data' in err.response
        ? (err.response as { data?: { error?: string }; status?: number }).data
        : null;
      const msg = resData?.error ?? (resData ? 'Request failed' : 'Network or server error. Try again.');
      setTestPushMessage(msg);
      setTimeout(() => { setTestPushStatus('idle'); setTestPushMessage(null); }, 6000);
    }
  };

  const crossoverPairs = useMemo((): [EMA, EMA][] => {
    const pairs: [EMA, EMA][] = [];
    const sorted = [...emas].sort((a, b) => a.period - b.period);
    for (let i = 0; i < sorted.length; i++)
      for (let j = i + 1; j < sorted.length; j++)
        pairs.push([sorted[i], sorted[j]]);
    return pairs;
  }, [emas]);

  // ===================================
  // RENDER
  // ===================================
  return (
    <div className="min-h-screen text-white overflow-x-hidden safe-area-inset">
      {/* Refresh modal: shown on load until data is ready */}
      {showRefreshModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.88)', backdropFilter: 'blur(6px)' }}
          aria-modal="true"
          role="alertdialog"
          aria-live="polite"
        >
          <div
            className="max-w-sm w-full rounded-2xl p-6 text-center shadow-2xl border border-[var(--border)]"
            style={{ backgroundColor: 'var(--card-bg)' }}
          >
            <RefreshCw className="w-10 h-10 mx-auto mb-4 animate-spin opacity-80" style={{ color: 'var(--accent)' }} />
            <h3 className="font-semibold text-base mb-2" style={{ color: 'var(--text-primary)' }}>
              Fetching refreshed data
            </h3>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              Wait a moment until all alerts are showing and monitoring is active again.
            </p>
          </div>
        </div>
      )}

      <div className="max-w-6xl mx-auto w-full min-w-0 px-4 sm:px-5">

        {/* ─── HEADER: title + user profile on one line; action buttons on next row ─── */}
        <header className="mb-4 sm:mb-5">
          {/* Row 1: Logo + title (left), User profile (right) — same line */}
          <div className="flex items-center justify-between gap-3 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <img src="/signalstack-logo.png" alt="Logo" className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex-shrink-0" />
              <div className="min-w-0">
                <h1 className="text-base sm:text-lg font-bold truncate" style={{ color: 'var(--text-primary)' }}>SignalStack</h1>
                <p className="text-[10px] sm:text-[11px] font-medium tracking-wider uppercase" style={{ color: 'var(--text-muted)' }}>EMA Alerts</p>
              </div>
            </div>
            <div className="flex-shrink-0">
              <UserButton
                appearance={{
                  elements: { avatarBox: 'w-9 h-9' },
                  variables: {
                    colorPrimary: '#2563eb',
                    colorBackground: '#ffffff',
                    colorText: '#0f172a',
                    colorTextSecondary: '#475569',
                  },
                }}
              />
            </div>
          </div>
          {/* Row 2: Action buttons — wrap within padded container */}
          <div className="flex flex-wrap items-center gap-2 mt-3 min-w-0">
            <div
              className={`flex items-center gap-1 sm:gap-1.5 text-xs font-semibold px-2.5 py-2 sm:px-3 rounded-lg border min-h-[44px] flex-shrink-0 ${connected ? 'border-emerald-500/30 text-emerald-400' : 'border-red-500/30 text-red-400'
                }`}
              style={{ background: connected ? 'var(--green-bg)' : 'var(--red-bg)' }}
              title={connected ? 'Real-time updates connected' : 'Not connected. Use the deployment where the Node server runs (e.g. Railway URL) for Live updates.'}
            >
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${connected ? 'bg-emerald-400 anim-live' : 'bg-red-400'}`} />
              {connected ? <Wifi className="w-3.5 h-3.5 flex-shrink-0" /> : <WifiOff className="w-3.5 h-3.5 flex-shrink-0" />}
              <span>{connected ? 'Live' : 'Offline'}</span>
            </div>
            {userId && (
              <div className="flex flex-col items-end gap-0.5">
                <button
                  type="button"
                  onClick={sendTestEmail}
                  disabled={testEmailStatus === 'sending'}
                  className="tf-btn flex items-center gap-1.5 !text-xs min-h-[44px] flex-shrink-0"
                  title="Send a test email to your account email. Check spam if you don’t see it."
                >
                  <Mail className="w-3.5 h-3.5" />
                  <span>
                    {testEmailStatus === 'sending' ? 'Sending…' : testEmailStatus === 'success' ? 'Sent!' : testEmailStatus === 'error' ? 'Failed' : 'Test email'}
                  </span>
                </button>
                {testEmailMessage && (
                  <span className="text-[10px] max-w-[200px] truncate text-right" style={{ color: 'var(--text-muted)' }} title={testEmailMessage}>
                    {testEmailStatus === 'success' ? testEmailMessage : testEmailMessage}
                  </span>
                )}
              </div>
            )}
            {mounted && 'serviceWorker' in navigator && (
              pushAvailable === false ? (
                <span className="text-[10px] sm:text-xs px-2 py-1.5 rounded-lg border border-amber-500/30 text-amber-400/90 flex-shrink-0" title="Add VAPID env vars in production to enable alerts">
                  Alerts unavailable
                </span>
              ) : (
                <div className="flex items-center gap-2 flex-wrap">
                  {!pushEnabled ? (
                    <button
                      onClick={enablePush}
                      className="tf-btn flex items-center gap-1.5 !text-xs flex-shrink-0"
                      title="Get crossover alerts on this device (browser notifications + email)"
                      aria-label="Enable crossover alerts on this device"
                    >
                      <Bell className="w-3.5 h-3.5" />
                      <span>Enable alerts</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={disablePush}
                      className="text-[10px] sm:text-xs px-2 py-1.5 rounded-lg border border-emerald-500/30 text-emerald-400/90 flex items-center gap-1.5 flex-shrink-0 hover:bg-emerald-500/10 transition-colors cursor-pointer"
                      title="Click to turn alerts off"
                      aria-label="Alerts on – click to turn off"
                    >
                      <Bell className="w-3.5 h-3.5" />
                      Alerts on
                    </button>
                  )}
                  <button
                    onClick={() => sendTestPush(0)}
                    disabled={testPushStatus === 'sending'}
                    className="tf-btn flex items-center gap-1.5 !text-xs disabled:opacity-60 disabled:cursor-not-allowed flex-shrink-0"
                    title="Send a test push now (shows in this tab too)"
                    aria-label="Send test push notification"
                  >
                    <Bell className="w-3.5 h-3.5" />
                    <span>
                      {testPushStatus === 'sending' ? 'Sending…' : testPushStatus === 'success' ? 'Sent!' : testPushStatus === 'error' ? 'Failed' : 'Test notification'}
                    </span>
                  </button>
                  <button
                    onClick={() => sendTestPush(60)}
                    disabled={testPushStatus === 'sending'}
                    className="tf-btn flex items-center gap-1.5 !text-xs disabled:opacity-60 disabled:cursor-not-allowed flex-shrink-0"
                    title="Send test in 1 min—close the browser to verify push when away"
                    aria-label="Test notification when browser closed"
                  >
                    <Bell className="w-3.5 h-3.5" />
                    <span>Test when closed</span>
                  </button>
                  {testPushMessage && (
                    <span className="text-[10px] max-w-[220px] truncate" style={{ color: 'var(--text-muted)' }} title={testPushMessage}>
                      {testPushMessage}
                    </span>
                  )}
                </div>
              )
            )}
          </div>
        </header>

        {/* ─── MONITORING BANNER ─── */}
        {isMonitoring && (
          <div className="mb-4 px-4 py-3 rounded-xl flex items-center justify-between flex-wrap gap-2"
            style={{ background: 'var(--green-bg)', border: '1px solid rgba(52,211,153,0.25)' }}>
            <div className="flex items-center gap-3 min-w-0 flex-wrap">
              <div className="relative flex-shrink-0">
                <Activity className="w-5 h-5 text-emerald-400" />
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-emerald-400 rounded-full animate-ping" />
              </div>
              <span className="text-emerald-400/60 text-xs">Per-symbol timeframes — {monitorStatus || 'Monitoring active'}</span>
              <div className="flex flex-wrap gap-2">
                {symbols.filter((s) => monitoredSymbols.has(s.symbol)).map((s) => (
                  <div key={s.symbol} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg" style={{ background: 'rgba(0,0,0,0.15)', border: '1px solid rgba(52,211,153,0.2)' }}>
                    <span className="font-bold text-emerald-300 text-sm">{s.symbol}</span>
                    <span className="text-emerald-400/70 text-xs">({getTimeframe(s.symbol)})</span>
                    <button
                      type="button"
                      onClick={() => stopMonitoringForSymbol(s.symbol)}
                      className="p-1 rounded hover:bg-red-500/20 flex items-center justify-center"
                      style={{ color: 'var(--red)' }}
                      title={`Stop monitoring ${s.symbol}`}
                    >
                      <Power className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
            <button onClick={stopMonitoring}
              className="flex-shrink-0 flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold"
              style={{ background: 'var(--red-bg)', border: '1px solid rgba(251,113,133,0.3)', color: 'var(--red)' }}>
              <Power className="w-3.5 h-3.5" />
              Stop all
            </button>
          </div>
        )}

        {/* ─── SEARCH BAR + EXCHANGE FILTER ─── */}
        <div className="card mb-4 !p-4" ref={searchContainerRef}>
          <div className="flex flex-col sm:flex-row gap-3 sm:gap-2 sm:items-center">
            <div className="relative min-w-0 w-full sm:w-[75%]">
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => { setSearchQuery(e.target.value); debouncedSearch(e.target.value); }}
                onFocus={() => { if (searchResults.length > 0) setShowSearch(true); }}
                onBlur={() => { setTimeout(() => setShowSearch(false), 180); }}
                className="input-field !py-3 text-base font-semibold pr-10 w-full"
                placeholder="Search symbols (e.g. RELIANCE)"
                aria-autocomplete="list"
                aria-controls={showSearch && searchResults.length > 0 ? 'search-results-listbox' : undefined}
              />
              <Search className={`absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 pointer-events-none ${isSearching ? 'animate-spin' : ''}`} style={{ color: 'var(--text-muted)' }} />
            </div>
            <div className="flex flex-row items-center gap-2 w-full sm:w-[25%] min-w-0">
              <label htmlFor="search-exchange-filter" className="text-[10px] sm:text-xs font-medium uppercase tracking-wide flex-shrink-0 whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                Exchange
              </label>
              <select
                id="search-exchange-filter"
                value={searchExchangeFilter}
                onChange={(e) => { const v = e.target.value as 'ALL' | 'NSE' | 'NFO' | 'BSE'; setSearchExchangeFilter(v); if (searchQuery.trim()) debouncedSearch(searchQuery); }}
                className="input-field !py-2.5 sm:!py-3 text-sm font-medium rounded-lg cursor-pointer w-full min-w-0 flex-1"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
                title="Filter search results by exchange (All, NSE, NFO, BSE)"
                aria-label="Filter search by exchange"
              >
                <option value="ALL">All</option>
                <option value="NSE">NSE</option>
                <option value="NFO">NFO</option>
                <option value="BSE">BSE</option>
              </select>
            </div>
          </div>
          <div className="relative">

            {((showSearch && searchResults.length > 0) || searchQuery.trim().length > 0) && (
              <div id="search-results-listbox" className="absolute top-full left-0 right-0 mt-2 search-drop max-h-64 overflow-y-auto z-50 rounded-xl shadow-xl" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }} role="listbox">
                {searchResults.length > 0 ? (
                  searchResults.map((r, i) => (
                    <button
                      key={`${r.symbol}-${r.exchange || ''}-${i}`}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => addSymbol(r)}
                      className="w-full px-4 py-3 text-left transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-white/5"
                      style={{ borderBottom: '1px solid var(--border-subtle)' }}
                      role="option"
                      aria-selected={false}
                    >
                      <div className="flex justify-between items-center">
                        <div>
                          <span className="font-bold text-sm" style={{ color: 'var(--accent)' }}>{r.symbol}</span>
                          <span className="text-sm ml-2" style={{ color: 'var(--text-secondary)' }}>{r.name}</span>
                        </div>
                        <div className="text-right">
                          <span className="text-xs font-medium" style={{ color: 'var(--amber)' }}>{r.exchange}</span>
                          <span className="text-xs ml-2" style={{ color: 'var(--text-muted)' }}>{r.currency}</span>
                        </div>
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="px-4 py-4 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                    {isSearching ? 'Searching…' : 'No symbols found. Try e.g. RELIANCE or NIFTY 50.'}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ─── SYMBOL TABS + RESET ─── */}
        <div className="card mb-4 !p-0 overflow-hidden">
          <div className="flex border-b overflow-x-auto no-scrollbar" style={{ borderColor: 'var(--border-subtle)', WebkitOverflowScrolling: 'touch' }}>
            {symbols.map((s) => (
              <div
                key={s.symbol}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedSymbol(s.symbol)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedSymbol(s.symbol); } }}
                className="flex items-center gap-2 px-4 sm:px-5 py-3.5 min-h-[48px] text-sm font-semibold transition-colors border-b-2 min-w-0 flex-shrink-0 cursor-pointer touch-manipulation"
                style={{
                  borderBottomColor: selectedSymbol === s.symbol ? 'var(--accent)' : 'transparent',
                  color: selectedSymbol === s.symbol ? 'var(--accent)' : 'var(--text-secondary)',
                  background: selectedSymbol === s.symbol ? 'rgba(34,211,238,0.06)' : 'transparent',
                }}
              >
                <span className="truncate">{s.symbol}</span>
                {(s.exchange && s.exchange !== 'NSE') && (
                  <span className="text-xs font-medium opacity-80 flex-shrink-0" style={{ color: 'var(--amber)' }}>({s.exchange})</span>
                )}
                {!monitoredSymbols.has(s.symbol) && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); removeSymbol(s.symbol); }}
                    className="p-0.5 rounded hover:bg-red-500/10 flex-shrink-0"
                    style={{ color: 'var(--text-muted)' }}
                    aria-label={`Remove ${s.symbol}`}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={() => { searchInputRef.current?.focus(); setShowSearch(searchResults.length > 0); }}
              className="flex items-center gap-2 px-4 py-3.5 min-h-[48px] text-sm font-semibold transition-colors border-b-2 flex-shrink-0 touch-manipulation"
              style={{ color: 'var(--accent)', borderBottomColor: 'transparent', background: 'transparent' }}
              title="Add a new symbol to monitor"
            >
              <Plus className="w-4 h-4" />
              <span>Add</span>
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="flex items-center justify-center gap-1.5 px-4 sm:px-5 py-3.5 min-h-[48px] text-sm font-semibold transition-colors hover:bg-white/5 flex-shrink-0 touch-manipulation"
              style={{ color: 'var(--text-muted)', borderLeft: '1px solid var(--border-subtle)' }}
              title="Stop monitoring and clear live data (keeps symbols and EMA setup)"
            >
              <RefreshCw className="w-4 h-4" />
              <span>Reset</span>
            </button>
          </div>
        </div>

        {/* ─── TIMEFRAME + PRICE ─── */}
        <div className="card mb-4 !p-3 sm:!p-4">
          <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center sm:justify-between gap-3">
            <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1" style={{ WebkitOverflowScrolling: 'touch' }}>
              {TIMEFRAMES.map((tf) => (
                <button
                  key={tf.id}
                  onClick={() => displaySymbol && setTimeframeBySymbol((prev) => ({ ...prev, [displaySymbol]: tf.id }))}
                  disabled={!displaySymbol}
                  className={`tf-btn !px-3 sm:!px-4 !py-2.5 min-h-[44px] text-sm flex-shrink-0 touch-manipulation ${displayTimeframe === tf.id ? 'active' : ''}`}
                >
                  {tf.label}
                </button>
              ))}
            </div>

            {displaySymbol && (
              <div className="flex flex-wrap items-center gap-2 sm:gap-3 min-w-0">
                {isFetchingPrice ? (
                  <RefreshCw className="w-5 h-5 animate-spin flex-shrink-0" style={{ color: 'var(--accent)' }} />
                ) : displayPrice ? (
                  <>
                    <span className="text-sm font-medium flex-shrink-0" style={{ color: 'var(--text-muted)' }}>{displaySymbol}</span>
                    <span className="text-xl sm:text-2xl font-extrabold tracking-tight truncate" style={{ color: 'var(--text-primary)' }}>
                      {getCurrencySymbol(displayPrice.currency)}{displayPrice.price.toFixed(2)}
                    </span>
                    <div className="flex flex-col items-end min-w-0">
                      <span className="px-2 py-0.5 rounded text-xs font-bold whitespace-nowrap" style={{
                        background: displayPrice.changePercent >= 0 ? 'var(--green-bg)' : 'var(--red-bg)',
                        color: displayPrice.changePercent >= 0 ? 'var(--green)' : 'var(--red)'
                      }}>
                        {displayPrice.change >= 0 ? '+' : ''}{displayPrice.change.toFixed(2)} ({displayPrice.changePercent >= 0 ? '+' : ''}{displayPrice.changePercent.toFixed(2)}%)
                      </span>
                      <span className="text-xs mt-0.5 truncate max-w-full" style={{ color: 'var(--text-muted)' }} title={displayPrice.source + (displayPrice.lastUpdate ? ` · ${displayPrice.lastUpdate.toLocaleTimeString()}` : '')}>
                        {displayPrice.source}{displayPrice.lastUpdate && ` · ${displayPrice.lastUpdate.toLocaleTimeString()}`}
                      </span>
                    </div>
                  </>
                ) : null}
              </div>
            )}
          </div>
        </div>

        {/* ─── MAIN CONTENT ─── */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">

          {/* ─── LEFT: EMA Config ─── */}
          <div className="lg:col-span-5">
            <div className="card !p-3 sm:!p-5">
              <div className="flex items-center justify-between gap-2 mb-4 min-w-0">
                <div className="section-label flex items-center gap-2 min-w-0">
                  <BarChart3 className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--accent)' }} />
                  <span className="truncate">EMA Periods {displaySymbol && <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>({displaySymbol})</span>}</span>
                </div>
                <span className="badge flex-shrink-0" style={{ background: 'rgba(34,211,238,0.12)', color: 'var(--accent)' }}>{emas.length}</span>
              </div>

              {/* Quick add — horizontal scroll on narrow screens */}
              <div className="flex gap-2 mb-4 overflow-x-auto no-scrollbar pb-1" style={{ WebkitOverflowScrolling: 'touch' }}>
                {[9, 21, 50, 100, 200].map((p) => (
                  <button key={p} onClick={() => addEma(p)}
                    disabled={!displaySymbol || !!emas.find((e) => e.period === p)}
                    className="ema-quick flex-shrink-0 min-w-[44px] text-sm touch-manipulation">
                    {p}
                  </button>
                ))}
                <button onClick={() => setShowAddEma(!showAddEma)}
                  disabled={!displaySymbol}
                  className="flex items-center justify-center w-11 min-w-[44px] min-h-[44px] rounded-lg transition-colors disabled:opacity-50 flex-shrink-0 touch-manipulation"
                  style={{ background: 'var(--bg-elevated)', border: '1px dashed var(--border-medium)', color: 'var(--text-secondary)' }}>
                  <Plus className="w-4 h-4" />
                </button>
              </div>

              {showAddEma && (
                <div className="flex gap-2 mb-4 anim-fade-up">
                  <input type="number" value={newEmaPeriod} onChange={(e) => setNewEmaPeriod(e.target.value)}
                    className="input-field flex-1 text-sm" placeholder="Custom period" min="1" />
                  <button onClick={() => addEma()} disabled={!newEmaPeriod || parseInt(newEmaPeriod) <= 0}
                    className="px-5 py-2.5 rounded-lg text-sm font-bold transition-all disabled:opacity-30"
                    style={{ background: 'var(--accent)', color: '#080c14' }}>
                    Add
                  </button>
                </div>
              )}

              {/* EMA list */}
              {!displaySymbol ? (
                <div className="text-center py-6" style={{ color: 'var(--text-muted)' }}>
                  <BarChart3 className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  <p className="text-sm font-medium">Select a symbol above</p>
                  <p className="text-xs mt-1 opacity-60">to set EMAs for that stock</p>
                </div>
              ) : emas.length === 0 ? (
                <div className="text-center py-6" style={{ color: 'var(--text-muted)' }}>
                  <BarChart3 className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  <p className="text-sm font-medium">Add at least 2 EMAs for {displaySymbol}</p>
                  <p className="text-xs mt-1 opacity-60">to start monitoring crossovers</p>
                </div>
              ) : (
                <div className="space-y-2 mb-4">
                  {emas.map((ema) => (
                    <div key={ema.id} className="flex items-center justify-between px-4 py-3 rounded-xl" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: ema.color, boxShadow: `0 0 8px ${ema.color}50` }} />
                        <span className="font-bold text-sm" style={{ color: 'var(--text-primary)' }}>EMA({ema.period})</span>
                        {displayEmaValues[ema.period] != null && (
                          <span className="text-sm font-mono" style={{ color: 'var(--text-muted)' }}>= {displayEmaValues[ema.period]!.toFixed(2)}</span>
                        )}
                        {displayWarmupProgress[ema.period] !== undefined && displayWarmupProgress[ema.period] < 1 && (
                          <div className="flex items-center gap-2">
                            <div className="w-16 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border-subtle)' }}>
                              <div className="h-full rounded-full transition-all duration-500" style={{ width: `${displayWarmupProgress[ema.period] * 100}%`, background: 'var(--accent)' }} />
                            </div>
                            <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>{Math.round(displayWarmupProgress[ema.period] * 100)}%</span>
                          </div>
                        )}
                      </div>
                      <button onClick={() => removeEma(ema.id)} className="p-1.5 rounded-lg transition-colors hover:bg-red-500/10 flex-shrink-0"
                        style={{ color: 'var(--text-muted)' }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--red)')}
                        onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}>
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="h-px my-4" style={{ background: 'var(--border-subtle)' }} />

              {/* Monitoring Controls — which crossovers to alert on */}
              <div className="flex gap-2 mb-4">
                <button
                  type="button"
                  onClick={() => setTrackBullish(!trackBullish)}
                  className={`toggle-btn text-sm min-h-[48px] touch-manipulation ${trackBullish ? 'bull-on' : ''}`}
                  aria-pressed={trackBullish}
                  aria-label={trackBullish ? 'Alert on bullish crossovers (on)' : 'Alert on bullish crossovers (off)'}
                >
                  <TrendingUp className="w-4 h-4 flex-shrink-0" />
                  <span>Bullish</span>
                </button>
                <button
                  type="button"
                  onClick={() => setTrackBearish(!trackBearish)}
                  className={`toggle-btn text-sm min-h-[48px] touch-manipulation ${trackBearish ? 'bear-on' : ''}`}
                  aria-pressed={trackBearish}
                  aria-label={trackBearish ? 'Alert on bearish crossovers (on)' : 'Alert on bearish crossovers (off)'}
                >
                  <TrendingDown className="w-4 h-4 flex-shrink-0" />
                  <span>Bearish</span>
                </button>
              </div>

              <button
                onClick={displaySymbol && monitoredSymbols.has(displaySymbol) ? () => stopMonitoringForSymbol(displaySymbol) : () => displaySymbol && startMonitoringForSymbol(displaySymbol)}
                disabled={!displaySymbol || (emasBySymbol[displaySymbol] ?? []).length < 2}
                className={`cta text-base ${displaySymbol && monitoredSymbols.has(displaySymbol) ? 'halt' : 'go'}`}>
                {displaySymbol && monitoredSymbols.has(displaySymbol) ? (
                  <><Power className="w-5 h-5" /> Stop monitoring {displaySymbol}</>
                ) : (
                  <><Zap className="w-5 h-5" /> Start monitoring {displaySymbol || '…'}</>
                )}
              </button>
            </div>
          </div>

          {/* ─── RIGHT: Pairs + Alerts ─── */}
          <div className="lg:col-span-7 space-y-4">

            {/* Crossover Pairs */}
            <div className="card !p-3 sm:!p-5">
              <div className="flex items-center justify-between gap-3 mb-4 min-w-0">
                <div className="section-label flex items-center gap-2 min-w-0">
                  <Target className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--purple)' }} />
                  <span className="truncate">Crossover Pairs {displaySymbol && <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>({displaySymbol})</span>}</span>
                </div>
                <span className="badge flex-shrink-0" style={{ background: 'rgba(167,139,250,0.12)', color: 'var(--purple)' }}>
                  {crossoverPairs.length}
                </span>
              </div>

              {!displaySymbol || crossoverPairs.length === 0 ? (
                <div className="text-center py-8" style={{ color: 'var(--text-muted)' }}>
                  <Target className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  <p className="text-sm font-medium">{!displaySymbol ? 'Select a symbol' : 'No crossover pairs yet'}</p>
                  <p className="text-xs mt-1 opacity-60">{!displaySymbol ? 'to see EMA pairs for that stock' : 'Add at least 2 EMAs to see pairs'}</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {crossoverPairs.map(([fast, slow], i) => {
                    const fastVal = displayEmaValues[fast.period];
                    const slowVal = displayEmaValues[slow.period];
                    const fastAbove = fastVal != null && slowVal != null ? fastVal > slowVal : null;
                    const diff = fastVal != null && slowVal != null ? fastVal - slowVal : null;
                    const isEditing = editingPairIndex === i;
                    const allPeriods = [9, 21, 50, 100, 200];

                    const startEdit = () => {
                      setEditingPairIndex(i);
                      setEditPairFast(fast.period);
                      setEditPairSlow(slow.period);
                    };
                    const cancelEdit = () => setEditingPairIndex(null);
                    const saveEdit = () => {
                      if (!displaySymbol || editPairFast === editPairSlow) return;
                      const [p1, p2] = editPairFast < editPairSlow ? [editPairFast, editPairSlow] : [editPairSlow, editPairFast];
                      setEmasBySymbol((prev) => {
                        const list = prev[displaySymbol] ?? [];
                        const next = [...list];
                        if (!next.some((e) => e.period === p1)) next.push({ id: Date.now(), period: p1, color: COLORS[next.length % COLORS.length] });
                        if (!next.some((e) => e.period === p2)) next.push({ id: Date.now() + 1, period: p2, color: COLORS[next.length % COLORS.length] });
                        return { ...prev, [displaySymbol]: next };
                      });
                      setEditingPairIndex(null);
                    };

                    return (
                      <div
                        key={i}
                        role="button"
                        tabIndex={0}
                        onClick={() => !isEditing && startEdit()}
                        onKeyDown={(e) => !isEditing && (e.key === 'Enter' || e.key === ' ') && startEdit()}
                        className={`p-4 rounded-xl cursor-pointer transition-all ${isEditing ? 'ring-2' : ''}`}
                        style={{
                          background: 'var(--bg-elevated)',
                          border: isEditing ? '2px solid var(--accent)' : '1px solid var(--border-subtle)',
                          boxShadow: isEditing ? '0 0 0 2px rgba(34,211,238,0.2)' : undefined,
                        }}
                      >
                        {isEditing ? (
                          <div className="space-y-3">
                            <div className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                              <Pencil className="w-4 h-4" style={{ color: 'var(--accent)' }} />
                              Edit EMA pair
                            </div>
                            <div className="flex flex-wrap items-center gap-3">
                              <label className="flex items-center gap-2">
                                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Fast:</span>
                                <select
                                  value={editPairFast}
                                  onChange={(e) => setEditPairFast(Number(e.target.value))}
                                  className="input-field !py-2 !px-3 text-sm w-24"
                                >
                                  {allPeriods.map((p) => (
                                    <option key={p} value={p}>{p}</option>
                                  ))}
                                </select>
                              </label>
                              <ArrowRight className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                              <label className="flex items-center gap-2">
                                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Slow:</span>
                                <select
                                  value={editPairSlow}
                                  onChange={(e) => setEditPairSlow(Number(e.target.value))}
                                  className="input-field !py-2 !px-3 text-sm w-24"
                                >
                                  {allPeriods.map((p) => (
                                    <option key={p} value={p}>{p}</option>
                                  ))}
                                </select>
                              </label>
                            </div>
                            <div className="flex gap-2">
                              <button onClick={(e) => { e.stopPropagation(); saveEdit(); }} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold" style={{ background: 'var(--accent)', color: '#080c14' }}>
                                <Check className="w-3.5 h-3.5" /> Save
                              </button>
                              <button onClick={(e) => { e.stopPropagation(); cancelEdit(); }} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-medium)', color: 'var(--text-secondary)' }}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                              <div className="flex items-center gap-2 flex-shrink-0">
                                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: fast.color, boxShadow: `0 0 6px ${fast.color}50` }} />
                                <span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>EMA({fast.period})</span>
                              </div>
                              <ArrowRight className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                              <div className="flex items-center gap-2 flex-shrink-0">
                                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: slow.color, boxShadow: `0 0 6px ${slow.color}50` }} />
                                <span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>EMA({slow.period})</span>
                              </div>
                              <span className="text-xs sm:text-sm flex items-center gap-1 flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                                <Pencil className="w-3.5 h-3.5" /> Edit
                              </span>
                              {displaySymbol && monitoredSymbols.has(displaySymbol) && fastAbove !== null && (
                                <span className="px-2.5 py-1.5 rounded-lg text-xs font-bold flex-shrink-0 min-h-[28px] inline-flex items-center" style={{
                                  background: fastAbove ? 'var(--green-bg)' : 'var(--red-bg)',
                                  color: fastAbove ? 'var(--green)' : 'var(--red)',
                                  border: `1px solid ${fastAbove ? 'rgba(52,211,153,0.3)' : 'rgba(251,113,133,0.3)'}`
                                }}>
                                  {fastAbove ? '▲ Bullish' : '▼ Bearish'}
                                </span>
                              )}
                            </div>
                            {displaySymbol && monitoredSymbols.has(displaySymbol) && fastVal != null && slowVal != null ? (
                              <div className="flex items-center gap-4 mt-2.5 text-sm font-mono">
                                <span style={{ color: 'var(--text-secondary)' }}>Fast: <span style={{ color: 'var(--text-primary)' }}>{fastVal.toFixed(2)}</span></span>
                                <span style={{ color: 'var(--text-secondary)' }}>Slow: <span style={{ color: 'var(--text-primary)' }}>{slowVal.toFixed(2)}</span></span>
                                <span style={{ color: diff! >= 0 ? 'var(--green)' : 'var(--red)' }}>
                                  Δ {diff! >= 0 ? '+' : ''}{diff!.toFixed(2)}
                                </span>
                              </div>
                            ) : (
                              <p className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>
                                {displaySymbol && monitoredSymbols.has(displaySymbol) ? 'Warming up EMA data...' : 'Start monitoring to see live values'}
                              </p>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Alert History */}
            <div className="card !p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="section-label">
                  <Bell className="w-4 h-4" style={{ color: 'var(--amber)' }} />
                  Alerts
                </div>
                <span className="badge" style={{ background: 'rgba(251,191,36,0.12)', color: 'var(--amber)' }}>
                  {alerts.length}
                </span>
              </div>

              <div className="space-y-2.5 max-h-[450px] overflow-y-auto">
                {alerts.length === 0 ? (
                  <div className="text-center py-8" style={{ color: 'var(--text-muted)' }}>
                    <Bell className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    <p className="text-sm font-medium">No alerts yet</p>
                    <p className="text-xs mt-1 opacity-60">Crossover alerts will appear here when detected</p>
                  </div>
                ) : (
                  alerts.map((a) => (
                    <div key={a.id} className="p-4 rounded-xl" style={{
                      background: a.crossoverType === 'bullish' ? 'var(--green-bg)' : 'var(--red-bg)',
                      borderLeft: `3px solid ${a.crossoverType === 'bullish' ? 'var(--green)' : 'var(--red)'}`,
                    }}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          {a.crossoverType === 'bullish' ? (
                            <TrendingUp className="w-5 h-5 flex-shrink-0" style={{ color: 'var(--green)' }} />
                          ) : (
                            <TrendingDown className="w-5 h-5 flex-shrink-0" style={{ color: 'var(--red)' }} />
                          )}
                          <div>
                            <div className="font-bold text-sm" style={{ color: 'var(--text-primary)' }}>{a.symbol}</div>
                            <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                              EMA({a.fastPeriod}) {a.crossoverType === 'bullish' ? '↑ crossed above' : '↓ crossed below'} EMA({a.slowPeriod})
                            </div>
                          </div>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <div className="font-bold text-sm" style={{ color: 'var(--text-primary)' }}>{getCurrencySymbol(a.currency)}{a.price}</div>
                          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
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
        </div>
      </div>
    </div>
  );
}
