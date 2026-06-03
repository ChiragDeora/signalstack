'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Bell, Plus, TrendingUp, TrendingDown,
  Target, Search, Trash2, BarChart3, Zap,
  ArrowRight, Activity, Power, Wifi, WifiOff, RefreshCw, X, Pencil, Check, Mail, Download,
  Settings, ChevronDown, Sparkles,
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
  rsi?: RsiPayload;
}

interface RsiSignalFlags {
  overboughtCross: boolean;
  oversoldCross: boolean;
  thresholdBreach: boolean;
  centerlineCross: boolean;
  signalLineCross: boolean;
}

/** Server-side RSI config (numeric, validated). */
interface RsiPayload {
  enabled: boolean;
  period: number;
  overbought: number;
  oversold: number;
  signalLineLength?: number;
  signals: RsiSignalFlags;
}

/** UI form state for RSI. Strings allow empty inputs without forcing defaults. */
interface RsiUiConfig {
  enabled: boolean;
  period: string;
  overbought: string;
  oversold: string;
  signalLineLength: string;
  signals: RsiSignalFlags;
}

const RSI_DEFAULTS = {
  period: '14',
  overbought: '70',
  oversold: '30',
  signalLineLength: '14',
};

const DEFAULT_RSI_SIGNALS: RsiSignalFlags = {
  overboughtCross: false,
  oversoldCross: false,
  thresholdBreach: false,
  centerlineCross: false,
  signalLineCross: true,
};

/** Signal line cross first in the alerts list. */
const RSI_SIGNAL_ORDER: Array<keyof RsiSignalFlags> = [
  'signalLineCross',
  'overboughtCross',
  'oversoldCross',
  'thresholdBreach',
  'centerlineCross',
];

const EMPTY_RSI_UI: RsiUiConfig = {
  enabled: false,
  period: RSI_DEFAULTS.period,
  overbought: RSI_DEFAULTS.overbought,
  oversold: RSI_DEFAULTS.oversold,
  signalLineLength: RSI_DEFAULTS.signalLineLength,
  signals: { overboughtCross: false, oversoldCross: false, thresholdBreach: false, centerlineCross: false, signalLineCross: false },
};

interface RsiLive {
  value: number | null;
  period: number;
  warmupProgress: number;
}

interface RsiAlertData {
  id: string;
  type: 'rsi';
  symbol: string;
  timeframe: string;
  signalType: 'overboughtCross' | 'oversoldCross' | 'thresholdBreach' | 'centerlineCross';
  direction: 'bullish' | 'bearish';
  rsiValue: number;
  previousRsi: number;
  period: number;
  overbought: number;
  oversold: number;
  price: number;
  currency: string;
  timestamp: string;
  source: string;
}

const RSI_SIGNAL_LABELS: Record<keyof RsiSignalFlags, string> = {
  overboughtCross: 'Overbought cross',
  oversoldCross: 'Oversold cross',
  thresholdBreach: 'Threshold breach',
  centerlineCross: 'Centerline cross',
  signalLineCross: 'Signal line cross',
};

/** Verbose labels used only in the configuration form (not the alert list). */
const RSI_SIGNAL_LABELS_LONG: Record<keyof RsiSignalFlags, string> = {
  overboughtCross: 'Overbought cross (bearish)',
  oversoldCross: 'Oversold cross (bullish)',
  thresholdBreach: 'Threshold breach',
  centerlineCross: 'Centerline (50) cross',
  signalLineCross: 'Signal line cross (RSI vs its EMA)',
};

/** Validate UI inputs and produce the server payload. */
function buildRsiPayload(ui: RsiUiConfig): { ok: true; rsi?: RsiPayload } | { ok: false; error: string } {
  if (!ui.enabled) return { ok: true };
  const period = parseInt(ui.period.trim() || RSI_DEFAULTS.period, 10);
  const overbought = parseFloat(ui.overbought.trim() || RSI_DEFAULTS.overbought);
  const oversold = parseFloat(ui.oversold.trim() || RSI_DEFAULTS.oversold);
  if (!Number.isFinite(period) || period < 2 || period > 200) {
    return { ok: false, error: 'RSI period must be a number between 2 and 200' };
  }
  if (!Number.isFinite(overbought) || overbought <= 50 || overbought > 100) {
    return { ok: false, error: 'Overbought must be a number between 51 and 100' };
  }
  if (!Number.isFinite(oversold) || oversold < 0 || oversold >= 50) {
    return { ok: false, error: 'Oversold must be a number between 0 and 49' };
  }
  if (!Object.values(ui.signals).some(Boolean)) {
    return { ok: false, error: 'Pick at least one RSI signal to track' };
  }
  const payload: RsiPayload = { enabled: true, period, overbought, oversold, signals: ui.signals };
  if (ui.signals.signalLineCross) {
    const sigLen = parseInt(ui.signalLineLength.trim() || RSI_DEFAULTS.signalLineLength, 10);
    if (!Number.isFinite(sigLen) || sigLen < 2 || sigLen > 200) {
      return { ok: false, error: 'Signal line EMA length must be a number between 2 and 200' };
    }
    payload.signalLineLength = sigLen;
  }
  return { ok: true, rsi: payload };
}

function rsiPayloadToUi(p: RsiPayload | undefined): RsiUiConfig {
  if (!p || !p.enabled) return EMPTY_RSI_UI;
  return {
    enabled: true,
    period: String(p.period),
    overbought: String(p.overbought),
    oversold: String(p.oversold),
    signalLineLength: p.signalLineLength != null ? String(p.signalLineLength) : RSI_DEFAULTS.signalLineLength,
    signals: { ...p.signals },
  };
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
  // Lazy initializer pulls cached prices from localStorage so the UI shows
  // last-seen values instantly on page load (instead of staying blank during
  // the ~15s server-side warmup). Fresh socket updates overwrite them.
  const [priceByKey, setPriceByKey] = useState<Record<string, { price: number; change: number; changePercent: number; currency: string; source: string; lastUpdate: Date | null }>>(() => {
    if (typeof window === 'undefined') return {};
    try {
      const raw = window.localStorage.getItem('signalstack:priceByKey');
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, { price: number; change: number; changePercent: number; currency: string; source: string; lastUpdate: string | null }>;
      const restored: Record<string, { price: number; change: number; changePercent: number; currency: string; source: string; lastUpdate: Date | null }> = {};
      for (const [k, v] of Object.entries(parsed)) {
        restored[k] = { ...v, lastUpdate: v.lastUpdate ? new Date(v.lastUpdate) : null };
      }
      return restored;
    } catch { return {}; }
  });
  const [priceErrorByKey, setPriceErrorByKey] = useState<Record<string, string>>({});
  const [emaByKey, setEmaByKey] = useState<Record<string, Record<number, number | null>>>(() => {
    if (typeof window === 'undefined') return {};
    try {
      const raw = window.localStorage.getItem('signalstack:emaByKey');
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });
  const [warmupByKey, setWarmupByKey] = useState<Record<string, Record<number, number>>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchExchangeFilter, setSearchExchangeFilter] = useState<'ALL' | 'NSE' | 'NFO' | 'BSE'>('ALL');
  const [showSearch, setShowSearch] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [emasBySymbol, setEmasBySymbol] = useState<Record<string, EMA[]>>({});
  const [rsiBySymbol, setRsiBySymbol] = useState<Record<string, RsiUiConfig>>({});
  const [emaEnabledBySymbol, setEmaEnabledBySymbol] = useState<Record<string, boolean>>({});
  const [rsiByKey, setRsiByKey] = useState<Record<string, RsiLive>>(() => {
    if (typeof window === 'undefined') return {};
    try {
      const raw = window.localStorage.getItem('signalstack:rsiByKey');
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });
  const [rsiAlerts, setRsiAlerts] = useState<RsiAlertData[]>([]);
  const [rsiFormError, setRsiFormError] = useState<string | null>(null);
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
  const [showSearchMobile, setShowSearchMobile] = useState(true); // search panel visible by default on mobile
  const [showEmaConfig, setShowEmaConfig] = useState(false); // collapsed on mobile by default
  const [showSettings, setShowSettings] = useState(false); // header settings drawer
  const [replacingSymbol, setReplacingSymbol] = useState<string | null>(null);
  const [testEmailStatus, setTestEmailStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  const [testEmailMessage, setTestEmailMessage] = useState<string | null>(null);
  const [testPushStatus, setTestPushStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  const [testPushMessage, setTestPushMessage] = useState<string | null>(null);
  const [cleanupStatus, setCleanupStatus] = useState<'idle' | 'running' | 'success' | 'error'>('idle');
  const [cleanupMessage, setCleanupMessage] = useState<string | null>(null);
  const hasRestoredRef = useRef(false);
  const hasRestoredMonitoredRef = useRef(false);
  const [monitoringBusy, setMonitoringBusy] = useState(false);
  const [restoringWatches, setRestoringWatches] = useState(false);
  const { user: clerkUser } = useUser();
  const userId = clerkUser?.id ?? null;

  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);

  const getTimeframe = (sym: string) => timeframeBySymbol[sym] ?? DEFAULT_TIMEFRAME;
  const displaySymbol = selectedSymbol ?? symbols[0]?.symbol ?? null;
  const displayTimeframe = displaySymbol ? getTimeframe(displaySymbol) : DEFAULT_TIMEFRAME;
  const displayPrice = displaySymbol ? priceByKey[watchKey(displaySymbol, displayTimeframe)] : null;
  const displayPriceError = displaySymbol ? priceErrorByKey[watchKey(displaySymbol, displayTimeframe)] : undefined;
  const displayEmaValues = displaySymbol ? emaByKey[watchKey(displaySymbol, displayTimeframe)] ?? {} : {};
  const displayWarmupProgress = displaySymbol ? warmupByKey[watchKey(displaySymbol, displayTimeframe)] ?? {} : {};
  const _currency = displaySymbol ? (symbols.find((s) => s.symbol === displaySymbol)?.currency ?? 'INR') : 'INR';
  const emas = useMemo(
    () => (displaySymbol ? (emasBySymbol[displaySymbol] ?? []) : []),
    [displaySymbol, emasBySymbol]
  );
  const rsiUi = displaySymbol ? (rsiBySymbol[displaySymbol] ?? EMPTY_RSI_UI) : EMPTY_RSI_UI;
  const emaAlertsEnabled = displaySymbol ? (emaEnabledBySymbol[displaySymbol] ?? true) : true;
  const liveRsi = displaySymbol ? rsiByKey[watchKey(displaySymbol, displayTimeframe)] : undefined;

  const updateEmaEnabled = useCallback((enabled: boolean) => {
    if (!displaySymbol) return;
    setEmaEnabledBySymbol((prev) => ({ ...prev, [displaySymbol]: enabled }));
  }, [displaySymbol]);

  const updateRsi = useCallback((updater: (prev: RsiUiConfig) => RsiUiConfig) => {
    if (!displaySymbol) return;
    setRsiBySymbol((prev) => ({
      ...prev,
      [displaySymbol]: updater(prev[displaySymbol] ?? EMPTY_RSI_UI),
    }));
    setRsiFormError(null);
  }, [displaySymbol]);

  useEffect(() => { setMounted(true); }, []);

  // Persist priceByKey / emaByKey / rsiByKey to localStorage so the next page
  // load shows last-seen values instantly (instead of going blank during the
  // ~15s server-side warmup). Debounced to avoid storage thrash.
  const cachePersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!mounted) return;
    if (cachePersistTimerRef.current) clearTimeout(cachePersistTimerRef.current);
    cachePersistTimerRef.current = setTimeout(() => {
      try {
        window.localStorage.setItem('signalstack:priceByKey', JSON.stringify(priceByKey));
        window.localStorage.setItem('signalstack:emaByKey', JSON.stringify(emaByKey));
        window.localStorage.setItem('signalstack:rsiByKey', JSON.stringify(rsiByKey));
      } catch { /* quota or disabled */ }
    }, 500);
    return () => { if (cachePersistTimerRef.current) clearTimeout(cachePersistTimerRef.current); };
  }, [mounted, priceByKey, emaByKey, rsiByKey]);

  // Refresh modal: show on load, hide when connected and monitoring ready (min 1.5s), or after 4s max
  useEffect(() => {
    const minT = setTimeout(() => setRefreshModalMinTimeElapsed(true), 1500);
    return () => { clearTimeout(minT); };
  }, []);
  useEffect(() => {
    if (!refreshModalMinTimeElapsed) return;
    const hasAnyPrice = Object.keys(priceByKey).length > 0;
    if (hasAnyPrice || symbols.length === 0) {
      setShowRefreshModal(false);
    }
  }, [refreshModalMinTimeElapsed, priceByKey, symbols.length]);

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
    setRestoringWatches(true);
    axios
      .get<{ success: boolean; watches?: MonitoredWatch[] }>('/api/user/watches')
      .then(async (res) => {
        const watches = res.data.success && Array.isArray(res.data.watches) ? res.data.watches : [];
        if (watches.length === 0) return;
        setMonitorStatus('Restoring monitoring...');

        // Hydrate RSI + EMA alert UI state from persisted watches
        const rsiMap: Record<string, RsiUiConfig> = {};
        const emaEnabledMap: Record<string, boolean> = {};
        for (const w of watches) {
          if (w.rsi) rsiMap[w.symbol] = rsiPayloadToUi(w.rsi);
          emaEnabledMap[w.symbol] = w.trackBullish || w.trackBearish;
        }
        if (Object.keys(rsiMap).length > 0) {
          setRsiBySymbol((prev) => ({ ...rsiMap, ...prev }));
        }
        if (Object.keys(emaEnabledMap).length > 0) {
          setEmaEnabledBySymbol((prev) => ({ ...emaEnabledMap, ...prev }));
        }

        const restored: string[] = [];
        for (const w of watches) {
          try {
            // Check if the server already has this watch running (warm EMAs)
            // to avoid destroying EMA state with a redundant POST on every refresh.
            const emaCheck = await axios.get<{ emas?: Record<number, number | null>; warmupProgress?: Record<number, number> }>(
              `/api/ema-status?symbol=${encodeURIComponent(w.symbol)}&timeframe=${encodeURIComponent(w.timeframe)}`
            );
            const hasWarmEmas = emaCheck.data?.emas && Object.values(emaCheck.data.emas).some((v) => v != null);
            if (hasWarmEmas) {
              // Watch is already running server-side — just mark as monitored locally
              restored.push(w.symbol);
              continue;
            }
            // Watch not running — start it
            const r = await axios.post('/api/monitor', {
              symbol: w.symbol,
              timeframe: w.timeframe,
              emaPeriods: w.emaPeriods,
              trackBullish: w.trackBullish,
              trackBearish: w.trackBearish,
              exchange: w.exchange,
              currency: w.currency,
              rsi: w.rsi,
            });
            if (r.data.success) restored.push(w.symbol);
          } catch { /* skip failed */ }
        }
        if (restored.length > 0) {
          setMonitoredSymbols((prev) => new Set([...prev, ...restored]));
        }
        setMonitorStatus('');
      })
      .catch(() => { })
      .finally(() => {
        setRestoringWatches(false);
      });
  }, [mounted, userId]);

  // ===================================
  // SOCKET.IO
  // ===================================
  const pendingPriceRef = useRef<Record<string, { price: number; change: number; changePercent: number; currency: string; source: string; lastUpdate: Date }>>({});
  const pendingEmaRef = useRef<Record<string, { emas: Record<number, number | null>; warmup: Record<number, number>; rsi?: RsiLive }>>({});
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushSocketUpdates = useCallback(() => {
    if (Object.keys(pendingPriceRef.current).length > 0) {
      const batch = pendingPriceRef.current;
      pendingPriceRef.current = {};
      setPriceByKey((prev) => ({ ...prev, ...batch }));
      // Clear any fetch-price errors for keys that now have live data
      setPriceErrorByKey((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const key of Object.keys(batch)) {
          if (next[key]) { delete next[key]; changed = true; }
        }
        return changed ? next : prev;
      });
    }
    if (Object.keys(pendingEmaRef.current).length > 0) {
      const batch = pendingEmaRef.current;
      pendingEmaRef.current = {};
      const emaUpdates: Record<string, Record<number, number | null>> = {};
      const warmupUpdates: Record<string, Record<number, number>> = {};
      const rsiUpdates: Record<string, RsiLive> = {};
      for (const [k, v] of Object.entries(batch)) {
        warmupUpdates[k] = v.warmup;
        const hasEmaValues = Object.keys(v.emas).some((p) => v.emas[Number(p)] != null);
        if (hasEmaValues) emaUpdates[k] = v.emas;
        if (v.rsi) rsiUpdates[k] = v.rsi;
      }
      setEmaByKey((prev) => (Object.keys(emaUpdates).length > 0 ? { ...prev, ...emaUpdates } : prev));
      setWarmupByKey((prev) => ({ ...prev, ...warmupUpdates }));
      if (Object.keys(rsiUpdates).length > 0) {
        setRsiByKey((prev) => ({ ...prev, ...rsiUpdates }));
      }
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
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      timeout: 20000,
    });
    socketRef.current = socket;
    socket.on('connect', () => {
      setConnected(true);
      // Join user-specific room so we only receive our own updates
      if (userId) socket.emit('join:user', userId);
    });
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
      if (data.rsi) pendingEmaRef.current[key].rsi = data.rsi;
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
    socket.on('alert:rsi', (alert: RsiAlertData) => {
      setRsiAlerts((prev) => [alert, ...prev].slice(0, 100));
      if ('Notification' in window && Notification.permission === 'granted') {
        const emoji = alert.direction === 'bullish' ? '📈' : '📉';
        new Notification(`${emoji} ${alert.symbol} RSI ${alert.signalType}`, {
          body: `RSI(${alert.period}) = ${alert.rsiValue} (${alert.direction}) at ${getCurrencySymbol(alert.currency)}${alert.price}`,
          icon: '/signalstack-logo.png',
          tag: `rsi-${alert.id}`,
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
  }, [scheduleFlush, flushSocketUpdates, userId]);

  // Join user room when userId becomes available (Clerk loads async after socket connects)
  useEffect(() => {
    if (userId && socketRef.current?.connected) {
      socketRef.current.emit('join:user', userId);
    }
  }, [userId]);

  // Fetch persisted alerts from server on mount
  useEffect(() => {
    if (!mounted || !userId) return;
    axios.get<{ success: boolean; alerts?: AlertData[]; count?: number }>('/api/alerts')
      .then((res) => {
        if (res.data.success && Array.isArray(res.data.alerts) && res.data.alerts.length > 0) {
          setAlerts(res.data.alerts);
          console.log(`[EMAAlertSystem] Restored ${res.data.alerts.length} alert(s) from server`);
        }
      })
      .catch((err: any) => {
        console.warn('[EMAAlertSystem] Failed to load alerts:', err.response?.status, err.message);
      });
  }, [mounted, userId]);

  // Poll EMA status when monitoring and socket may not deliver (e.g. mobile, deploy without persistent WS)
  useEffect(() => {
    const symbol = displaySymbol;
    const timeframe = displayTimeframe;
    if (!symbol || !monitoredSymbols.has(symbol)) return;

    const key = watchKey(symbol, timeframe);
    const poll = async () => {
      try {
        const { data } = await axios.get<{ emas: Record<number, number | null>; warmupProgress: Record<number, number>; rsi?: RsiLive }>(
          `/api/ema-status?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`
        );
        if (data?.emas && Object.keys(data.emas).length > 0) {
          setEmaByKey((prev) => ({ ...prev, [key]: { ...prev[key], ...data.emas } }));
        }
        if (data?.warmupProgress && Object.keys(data.warmupProgress).length > 0) {
          setWarmupByKey((prev) => ({ ...prev, [key]: { ...prev[key], ...data.warmupProgress } }));
        }
        if (data?.rsi) {
          setRsiByKey((prev) => ({ ...prev, [key]: data.rsi! }));
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

  const getOptionMeta = (sym: string, exchange?: string): { isOption: boolean; side: 'CE' | 'PE' | null } => {
    // Only treat as option for NFO instruments (we no longer infer expiry here)
    if (exchange && exchange !== 'NFO') {
      return { isOption: false, side: null };
    }
    const upper = sym.toUpperCase();
    const isCE = upper.endsWith('CE');
    const isPE = upper.endsWith('PE');
    const isOption = isCE || isPE;
    return { isOption, side: isCE ? 'CE' : isPE ? 'PE' : null };
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
      const q = query.trim();
      if (filter === 'NSE' || filter === 'NFO' || filter === 'BSE') {
        const res = await axios.post<{ success: boolean; results: SearchResult[] }>(`/api/search-symbols/${filter.toLowerCase()}`, { query: q });
        if (res.data.success) { setSearchResults(res.data.results); setShowSearch(true); }
        else setSearchResults([]);
      } else {
        const settled = await Promise.allSettled([
          axios.post<{ success: boolean; results: SearchResult[] }>('/api/search-symbols/nse', { query: q }),
          axios.post<{ success: boolean; results: SearchResult[] }>('/api/search-symbols/nfo', { query: q }),
          axios.post<{ success: boolean; results: SearchResult[] }>('/api/search-symbols/bse', { query: q }),
        ]);
        const seen = new Set<string>();
        const merged: SearchResult[] = [];
        for (const s of settled) {
          if (s.status !== 'fulfilled' || !s.value?.data?.success || !Array.isArray(s.value.data.results)) continue;
          for (const r of s.value.data.results) {
            const key = `${r.exchange || 'NSE'}:${r.symbol}`;
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(r);
          }
        }
        setSearchResults(merged.slice(0, 30));
        setShowSearch(true);
      }
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
    const toReplace = replacingSymbol;
    const isReplace = toReplace != null;
    const isDuplicate = symbols.some((s) => s.symbol.toUpperCase() === result.symbol.toUpperCase());
    if (isDuplicate && !isReplace) {
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
    if (isReplace && toReplace) {
      const sym = toReplace;
      const tf = getTimeframe(sym);
      if (monitoredSymbols.has(sym)) {
        try {
          await axios.delete('/api/monitor', { data: { symbol: sym, timeframe: tf } });
        } catch { /* ignore */ }
        setMonitoredSymbols((prev) => { const next = new Set(prev); next.delete(sym); return next; });
      }
      const key = watchKey(sym, tf);
      setPriceByKey((prev) => { const next = { ...prev }; delete next[key]; return next; });
      setEmaByKey((prev) => { const next = { ...prev }; delete next[key]; return next; });
      setWarmupByKey((prev) => { const next = { ...prev }; delete next[key]; return next; });
      setTimeframeBySymbol((prev) => { const next = { ...prev }; delete next[sym]; return next; });
      setEmasBySymbol((prev) => { const next = { ...prev }; delete next[sym]; return next; });
      setReplacingSymbol(null);
    }
    setSymbols((prev) =>
      isReplace && toReplace
        ? prev.filter((s) => s.symbol !== toReplace).concat([newEntry])
        : [...prev, newEntry]
    );
    setTimeframeBySymbol((prev) => ({ ...prev, [result.symbol]: DEFAULT_TIMEFRAME }));
    setEmasBySymbol((prev) => ({
      ...prev,
      [result.symbol]: prev[result.symbol] ?? [],
    }));
    setSearchQuery('');
    setShowSearch(false);
    setShowSearchMobile(false);
    setSelectedSymbol(result.symbol);
    if (userId) {
      axios.post('/api/user/watchlist', { symbol: result.symbol }).catch(() => { });
      if (isReplace && toReplace) {
        axios.delete('/api/user/watchlist', { params: { symbol: toReplace } }).catch(() => { });
      }
    }
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
    if (userId) {
      axios.delete('/api/user/watchlist', { params: { symbol: sym } }).catch(() => { });
    }
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

  const fetchPrice = useCallback(async (sym: string, tf: string, exchange?: string, skipLoading?: boolean) => {
    if (!sym) return;
    const exch = exchange ?? getExchange(sym);
    if (!skipLoading) setIsFetchingPrice(true);
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
        setPriceErrorByKey((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      } else {
        const key = watchKey(sym, tf);
        const msg: string =
          typeof res.data?.error === 'string' && res.data.error.length > 0
            ? res.data.error
            : 'No price/EMA data available for this symbol and timeframe (contract may be expired or illiquid).';
        setPriceErrorByKey((prev) => ({ ...prev, [key]: msg }));
      }
    } catch { /* ignore */ } finally { if (!skipLoading) setIsFetchingPrice(false); }
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
    const list = symbolsRef.current;
    const tfBySym = timeframeBySymbolRef.current;
    const previousKey = lastFetchedRef.current;
    const previousMap: Record<string, string> = previousKey
      ? Object.fromEntries(
          previousKey.split(',').filter(Boolean).map((part) => {
            const i = part.indexOf(':');
            return [part.slice(0, i), part.slice(i + 1)];
          })
        )
      : {};
    const toFetch = list.filter((s) => {
      const tf = tfBySym[s.symbol] ?? DEFAULT_TIMEFRAME;
      const prev = previousMap[s.symbol];
      return prev === undefined || prev !== tf;
    });
    lastFetchedRef.current = timeframeFetchKey;
    if (toFetch.length === 0) return;
    setIsFetchingPrice(true);
    Promise.all(
      toFetch.map((s) => fetchPrice(s.symbol, tfBySym[s.symbol] ?? DEFAULT_TIMEFRAME, s.exchange, true))
    ).finally(() => setIsFetchingPrice(false));
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
    if (monitoredSymbols.has(displaySymbol)) {
      stopMonitoringForSymbol(displaySymbol);
      setMonitorStatus('Monitoring stopped — start again to apply EMA change');
      setTimeout(() => setMonitorStatus(''), 4000);
    }
  };
  const removeEma = (id: number) => {
    if (!displaySymbol) return;
    const current = emasBySymbol[displaySymbol] ?? [];
    const nextEmas = current.filter((e) => e.id !== id);
    setEmasBySymbol((prev) => ({
      ...prev,
      [displaySymbol]: nextEmas,
    }));
    if (monitoredSymbols.has(displaySymbol)) {
      stopMonitoringForSymbol(displaySymbol);
      setMonitorStatus('Monitoring stopped — start again to apply EMA change');
      setTimeout(() => setMonitorStatus(''), 4000);
    }
  };

  const startMonitoringForSymbol = async (sym: string) => {
    if (restoringWatches) {
      setMonitorStatus('Restoring existing monitoring from server — please wait until this finishes before changing monitors.');
      return;
    }
    if (monitoringBusy) {
      setMonitorStatus('Monitoring is already starting — please wait until it finishes before pressing the button again.');
      return;
    }
    const symbolEmas = emasBySymbol[sym] ?? [];
    const emaOn = emaEnabledBySymbol[sym] ?? true;
    const symRsiUi = rsiBySymbol[sym] ?? EMPTY_RSI_UI;
    const rsiCheck = buildRsiPayload(symRsiUi);
    const rsiOn = symRsiUi.enabled && rsiCheck.ok && !!rsiCheck.rsi;
    if (!emaOn && !rsiOn) {
      setMonitorStatus(`${sym}: enable EMA alerts, RSI alerts, or both.`);
      return;
    }
    if (emaOn && symbolEmas.length < 2) {
      setMonitorStatus(`${sym}: add at least 2 EMAs for crossover alerts.`);
      return;
    }
    if (!rsiCheck.ok) {
      setRsiFormError(rsiCheck.error);
      setMonitorStatus(`${sym}: ${rsiCheck.error}`);
      return;
    }
    const s = symbols.find((x) => x.symbol === sym);
    if (!s) return;
    const tf = getTimeframe(sym);
    try {
      setMonitoringBusy(true);
      const alertParts = [emaOn && 'EMA', rsiOn && 'RSI'].filter(Boolean).join(' + ');
      setMonitorStatus(`Starting ${sym} (${alertParts}) — loading history and warming indicators. This can take 20–30 seconds.`);
      const res = await axios.post('/api/monitor', {
        symbol: s.symbol,
        timeframe: tf,
        emaPeriods: symbolEmas.map((e) => e.period),
        trackBullish: emaOn ? trackBullish : false,
        trackBearish: emaOn ? trackBearish : false,
        exchange: s.exchange || 'NSE',
        currency: s.currency,
        rsi: rsiCheck.rsi,
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
    } finally {
      setMonitoringBusy(false);
    }
  };

  /**
   * Stop monitoring only for the currently selected symbol when alert-mode
   * switches (Bullish/Bearish). Other symbols keep running with their
   * existing server-side settings until changed individually.
   */
  const stopAllMonitoringFromConfigChange = useCallback(() => {
    if (!displaySymbol || !monitoredSymbols.has(displaySymbol)) return;
    const sym = displaySymbol;
    const tf = getTimeframe(sym);
    axios.delete('/api/monitor', { data: { symbol: sym, timeframe: tf } }).catch(() => { });
    const key = watchKey(sym, tf);
    setPriceByKey((prev) => { const n = { ...prev }; delete n[key]; return n; });
    setEmaByKey((prev) => { const n = { ...prev }; delete n[key]; return n; });
    setWarmupByKey((prev) => { const n = { ...prev }; delete n[key]; return n; });
    setMonitoredSymbols((prev) => {
      const next = new Set(prev);
      next.delete(sym);
      return next;
    });
    if (userId) refetchWatches();
    setMonitorStatus('Monitoring stopped for this symbol — start again to apply alert settings');
    setTimeout(() => setMonitorStatus(''), 4000);
  }, [displaySymbol, monitoredSymbols, getTimeframe, userId]);

  const _startMonitoring = async () => {
    if (restoringWatches) {
      setMonitorStatus('Restoring existing monitoring from server — please wait until this finishes before changing monitors.');
      return;
    }
    if (monitoringBusy) {
      setMonitorStatus('Monitoring is already starting — please wait until it finishes before pressing the button again.');
      return;
    }
    if (symbols.length === 0) {
      alert('Add at least one symbol');
      return;
    }
    try {
      setMonitoringBusy(true);
      setMonitorStatus('Starting monitoring for all symbols — loading up to 90 days of history and warming EMAs. This can take 20–30 seconds.');
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
    } finally {
      setMonitoringBusy(false);
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
      axios.put('/api/user/config', { symbols: [], timeframeBySymbol: {}, emasBySymbol: {}, trackBullish: true, trackBearish: true, selectedSymbol: null }).catch(() => { });
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

  type CombinedAlert =
    | { kind: 'crossover'; data: AlertData }
    | { kind: 'rsi'; data: RsiAlertData };
  const combinedAlerts = useMemo<CombinedAlert[]>(() => {
    const xs: CombinedAlert[] = [];
    for (const a of alerts) xs.push({ kind: 'crossover', data: a });
    for (const a of rsiAlerts) xs.push({ kind: 'rsi', data: a });
    xs.sort((a, b) => new Date(b.data.timestamp).getTime() - new Date(a.data.timestamp).getTime());
    return xs.slice(0, 200);
  }, [alerts, rsiAlerts]);

  const runCleanup = async () => {
    if (cleanupStatus === 'running') return;
    const ok = window.confirm(
      "Clean up your account?\n\nThis removes duplicate symbol entries (e.g. \"NIFTY 50\" + \"Nifty 50\") and stops any orphaned watches that aren't in your current symbol list.\n\nSafe and reversible — duplicates just take the entry with more EMAs configured.",
    );
    if (!ok) return;
    setCleanupStatus('running');
    setCleanupMessage(null);
    try {
      const res = await axios.post<{ success: boolean; duplicatesRemoved?: string[]; orphansStopped?: string[]; error?: string }>(
        '/api/user/cleanup',
        {},
      );
      if (res.data.success) {
        const dups = res.data.duplicatesRemoved ?? [];
        const orphans = res.data.orphansStopped ?? [];
        if (dups.length === 0 && orphans.length === 0) {
          setCleanupStatus('success');
          setCleanupMessage('Nothing to clean — your account is already tidy.');
        } else {
          const parts: string[] = [];
          if (dups.length > 0) parts.push(`Removed ${dups.length} duplicate(s): ${dups.join(', ')}`);
          if (orphans.length > 0) parts.push(`Stopped ${orphans.length} orphan watch(es): ${orphans.join(', ')}`);
          setCleanupStatus('success');
          setCleanupMessage(parts.join(' · '));
          // Refresh local state to reflect the cleanup
          if (userId) refetchWatches();
          hasRestoredRef.current = false;
          hasRestoredMonitoredRef.current = false;
        }
        setTimeout(() => { setCleanupStatus('idle'); setCleanupMessage(null); }, 10000);
      } else {
        setCleanupStatus('error');
        setCleanupMessage(res.data.error ?? 'Cleanup failed');
        setTimeout(() => { setCleanupStatus('idle'); setCleanupMessage(null); }, 6000);
      }
    } catch (err: any) {
      setCleanupStatus('error');
      setCleanupMessage(err?.response?.data?.error ?? err?.message ?? 'Cleanup failed');
      setTimeout(() => { setCleanupStatus('idle'); setCleanupMessage(null); }, 6000);
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
    <div className="min-h-screen overflow-x-hidden safe-area-inset">
      {/* Refresh modal: shown on load until data is ready */}
      {showRefreshModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(6px)' }}
          aria-modal="true"
          role="alertdialog"
          aria-live="polite"
        >
          <div
            className="max-w-sm w-full rounded-2xl p-6 text-center shadow-2xl border border-[var(--border-subtle)]"
            style={{ backgroundColor: 'var(--bg-card)' }}
          >
            <RefreshCw className="w-10 h-10 mx-auto mb-4 animate-spin opacity-80" style={{ color: 'var(--accent)' }} />
            <h3 className="font-semibold text-base mb-2" style={{ color: 'var(--text-primary)' }}>
              Preparing your EMA watches
            </h3>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              This can take a bit while we fetch up to 90 days of price data and warm up EMAs for all your symbols. Please wait until this finishes.
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
                <p className="text-[11px] sm:text-xs font-semibold tracking-wider uppercase" style={{ color: 'var(--text-muted)' }}>EMA + RSI Alerts</p>
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
          {/* Row 2: compact status strip — Live + Alerts toggle + Settings toggle */}
          <div className="flex items-center gap-2 mt-3 min-w-0">
            <div
              className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-full border flex-shrink-0 ${connected ? 'border-green-600/30 text-green-700' : 'border-red-600/30 text-red-700'}`}
              style={{ background: connected ? 'var(--green-bg)' : 'var(--red-bg)' }}
              title={connected ? 'Real-time updates connected' : 'Not connected to the Node server.'}
            >
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${connected ? 'bg-green-500 anim-live' : 'bg-red-500'}`} />
              <span>{connected ? 'Live' : 'Offline'}</span>
            </div>

            {mounted && 'serviceWorker' in navigator && pushAvailable !== false && (
              <button
                type="button"
                onClick={pushEnabled ? disablePush : enablePush}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-semibold flex-shrink-0"
                style={{
                  borderColor: pushEnabled ? 'rgba(22,163,74,0.5)' : 'var(--border-subtle)',
                  background: pushEnabled ? 'var(--green-bg)' : 'transparent',
                  color: pushEnabled ? 'var(--green)' : 'var(--text-secondary)',
                }}
                title={pushEnabled ? 'Notifications on — tap to turn off' : 'Tap to enable browser + email notifications'}
                aria-pressed={pushEnabled}
              >
                <Bell className="w-3.5 h-3.5" />
                <span>{pushEnabled ? 'Notifications on' : 'Notifications off'}</span>
              </button>
            )}

            {mounted && pushAvailable === false && (
              <span className="text-[11px] px-2 py-1 rounded-full border border-amber-600/30 text-amber-700 flex-shrink-0" title="Server is missing VAPID keys">
                Alerts unavailable
              </span>
            )}

            <div className="flex-1" />

            {userId && (
              <button
                type="button"
                onClick={() => setShowSettings((s) => !s)}
                aria-expanded={showSettings}
                aria-controls="header-tools-drawer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-semibold flex-shrink-0"
                style={{
                  borderColor: showSettings ? 'var(--accent)' : 'var(--border-subtle)',
                  color: showSettings ? 'var(--accent)' : 'var(--text-secondary)',
                  background: showSettings ? 'rgba(14,165,233,0.06)' : 'transparent',
                }}
                title="Tools: test alerts, download log"
              >
                <Settings className="w-3.5 h-3.5" />
                <span>Tools</span>
                <ChevronDown className={`w-3 h-3 transition-transform ${showSettings ? 'rotate-180' : ''}`} />
              </button>
            )}
          </div>
        </header>

        {/* Tools drawer — test buttons, alert log download */}
        {userId && showSettings && (
          <div
            id="header-tools-drawer"
            className="card !p-3 sm:!p-4 mb-3 sm:mb-4 anim-fade-up"
          >
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              <button
                type="button"
                onClick={sendTestEmail}
                disabled={testEmailStatus === 'sending'}
                className="tool-tile"
                title="Send a test email to verify delivery"
              >
                <Mail className="w-4 h-4" style={{ color: 'var(--accent)' }} />
                <span>{testEmailStatus === 'sending' ? 'Sending…' : testEmailStatus === 'success' ? 'Email sent' : testEmailStatus === 'error' ? 'Email failed' : 'Test email'}</span>
              </button>
              <button
                type="button"
                onClick={() => sendTestPush(0)}
                disabled={testPushStatus === 'sending' || !pushEnabled}
                className="tool-tile"
                title={pushEnabled ? 'Send a test push notification now' : 'Enable notifications first'}
              >
                <Bell className="w-4 h-4" style={{ color: 'var(--accent)' }} />
                <span>Test push now</span>
              </button>
              <button
                type="button"
                onClick={() => sendTestPush(60)}
                disabled={testPushStatus === 'sending' || !pushEnabled}
                className="tool-tile"
                title="Send a test push in 1 minute (verify with browser closed)"
              >
                <Bell className="w-4 h-4" style={{ color: 'var(--accent)' }} />
                <span>Test push later</span>
              </button>
              <a
                href="/api/alert-log"
                download
                className="tool-tile"
                title="Download crossover alert log (xlsx)"
              >
                <Download className="w-4 h-4" style={{ color: 'var(--accent)' }} />
                <span>Download log</span>
              </a>
              <button
                type="button"
                onClick={runCleanup}
                disabled={cleanupStatus === 'running'}
                className="tool-tile"
                title="Remove duplicate symbol entries and stop orphan watches"
              >
                <Sparkles className="w-4 h-4" style={{ color: 'var(--purple)' }} />
                <span>
                  {cleanupStatus === 'running' ? 'Cleaning…' : cleanupStatus === 'success' ? 'Cleaned!' : cleanupStatus === 'error' ? 'Failed' : 'Tidy account'}
                </span>
              </button>
            </div>
            {(testEmailMessage || testPushMessage || cleanupMessage) && (
              <div className="mt-3 text-[11px] leading-snug space-y-1" style={{ color: 'var(--text-muted)' }}>
                {testEmailMessage && <div>Email: {testEmailMessage}</div>}
                {testPushMessage && <div>Push: {testPushMessage}</div>}
                {cleanupMessage && <div>Cleanup: {cleanupMessage}</div>}
              </div>
            )}
          </div>
        )}

        {/* ─── MONITORING / STATUS BANNER — subtle pill-style strip ─── */}
        {(isMonitoring || monitorStatus) && (
          <div className="mb-3 sm:mb-4 px-3 py-2 rounded-lg flex items-center justify-between gap-2 border"
            style={{ background: 'var(--bg-card)', borderColor: 'var(--border-subtle)' }}>
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <span className="relative flex-shrink-0 w-2 h-2">
                <span className="absolute inset-0 w-2 h-2 bg-green-500 rounded-full" />
                <span className="absolute inset-0 w-2 h-2 bg-emerald-400 rounded-full animate-ping" />
              </span>
              <span className="text-xs font-medium truncate" style={{ color: 'var(--text-secondary)' }}>
                {monitorStatus || `Monitoring ${monitoredSymbols.size} symbol${monitoredSymbols.size === 1 ? '' : 's'}`}
              </span>
            </div>
            {isMonitoring && (
              <button
                onClick={stopMonitoring}
                className="flex-shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold"
                style={{ color: 'var(--red)' }}
                title="Stop monitoring all symbols"
              >
                <Power className="w-3 h-3" />
                <span>Stop all</span>
              </button>
            )}
          </div>
        )}

        {/* ─── SEARCH BAR + EXCHANGE FILTER (mobile can be collapsed; always visible on desktop) ─── */}
        <div
          className={`mb-3 sm:mb-4 ${showSearchMobile ? 'block' : 'hidden sm:block'} ${showSearch && searchResults.length > 0 ? 'relative z-[100]' : ''}`}
        >
          <div className="card !p-3 sm:!p-4" ref={searchContainerRef}>
            <div className="flex flex-col sm:flex-row gap-2 sm:gap-2 sm:items-center">
              <div className="relative min-w-0 w-full sm:w-[75%]">
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); debouncedSearch(e.target.value); }}
                  onFocus={() => { if (searchResults.length > 0) setShowSearch(true); }}
                  onBlur={() => { setTimeout(() => setShowSearch(false), 180); }}
                  className={`input-field !py-2.5 sm:!py-3 text-sm sm:text-base font-semibold w-full ${searchQuery.trim().length > 0 ? 'pr-9' : 'pr-10'}`}
                  placeholder="Search symbols (e.g. RELIANCE)"
                  aria-autocomplete="list"
                  aria-controls={showSearch && searchResults.length > 0 ? 'search-results-listbox' : undefined}
                />
                {searchQuery.trim().length > 0 ? (
                  <button
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); setSearchQuery(''); setShowSearch(false); setSearchResults([]); searchInputRef.current?.focus(); }}
                    className="absolute right-2.5 sm:right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-full hover:bg-black/5 z-10"
                    style={{ color: 'var(--text-muted)' }}
                    aria-label="Clear search"
                  >
                    <X className="w-4 h-4 sm:w-5 sm:h-5" />
                  </button>
                ) : (
                  <Search className={`absolute right-3 sm:right-4 top-1/2 -translate-y-1/2 w-4 h-4 sm:w-5 sm:h-5 pointer-events-none ${isSearching ? 'animate-spin' : ''}`} style={{ color: 'var(--text-muted)' }} />
                )}
              </div>
              <div className="flex flex-row items-center gap-2 w-full sm:w-[25%] min-w-0">
                <label htmlFor="search-exchange-filter" className="text-[10px] sm:text-xs font-medium uppercase tracking-wide flex-shrink-0 whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                  Exchange
                </label>
                <select
                  id="search-exchange-filter"
                  value={searchExchangeFilter}
                  onChange={(e) => { const v = e.target.value as 'ALL' | 'NSE' | 'NFO' | 'BSE'; setSearchExchangeFilter(v); if (searchQuery.trim()) debouncedSearch(searchQuery); }}
                  className="input-field !py-2 sm:!py-3 text-sm font-medium rounded-lg cursor-pointer w-full min-w-0 flex-1"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
                  title="Filter search results by exchange (All, NSE, NFO, BSE)"
                  aria-label="Filter search by exchange"
                >
                  <option value="ALL">All</option>
                  <option value="NSE">NSE</option>
                  <option value="NFO">NFO</option>
                  <option value="BSE">BSE</option>
                </select>
                {/* Close search / collapse search panel on mobile */}
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); setShowSearch(false); setShowSearchMobile(false); setSearchQuery(''); setSearchResults([]); }}
                  className="sm:hidden p-2 rounded-lg flex-shrink-0 touch-manipulation"
                  style={{ color: 'var(--text-muted)' }}
                  aria-label="Close search"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="relative">
              {showSearch && searchResults.length > 0 && (
                <div id="search-results-listbox" className="absolute top-full left-0 right-0 mt-2 search-drop max-h-64 overflow-y-auto z-[110] rounded-xl shadow-xl" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }} role="listbox">
                  {searchResults.length > 0 ? (
                    searchResults.map((r, i) => (
                      <button
                        key={`${r.symbol}-${r.exchange || ''}-${i}`}
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => { addSymbol(r); setShowSearchMobile(false); }}
                        className="w-full px-4 py-3 text-left transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-slate-100"
                        style={{ borderBottom: '1px solid var(--border-subtle)' }}
                        role="option"
                        aria-selected={false}
                      >
                        <div className="flex justify-between items-center gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="font-bold text-sm truncate" style={{ color: 'var(--accent)' }}>{r.symbol}</span>
                              {(() => {
                                const meta = getOptionMeta(r.symbol, r.exchange);
                                if (!meta.isOption || !meta.side) return null;
                                return (
                                  <span
                                    className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full flex-shrink-0"
                                    style={{
                                      background: meta.side === 'CE' ? 'rgba(59,130,246,0.15)' : 'rgba(248,113,113,0.15)',
                                      color: meta.side === 'CE' ? '#1d4ed8' : '#b91c1c',
                                    }}
                                  >
                                    {meta.side}
                                  </span>
                                );
                              })()}
                            </div>
                            <span className="text-xs sm:text-sm block mt-0.5 truncate" style={{ color: 'var(--text-secondary)' }}>{r.name}</span>
                          </div>
                          <div className="text-right flex flex-col items-end gap-0.5 flex-shrink-0">
                            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                              style={{ background: 'rgba(251,191,36,0.15)', color: 'var(--amber)' }}>
                              {r.exchange}
                            </span>
                            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{r.currency}</span>
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
        </div>

        {/* ─── SYMBOL PICKER (mobile: dropdown, desktop: tabs) ─── */}
        {/* Mobile: single dropdown + actions, no horizontal scroll */}
        <div className="card mb-4 !p-3 sm:hidden">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium uppercase tracking-wide flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                Symbol
              </span>
              <div className="flex-1 min-w-0">
                {symbols.length === 0 ? (
                  <button
                    type="button"
                    onClick={() => { setShowSearchMobile(true); setShowSearch(true); queueMicrotask(() => searchInputRef.current?.focus()); }}
                    className="input-field flex items-center justify-between gap-2 text-sm font-semibold"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <Plus className="w-4 h-4" />
                      Add symbol
                    </span>
                  </button>
                ) : (
                  <select
                    className="input-field text-sm font-semibold"
                    value={displaySymbol ?? symbols[0].symbol}
                    onChange={(e) => setSelectedSymbol(e.target.value)}
                  >
                    {symbols.map((s) => (
                      <option key={s.symbol} value={s.symbol}>
                        {s.symbol}
                        {s.exchange ? ` · ${s.exchange}` : ''}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>
            <div className="flex items-center justify-end gap-1.5 sm:gap-2">
              <button
                type="button"
                onClick={() => { setShowSearch(true); setShowSearchMobile(true); setReplacingSymbol(null); queueMicrotask(() => searchInputRef.current?.focus()); }}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold min-h-[40px]"
                style={{ background: 'var(--accent)', color: '#fff' }}
                title="Add new symbol"
                aria-label="Add new symbol"
              >
                <Plus className="w-4 h-4" />
                <span>Add</span>
              </button>
              {symbols.length > 0 && displaySymbol && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setShowSearch(true);
                      setShowSearchMobile(true);
                      setReplacingSymbol(displaySymbol);
                      queueMicrotask(() => searchInputRef.current?.focus());
                    }}
                    className="inline-flex items-center justify-center w-10 h-10 rounded-lg border"
                    style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                    title={`Replace ${displaySymbol} with another symbol`}
                    aria-label={`Replace ${displaySymbol}`}
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => displaySymbol && removeSymbol(displaySymbol)}
                    className="inline-flex items-center justify-center w-10 h-10 rounded-lg border"
                    style={{ borderColor: 'rgba(220,38,38,0.3)', color: 'var(--red)' }}
                    title={`Remove ${displaySymbol}`}
                    aria-label={`Remove ${displaySymbol}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Desktop / tablet: tab strip */}
        <div className="card mb-4 !p-0 overflow-hidden hidden sm:block">
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
                  background: selectedSymbol === s.symbol ? 'rgba(14,165,233,0.06)' : 'transparent',
                }}
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="truncate">{s.symbol}</span>
                  {(s.exchange && s.exchange !== 'NSE') && (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full flex-shrink-0"
                      style={{ background: 'rgba(251,191,36,0.15)', color: 'var(--amber)' }}>
                      {s.exchange}
                    </span>
                  )}
                  {(() => {
                    const meta = getOptionMeta(s.symbol, s.exchange);
                    if (!meta.isOption) return null;
                    return meta.side ? (
                      <span
                        className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full flex-shrink-0"
                        style={{
                          background: meta.side === 'CE' ? 'rgba(59,130,246,0.15)' : 'rgba(248,113,113,0.15)',
                          color: meta.side === 'CE' ? '#1d4ed8' : '#b91c1c',
                        }}
                      >
                        {meta.side}
                      </span>
                    ) : null;
                  })()}
                </div>
                {!monitoredSymbols.has(s.symbol) && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); removeSymbol(s.symbol); }}
                    className="p-0.5 rounded hover:bg-red-50 flex-shrink-0"
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
              onClick={() => { setShowSearchMobile(true); setShowSearch(true); queueMicrotask(() => searchInputRef.current?.focus()); }}
              className="flex items-center gap-2 px-4 py-3 sm:py-3.5 min-h-[44px] sm:min-h-[48px] text-sm font-semibold transition-colors border-b-2 flex-shrink-0 touch-manipulation"
              style={{ color: 'var(--accent)', borderBottomColor: 'transparent', background: 'transparent' }}
              title="Add new symbol"
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">New</span>
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="flex items-center justify-center gap-1.5 px-3 sm:px-5 py-3 sm:py-3.5 min-h-[44px] sm:min-h-[48px] text-sm font-semibold transition-colors hover:bg-slate-100 flex-shrink-0 touch-manipulation"
              style={{ color: 'var(--text-muted)', borderLeft: '1px solid var(--border-subtle)' }}
              title="Stop monitoring and clear live data (keeps symbols and EMA setup)"
            >
              <RefreshCw className="w-4 h-4" />
              <span className="hidden sm:inline">Reset</span>
            </button>
          </div>
        </div>

        {/* ─── TIMEFRAME + PRICE ─── */}
        <div className="card mb-4 !p-3 sm:!p-4">
          <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center sm:justify-between gap-3">
            {/* Mobile: compact grid, no horizontal scroll */}
            <div className="grid grid-cols-4 gap-2 sm:hidden">
              {TIMEFRAMES.map((tf) => {
                const isActive = displayTimeframe === tf.id;
                return (
                  <button
                    key={tf.id}
                    onClick={() => {
                      if (!displaySymbol) return;
                      const oldTf = getTimeframe(displaySymbol);
                      const isMonitored = monitoredSymbols.has(displaySymbol);
                      if (isMonitored && oldTf !== tf.id) {
                        axios.delete('/api/monitor', { data: { symbol: displaySymbol, timeframe: oldTf } }).catch(() => { });
                        setMonitoredSymbols((prev) => {
                          const next = new Set(prev);
                          next.delete(displaySymbol);
                          return next;
                        });
                        if (userId) refetchWatches();
                        const oldKey = watchKey(displaySymbol, oldTf);
                        setPriceByKey((prev) => { const n = { ...prev }; delete n[oldKey]; return n; });
                        setEmaByKey((prev) => { const n = { ...prev }; delete n[oldKey]; return n; });
                        setWarmupByKey((prev) => { const n = { ...prev }; delete n[oldKey]; return n; });
                        setMonitorStatus(`Monitoring stopped — start again to use ${tf.id}`);
                        setTimeout(() => setMonitorStatus(''), 4000);
                      }
                      setTimeframeBySymbol((prev) => ({ ...prev, [displaySymbol]: tf.id }));
                    }}
                    disabled={!displaySymbol}
                    className={`tf-btn !px-2.5 !py-2 min-h-[40px] text-sm touch-manipulation ${isActive ? 'active' : ''}`}
                  >
                    {tf.label}
                  </button>
                );
              })}
            </div>

            {/* Desktop / tablet: horizontal pill row */}
            <div className="hidden sm:flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1" style={{ WebkitOverflowScrolling: 'touch' }}>
              {TIMEFRAMES.map((tf) => (
                <button
                  key={tf.id}
                  onClick={() => {
                    if (!displaySymbol) return;
                    const oldTf = getTimeframe(displaySymbol);
                    const isMonitored = monitoredSymbols.has(displaySymbol);
                    if (isMonitored && oldTf !== tf.id) {
                      axios.delete('/api/monitor', { data: { symbol: displaySymbol, timeframe: oldTf } }).catch(() => { });
                      setMonitoredSymbols((prev) => {
                        const next = new Set(prev);
                        next.delete(displaySymbol);
                        return next;
                      });
                      if (userId) refetchWatches();
                      const oldKey = watchKey(displaySymbol, oldTf);
                      setPriceByKey((prev) => { const n = { ...prev }; delete n[oldKey]; return n; });
                      setEmaByKey((prev) => { const n = { ...prev }; delete n[oldKey]; return n; });
                      setWarmupByKey((prev) => { const n = { ...prev }; delete n[oldKey]; return n; });
                      setMonitorStatus(`Monitoring stopped — start again to use ${tf.id}`);
                      setTimeout(() => setMonitorStatus(''), 4000);
                    }
                    setTimeframeBySymbol((prev) => ({ ...prev, [displaySymbol]: tf.id }));
                  }}
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
                    <div className="flex items-center gap-1.5 flex-shrink-0 min-w-0">
                      <span className="text-sm font-medium truncate" style={{ color: 'var(--text-muted)' }}>{displaySymbol}</span>
                      {(() => {
                        const meta = getOptionMeta(displaySymbol, getExchange(displaySymbol));
                        if (!meta.isOption || !meta.side) return null;
                        return (
                          <span
                            className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full flex-shrink-0"
                            style={{
                              background: meta.side === 'CE' ? 'rgba(59,130,246,0.15)' : 'rgba(248,113,113,0.15)',
                              color: meta.side === 'CE' ? '#1d4ed8' : '#b91c1c',
                            }}
                          >
                            {meta.side}
                          </span>
                        );
                      })()}
                    </div>
                    <span className="text-2xl sm:text-3xl font-extrabold tracking-tight truncate" style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
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
                ) : displayPriceError ? (
                  <div className="flex items-center gap-2 text-xs sm:text-sm">
                    <span className="px-2 py-1 rounded-lg font-medium flex items-center gap-1.5"
                      style={{ background: 'var(--red-bg)', color: 'var(--red)', border: '1px solid rgba(220,38,38,0.25)' }}>
                      <X className="w-3.5 h-3.5" />
                      {displayPriceError}
                    </span>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>

        {/* ─── MAIN CONTENT ─── */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-5">

          {/* ─── LEFT: EMA Config (collapsible on mobile) ─── */}
          <div className="lg:col-span-5">
            <div className="card !p-3 sm:!p-5">
              <div className="flex items-center justify-between gap-2 min-w-0 mb-3 lg:mb-0">
                <button
                  type="button"
                  onClick={() => setShowEmaConfig(!showEmaConfig)}
                  className="lg:pointer-events-none flex items-center justify-between gap-2 min-w-0 flex-1"
                >
                  <div className="section-label flex items-center gap-2 min-w-0">
                    <BarChart3 className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--accent)' }} />
                    <span className="truncate">EMA Periods {displaySymbol && <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>({displaySymbol})</span>}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="badge flex-shrink-0" style={{ background: 'rgba(14,165,233,0.08)', color: 'var(--accent)' }}>{emas.length}</span>
                    <span className="lg:hidden text-xs" style={{ color: 'var(--text-muted)' }}>{showEmaConfig ? '▲' : '▼'}</span>
                  </div>
                </button>
                <label className="inline-flex items-center gap-2 cursor-pointer select-none flex-shrink-0" title="Enable EMA crossover alerts for this symbol">
                  <input
                    type="checkbox"
                    className="w-4 h-4"
                    checked={emaAlertsEnabled}
                    disabled={!displaySymbol}
                    onChange={(e) => updateEmaEnabled(e.target.checked)}
                  />
                  <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
                    {emaAlertsEnabled ? 'Enabled' : 'Off'}
                  </span>
                </label>
              </div>

              <div className={`${showEmaConfig ? '' : 'hidden lg:block'} mt-4`}>

                {/* Quick add — horizontal scroll on narrow screens */}
                <div className="flex gap-2 mb-3 sm:mb-4 overflow-x-auto no-scrollbar pb-1" style={{ WebkitOverflowScrolling: 'touch' }}>
                  {[9, 21, 50, 100, 200].map((p) => (
                    <button key={p} onClick={() => addEma(p)}
                      disabled={!displaySymbol || !!emas.find((e) => e.period === p)}
                      className="ema-quick flex-shrink-0 min-w-[40px] sm:min-w-[44px] text-sm touch-manipulation">
                      {p}
                    </button>
                  ))}
                  <button onClick={() => setShowAddEma(!showAddEma)}
                    disabled={!displaySymbol}
                    className="flex items-center justify-center w-10 sm:w-11 min-w-[40px] sm:min-w-[44px] min-h-[40px] sm:min-h-[44px] rounded-lg transition-colors disabled:opacity-50 flex-shrink-0 touch-manipulation"
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
                      style={{ background: 'var(--accent)', color: '#ffffff' }}>
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
                    <p className="text-sm font-medium">
                      {emaAlertsEnabled ? `Add at least 2 EMAs for ${displaySymbol}` : `Optional: add EMAs for ${displaySymbol}`}
                    </p>
                    <p className="text-xs mt-1 opacity-60">
                      {emaAlertsEnabled ? 'to start monitoring crossovers' : 'or enable RSI-only alerts below'}
                    </p>
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
                        <button onClick={() => removeEma(ema.id)} className="p-1.5 rounded-lg transition-colors hover:bg-red-50 flex-shrink-0"
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

                {!emaAlertsEnabled ? (
                  <p className="text-xs leading-relaxed mb-4" style={{ color: 'var(--text-muted)' }}>
                    EMA crossover alerts are off. Enable above to alert on bullish/bearish EMA crosses,
                    or use RSI-only monitoring below.
                  </p>
                ) : (
                  <>
                {/* Monitoring Controls — which crossovers to alert on */}
                <div className="flex gap-2 mb-4">
                  <button
                    type="button"
                    onClick={() => {
                      setTrackBullish(!trackBullish);
                      stopAllMonitoringFromConfigChange();
                    }}
                    className={`toggle-btn text-sm min-h-[48px] touch-manipulation ${trackBullish ? 'bull-on' : ''}`}
                    aria-pressed={trackBullish}
                    aria-label={trackBullish ? 'Alert on bullish crossovers (on)' : 'Alert on bullish crossovers (off)'}
                  >
                    <TrendingUp className="w-4 h-4 flex-shrink-0" />
                    <span>Bullish</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setTrackBearish(!trackBearish);
                      stopAllMonitoringFromConfigChange();
                    }}
                    className={`toggle-btn text-sm min-h-[48px] touch-manipulation ${trackBearish ? 'bear-on' : ''}`}
                    aria-pressed={trackBearish}
                    aria-label={trackBearish ? 'Alert on bearish crossovers (on)' : 'Alert on bearish crossovers (off)'}
                  >
                    <TrendingDown className="w-4 h-4 flex-shrink-0" />
                    <span>Bearish</span>
                  </button>
                </div>
                  </>
                )}

                <button
                  onClick={() => {
                    if (restoringWatches) {
                      setMonitorStatus('Restoring existing monitoring from server — please wait until this finishes before changing monitors.');
                      return;
                    }
                    if (monitoringBusy) {
                      setMonitorStatus('Monitoring is already starting — please wait until it finishes before pressing the button again.');
                      return;
                    }
                    if (!displaySymbol) {
                      setMonitorStatus('Add at least one symbol to start monitoring.');
                      return;
                    }
                    if (monitoredSymbols.has(displaySymbol)) {
                      stopMonitoringForSymbol(displaySymbol);
                    } else {
                      startMonitoringForSymbol(displaySymbol);
                    }
                  }}
                  disabled={monitoringBusy || restoringWatches}
                  className={`cta text-base ${displaySymbol && monitoredSymbols.has(displaySymbol) ? 'halt' : 'go'} ${
                    monitoringBusy || restoringWatches ? 'opacity-70 cursor-not-allowed' : ''
                  }`}>
                  {displaySymbol && monitoredSymbols.has(displaySymbol) ? (
                    <><Power className="w-5 h-5" /> Stop monitoring {displaySymbol}</>
                  ) : (
                    <><Zap className="w-5 h-5" /> Start monitoring {displaySymbol || '…'}</>
                  )}
                </button>
              </div>{/* end collapsible */}
            </div>{/* end card */}

            {/* ─── RSI Config Card ─── */}
            <div className="card !p-3 sm:!p-5 mt-3 sm:mt-4">
              <div className="flex items-center justify-between gap-2 mb-3 min-w-0">
                <div className="section-label flex items-center gap-2 min-w-0">
                  <Activity className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--purple)' }} />
                  <span className="truncate">
                    RSI {displaySymbol && <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>({displaySymbol})</span>}
                  </span>
                </div>
                <label className="inline-flex items-center gap-2 cursor-pointer select-none" title="Enable RSI tracking for this symbol">
                  <input
                    type="checkbox"
                    className="w-4 h-4"
                    checked={rsiUi.enabled}
                    disabled={!displaySymbol}
                    onChange={(e) => updateRsi((prev) => {
                      const enabling = e.target.checked;
                      return {
                        ...prev,
                        enabled: enabling,
                        period: prev.period || RSI_DEFAULTS.period,
                        overbought: prev.overbought || RSI_DEFAULTS.overbought,
                        oversold: prev.oversold || RSI_DEFAULTS.oversold,
                        signalLineLength: RSI_DEFAULTS.signalLineLength,
                        ...(enabling ? { signals: { ...DEFAULT_RSI_SIGNALS } } : {}),
                      };
                    })}
                  />
                  <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
                    {rsiUi.enabled ? 'Enabled' : 'Off'}
                  </span>
                </label>
              </div>

              {!displaySymbol ? (
                <div className="text-center py-4 text-xs" style={{ color: 'var(--text-muted)' }}>
                  Select a symbol to configure RSI
                </div>
              ) : !rsiUi.enabled ? (
                <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                  RSI (Relative Strength Index, 0–100) measures momentum. Enable to set period &
                  thresholds, and pick which signals fire alerts. Standard reference: 70 = overbought,
                  30 = oversold, 50 = trend midline.
                </p>
              ) : (
                <div className="space-y-3">
                  {/* Live RSI value */}
                  {liveRsi && liveRsi.value != null && (
                    <div className="flex items-center justify-between px-3 py-2 rounded-lg"
                      style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
                      <span className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>
                        Live RSI({liveRsi.period})
                      </span>
                      <span className="text-sm font-mono font-bold" style={{
                        color: liveRsi.value >= 70 ? 'var(--red)' : liveRsi.value <= 30 ? 'var(--green)' : 'var(--text-primary)',
                      }}>
                        {liveRsi.value.toFixed(2)}
                      </span>
                    </div>
                  )}
                  {liveRsi && liveRsi.warmupProgress < 1 && (
                    <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                      <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border-subtle)' }}>
                        <div className="h-full rounded-full transition-all duration-500"
                          style={{ width: `${liveRsi.warmupProgress * 100}%`, background: 'var(--purple)' }} />
                      </div>
                      <span className="font-mono">{Math.round(liveRsi.warmupProgress * 100)}% warmed</span>
                    </div>
                  )}

                  {/* Period + threshold inputs */}
                  <div className="grid grid-cols-3 gap-2">
                    <label className="flex flex-col gap-1">
                      <span className="eyebrow" style={{ color: 'var(--text-muted)' }}>
                        Period
                      </span>
                      <input
                        type="number"
                        min="2"
                        max="200"
                        value={rsiUi.period}
                        onChange={(e) => updateRsi((prev) => ({ ...prev, period: e.target.value }))}
                        className="input-field text-sm !py-2"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="eyebrow" style={{ color: 'var(--text-muted)' }}>
                        Overbought
                      </span>
                      <input
                        type="number"
                        min="51"
                        max="100"
                        value={rsiUi.overbought}
                        onChange={(e) => updateRsi((prev) => ({ ...prev, overbought: e.target.value }))}
                        className="input-field text-sm !py-2"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="eyebrow" style={{ color: 'var(--text-muted)' }}>
                        Oversold
                      </span>
                      <input
                        type="number"
                        min="0"
                        max="49"
                        value={rsiUi.oversold}
                        onChange={(e) => updateRsi((prev) => ({ ...prev, oversold: e.target.value }))}
                        className="input-field text-sm !py-2"
                      />
                    </label>
                  </div>

                  {/* Signal toggles */}
                  <div>
                    <div className="eyebrow mb-2" style={{ color: 'var(--text-muted)' }}>
                      Alerts to fire
                    </div>
                    <div className="space-y-1.5">
                      {RSI_SIGNAL_ORDER.map((key) => (
                        <div key={key}>
                          <label className="flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer"
                            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
                            <input
                              type="checkbox"
                              className="w-4 h-4"
                              checked={rsiUi.signals[key]}
                              onChange={(e) =>
                                updateRsi((prev) => ({
                                  ...prev,
                                  signals: { ...prev.signals, [key]: e.target.checked },
                                }))
                              }
                            />
                            <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                              {RSI_SIGNAL_LABELS_LONG[key]}
                            </span>
                          </label>
                          {key === 'signalLineCross' && rsiUi.signals.signalLineCross && (
                            <label className="flex items-center gap-2 mt-1.5 ml-6 mr-3">
                              <span className="text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>
                                EMA length
                              </span>
                              <input
                                type="number"
                                min="2"
                                max="200"
                                value={rsiUi.signalLineLength}
                                onChange={(e) => updateRsi((prev) => ({ ...prev, signalLineLength: e.target.value }))}
                                className="input-field text-sm !py-1.5 !px-2 w-20"
                              />
                            </label>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {rsiFormError && (
                    <div className="text-xs px-3 py-2 rounded-lg" style={{ background: 'var(--red-bg)', color: 'var(--red)' }}>
                      {rsiFormError}
                    </div>
                  )}

                  <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                    Changes apply when you start monitoring. If a watch is already running,
                    stop &amp; restart it to apply new RSI settings.
                  </p>
                </div>
              )}
            </div>
          </div>{/* end lg:col-span-5 */}

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
                          boxShadow: isEditing ? '0 0 0 2px rgba(14,165,233,0.2)' : undefined,
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
                              <button onClick={(e) => { e.stopPropagation(); saveEdit(); }} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold" style={{ background: 'var(--accent)', color: '#ffffff' }}>
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
                                  border: `1px solid ${fastAbove ? 'rgba(22,163,74,0.2)' : 'rgba(220,38,38,0.2)'}`
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
                  {combinedAlerts.length}
                </span>
              </div>

              <div className="space-y-1.5 max-h-[420px] overflow-y-auto pr-1">
                {combinedAlerts.length === 0 ? (
                  <div className="text-center py-8" style={{ color: 'var(--text-muted)' }}>
                    <Bell className="w-8 h-8 mx-auto mb-2 opacity-25" />
                    <p className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>No alerts yet</p>
                    <p className="text-xs mt-1 opacity-70 max-w-[220px] mx-auto leading-relaxed">
                      EMA crossovers and RSI signals appear here as they happen
                    </p>
                  </div>
                ) : (
                  combinedAlerts.map((item) => {
                    const time = new Date(item.data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    if (item.kind === 'crossover') {
                      const a = item.data;
                      const isBull = a.crossoverType === 'bullish';
                      return (
                        <div key={a.id} className={`alert-row ${isBull ? 'dir-bull' : 'dir-bear'}`}>
                          <div className="flex items-center gap-2.5 min-w-0 flex-1">
                            <div className="alert-icon" style={{ background: isBull ? 'var(--green-bg)' : 'var(--red-bg)' }}>
                              {isBull ? (
                                <TrendingUp className="w-4 h-4" style={{ color: 'var(--green)' }} />
                              ) : (
                                <TrendingDown className="w-4 h-4" style={{ color: 'var(--red)' }} />
                              )}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-baseline gap-2 min-w-0">
                                <span className="alert-symbol truncate">{a.symbol}</span>
                                <span className="alert-kind flex-shrink-0">EMA</span>
                              </div>
                              <div className="alert-detail truncate">
                                EMA({a.fastPeriod}) {isBull ? '↑' : '↓'} EMA({a.slowPeriod}) · {time} · {a.timeframe}
                              </div>
                            </div>
                          </div>
                          <div className="alert-price flex-shrink-0">{getCurrencySymbol(a.currency)}{a.price}</div>
                        </div>
                      );
                    }
                    const a = item.data;
                    const label = RSI_SIGNAL_LABELS[a.signalType];
                    const isBull = a.direction === 'bullish';
                    return (
                      <div key={a.id} className={`alert-row ${isBull ? 'dir-bull' : 'dir-bear'}`}>
                        <div className="flex items-center gap-2.5 min-w-0 flex-1">
                          <div className="alert-icon" style={{ background: 'rgba(124, 58, 237, 0.12)' }}>
                            <Activity className="w-4 h-4" style={{ color: 'var(--purple)' }} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline gap-2 min-w-0">
                              <span className="alert-symbol truncate">{a.symbol}</span>
                              <span className="alert-kind flex-shrink-0">RSI</span>
                            </div>
                            <div className="alert-detail truncate">
                              {label} · RSI({a.period}) {a.rsiValue} · {time} · {a.timeframe}
                            </div>
                          </div>
                        </div>
                        <div className="alert-price flex-shrink-0">{getCurrencySymbol(a.currency)}{a.price}</div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
