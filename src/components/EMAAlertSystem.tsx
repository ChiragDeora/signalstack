'use client';

/* ============================================================
   SignalStack — EMAAlertSystem (redesigned UI)
   Drop-in replacement for src/components/EMAAlertSystem.tsx
   Same data layer (Socket.IO, Angel One fetch, monitor/push/email
   APIs, Supabase persistence) as the original — new presentation:
   selected-symbol spotlight, watchlist, indicators config, search
   sheet, even bottom nav, light/dark.
   ============================================================ */
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { UserButton, useUser } from '@clerk/nextjs';
import axios from 'axios';
import { io, Socket } from 'socket.io-client';
import {
  Moon, Sun, Bell, X, Plus, Check, ChevronRight, Power, Zap, Layers, Activity,
  TrendingUp, TrendingDown, Search, Mail, Download, Sparkles, RefreshCw, Settings, Trash2,
  Send,
} from 'lucide-react';
import {
  Spotlight, WatchRow, BottomNav, RsiMeter, LivePill, DirTag, optionMeta, TodayAlerts,
  type TodayAlertItem,
} from './signalstack-ui';
import type { DaySummary } from '@/lib/daySummary';

/* ---------- Types ---------- */
interface RsiSignalFlags { overboughtCross: boolean; oversoldCross: boolean; thresholdBreach: boolean; centerlineCross: boolean; signalLineCross: boolean; }
interface RsiPayload { enabled: boolean; period: number; overbought: number; oversold: number; signalLineLength?: number; timeframe?: string; signals: RsiSignalFlags; }
interface RsiUiConfig { enabled: boolean; period: string; overbought: string; oversold: string; signalLineLength: string; timeframe: string; signals: RsiSignalFlags; }
interface RsiLive { value: number | null; period: number; warmupProgress: number; }
interface MonitoredWatch { symbol: string; timeframe: string; emaPeriods: number[]; trackBullish: boolean; trackBearish: boolean; exchange: string; currency: string; rsi?: RsiPayload; }
interface EMA { id: number; period: number; color: string; }
interface MonitoredSymbol { symbol: string; name?: string; currency: string; exchange?: string; }
interface AlertData { id: string; symbol: string; timeframe: string; fastPeriod: number; slowPeriod: number; fastEmaValue: number; slowEmaValue: number; crossoverType: 'bullish' | 'bearish'; price: number; currency: string; timestamp: string; source: string; }
interface RsiAlertData { id: string; type: 'rsi'; symbol: string; timeframe: string; signalType: 'overboughtCross' | 'oversoldCross' | 'thresholdBreach' | 'centerlineCross'; direction: 'bullish' | 'bearish'; rsiValue: number; previousRsi: number; period: number; overbought: number; oversold: number; price: number; currency: string; timestamp: string; source: string; }
interface SearchResult { symbol: string; name: string; exchange: string; currency: string; type: string; }

const RSI_DEFAULTS = { period: '14', overbought: '70', oversold: '30', signalLineLength: '14' };
const DEFAULT_RSI_SIGNALS: RsiSignalFlags = { overboughtCross: false, oversoldCross: false, thresholdBreach: false, centerlineCross: false, signalLineCross: true };
const EMPTY_RSI_UI: RsiUiConfig = { enabled: false, ...RSI_DEFAULTS, timeframe: '', signals: { overboughtCross: false, oversoldCross: false, thresholdBreach: false, centerlineCross: false, signalLineCross: false } };
const RSI_SIGNAL_LABELS_LONG: Record<keyof RsiSignalFlags, string> = {
  overboughtCross: 'Overbought cross (bearish)', oversoldCross: 'Oversold cross (bullish)',
  thresholdBreach: 'Threshold breach', centerlineCross: 'Centerline (50) cross', signalLineCross: 'Signal line cross',
};
const RSI_SIGNAL_LABELS: Record<keyof RsiSignalFlags, string> = {
  overboughtCross: 'Overbought cross', oversoldCross: 'Oversold cross',
  thresholdBreach: 'Threshold breach', centerlineCross: 'Centerline cross', signalLineCross: 'Signal line cross',
};
const RSI_SIGNAL_ORDER: Array<keyof RsiSignalFlags> = ['signalLineCross', 'overboughtCross', 'oversoldCross', 'centerlineCross'];

function buildRsiPayload(ui: RsiUiConfig, emaTimeframe?: string): { ok: true; rsi?: RsiPayload } | { ok: false; error: string } {
  if (!ui.enabled) return { ok: true };
  const period = parseInt(ui.period.trim() || RSI_DEFAULTS.period, 10);
  const overbought = parseFloat(ui.overbought.trim() || RSI_DEFAULTS.overbought);
  const oversold = parseFloat(ui.oversold.trim() || RSI_DEFAULTS.oversold);
  if (!Number.isFinite(period) || period < 2 || period > 200) return { ok: false, error: 'RSI period must be between 2 and 200' };
  if (!Number.isFinite(overbought) || overbought <= 50 || overbought > 100) return { ok: false, error: 'Overbought must be 51–100' };
  if (!Number.isFinite(oversold) || oversold < 0 || oversold >= 50) return { ok: false, error: 'Oversold must be 0–49' };
  if (!Object.values(ui.signals).some(Boolean)) return { ok: false, error: 'Pick at least one RSI signal' };
  const payload: RsiPayload = { enabled: true, period, overbought, oversold, signals: ui.signals };
  if (ui.signals.signalLineCross) {
    const sigLen = parseInt(ui.signalLineLength.trim() || RSI_DEFAULTS.signalLineLength, 10);
    if (!Number.isFinite(sigLen) || sigLen < 2 || sigLen > 200) return { ok: false, error: 'Signal line EMA length must be 2–200' };
    payload.signalLineLength = sigLen;
  }
  if (ui.timeframe && ui.timeframe !== emaTimeframe) {
    payload.timeframe = ui.timeframe;
  }
  return { ok: true, rsi: payload };
}
function rsiPayloadToUi(p: RsiPayload | undefined): RsiUiConfig {
  if (!p || !p.enabled) return EMPTY_RSI_UI;
  return { enabled: true, period: String(p.period), overbought: String(p.overbought), oversold: String(p.oversold),
    signalLineLength: p.signalLineLength != null ? String(p.signalLineLength) : RSI_DEFAULTS.signalLineLength,
    timeframe: p.timeframe || '', signals: { ...p.signals } };
}
function watchKey(symbol: string, timeframe: string) { return `${symbol.toUpperCase()}:${timeframe}`; }

/** Local calendar day (browser timezone). */
function isTodayTimestamp(iso: string): boolean {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
}

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
const COLORS = ['#1f6dff', '#0bb5d6', '#8b5cf6', '#f59e0b', '#ec4899', '#10b981', '#06b6d4', '#84cc16', '#f97316', '#6366f1'];
const DEFAULT_TIMEFRAME = '5m';

type PriceInfo = { price: number; change: number; changePercent: number; currency: string; source: string; lastUpdate: Date | null };
type Flash = '' | 'flash-up' | 'flash-down';

export default function EMAAlertSystem() {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [tab, setTab] = useState<'live' | 'config'>('live');
  const [searchOpen, setSearchOpen] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const [dark, setDark] = useState(false);

  const [symbols, setSymbols] = useState<MonitoredSymbol[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [timeframeBySymbol, setTimeframeBySymbol] = useState<Record<string, string>>({});
  // Lazy initializers pull last-seen values from localStorage so the UI shows
  // prices/RSI/EMA instantly on page load (instead of going blank for ~15s
  // during the server-side warmup). Fresh socket updates overwrite them.
  const [priceByKey, setPriceByKey] = useState<Record<string, PriceInfo>>(() => {
    if (typeof window === 'undefined') return {};
    try {
      const raw = window.localStorage.getItem('signalstack:priceByKey');
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, PriceInfo & { lastUpdate: string | null | undefined }>;
      const restored: Record<string, PriceInfo> = {};
      for (const [k, v] of Object.entries(parsed)) {
        restored[k] = { ...(v as PriceInfo), lastUpdate: v.lastUpdate ? new Date(v.lastUpdate) : null };
      }
      return restored;
    } catch { return {}; }
  });
  const [flashByKey, setFlashByKey] = useState<Record<string, Flash>>({});
  const [priceErrorByKey, setPriceErrorByKey] = useState<Record<string, string>>({});
  const [emaByKey, setEmaByKey] = useState<Record<string, Record<number, number | null>>>(() => {
    if (typeof window === 'undefined') return {};
    try {
      const raw = window.localStorage.getItem('signalstack:emaByKey');
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });
  const [warmupByKey, setWarmupByKey] = useState<Record<string, Record<number, number>>>({});
  const [rsiByKey, setRsiByKey] = useState<Record<string, RsiLive>>(() => {
    if (typeof window === 'undefined') return {};
    try {
      const raw = window.localStorage.getItem('signalstack:rsiByKey');
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });
  const [emasBySymbol, setEmasBySymbol] = useState<Record<string, EMA[]>>({});
  const [rsiBySymbol, setRsiBySymbol] = useState<Record<string, RsiUiConfig>>({});
  const [emaEnabledBySymbol, setEmaEnabledBySymbol] = useState<Record<string, boolean>>({});
  const [trackBullish, setTrackBullish] = useState(true);
  const [trackBearish, setTrackBearish] = useState(true);
  const [monitoredSymbols, setMonitoredSymbols] = useState<Set<string>>(new Set());
  const [monitorStatus, setMonitorStatus] = useState('');
  const [monitoringBusy, setMonitoringBusy] = useState(false);
  const [restoringWatches, setRestoringWatches] = useState(false);
  const [newEmaPeriod, setNewEmaPeriod] = useState('');
  const [rsiFormError, setRsiFormError] = useState<string | null>(null);

  const [alerts, setAlerts] = useState<AlertData[]>([]);
  const [rsiAlerts, setRsiAlerts] = useState<RsiAlertData[]>([]);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushAvailable, setPushAvailable] = useState<boolean | null>(null);
  const [testEmailStatus, setTestEmailStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  const [testEmailMessage, setTestEmailMessage] = useState<string | null>(null);
  const [testPushStatus, setTestPushStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  const [testPushMessage, setTestPushMessage] = useState<string | null>(null);
  const [cleanupStatus, setCleanupStatus] = useState<'idle' | 'running' | 'success' | 'error'>('idle');
  const [cleanupMessage, setCleanupMessage] = useState<string | null>(null);
  const [daySummaryBySymbol, setDaySummaryBySymbol] = useState<Record<string, DaySummary>>({});
  const [telegramChatId, setTelegramChatId] = useState('');
  const [telegramConfigured, setTelegramConfigured] = useState<boolean>(false);
  const [telegramConnectUrl, setTelegramConnectUrl] = useState<string | null>(null);
  const [telegramStatus, setTelegramStatus] = useState<'idle' | 'saving' | 'success' | 'error' | 'sending'>('idle');
  const [telegramMessage, setTelegramMessage] = useState<string | null>(null);

  const hasRestoredRef = useRef(false);
  const hasRestoredMonitoredRef = useRef(false);
  const { user: clerkUser } = useUser();
  const userId = clerkUser?.id ?? null;

  const getTimeframe = (sym: string) => timeframeBySymbol[sym] ?? DEFAULT_TIMEFRAME;
  const displaySymbol = selectedSymbol ?? symbols[0]?.symbol ?? null;
  const displayTimeframe = displaySymbol ? getTimeframe(displaySymbol) : DEFAULT_TIMEFRAME;
  const displayKey = displaySymbol ? watchKey(displaySymbol, displayTimeframe) : '';
  const displayPrice = displaySymbol ? priceByKey[displayKey] : undefined;
  const displayPriceError = displaySymbol ? priceErrorByKey[displayKey] : undefined;
  const displayEmaValues = displaySymbol ? emaByKey[displayKey] ?? {} : {};
  const liveRsi = displaySymbol ? rsiByKey[displayKey] : undefined;
  const emas = useMemo(() => (displaySymbol ? (emasBySymbol[displaySymbol] ?? []) : []), [displaySymbol, emasBySymbol]);
  const rsiUi = displaySymbol ? (rsiBySymbol[displaySymbol] ?? EMPTY_RSI_UI) : EMPTY_RSI_UI;
  const emaAlertsEnabled = displaySymbol ? (emaEnabledBySymbol[displaySymbol] ?? true) : true;

  useEffect(() => { setMounted(true); }, []);

  /* dark mode persistence */
  useEffect(() => {
    try { const v = localStorage.getItem('signalstack:dark'); if (v != null) setDark(v === '1'); } catch { /* ignore */ }
  }, []);
  useEffect(() => { if (mounted) { try { localStorage.setItem('signalstack:dark', dark ? '1' : '0'); } catch { /* ignore */ } } }, [mounted, dark]);

  /* price/RSI/EMA cache persistence — debounced so we don't thrash storage */
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

  const getCurrencySymbol = (c: string) => ({ USD: '$', INR: '₹', GBP: '£', JPY: '¥', EUR: '€' } as Record<string, string>)[c] || c;
  const getExchange = useCallback((sym: string): string => symbols.find((x) => x.symbol === sym)?.exchange || 'NSE', [symbols]);

  /* flash helper */
  const flashTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const setFlash = useCallback((key: string, dir: Flash) => {
    setFlashByKey((prev) => ({ ...prev, [key]: dir }));
    if (flashTimers.current[key]) clearTimeout(flashTimers.current[key]);
    flashTimers.current[key] = setTimeout(() => setFlashByKey((prev) => ({ ...prev, [key]: '' })), 620);
  }, []);

  const updateEmaEnabled = useCallback((enabled: boolean) => {
    if (!displaySymbol) return;
    setEmaEnabledBySymbol((prev) => ({ ...prev, [displaySymbol]: enabled }));
  }, [displaySymbol]);
  const updateRsi = useCallback((updater: (prev: RsiUiConfig) => RsiUiConfig) => {
    if (!displaySymbol) return;
    setRsiBySymbol((prev) => ({ ...prev, [displaySymbol]: updater(prev[displaySymbol] ?? EMPTY_RSI_UI) }));
    setRsiFormError(null);
  }, [displaySymbol]);

  /* push availability + restore */
  useEffect(() => {
    if (!mounted) return;
    axios.get<{ vapidConfigured?: boolean }>('/api/status').then((r) => setPushAvailable(!!r.data?.vapidConfigured)).catch(() => setPushAvailable(false));
  }, [mounted]);

  /* telegram: load saved chat id + server-configured flag when tools open */
  useEffect(() => {
    if (!mounted || !userId || !showTools) return;
    axios.get<{ success: boolean; configured?: boolean; chatId?: string; connectUrl?: string | null }>('/api/user/telegram')
      .then((r) => {
        if (!r.data.success) return;
        setTelegramConfigured(!!r.data.configured);
        setTelegramChatId(r.data.chatId || '');
        setTelegramConnectUrl(r.data.connectUrl || null);
      })
      .catch(() => { /* ignore */ });
  }, [mounted, userId, showTools]);

  /* telegram: while the tools drawer is open and not yet connected, poll for the
     chat id the webhook saves once the user taps "Connect Telegram" → Start */
  useEffect(() => {
    if (!mounted || !userId || !showTools || telegramChatId || !telegramConnectUrl) return;
    const interval = setInterval(() => {
      axios.get<{ success: boolean; chatId?: string }>('/api/user/telegram')
        .then((r) => {
          if (r.data.success && r.data.chatId) {
            setTelegramChatId(r.data.chatId);
            setTelegramStatus('success');
            setTelegramMessage('Connected via Telegram!');
            setTimeout(() => { setTelegramStatus('idle'); setTelegramMessage(null); }, 5000);
          }
        })
        .catch(() => { /* ignore */ });
    }, 4000);
    return () => clearInterval(interval);
  }, [mounted, userId, showTools, telegramChatId, telegramConnectUrl]);
  useEffect(() => {
    if (!mounted || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
    navigator.serviceWorker.ready.then((reg) => reg.pushManager.getSubscription()).then((s) => s != null && setPushEnabled(true)).catch(() => { });
  }, [mounted]);

  const refetchWatches = useCallback(async () => {
    if (!userId) return;
    try {
      const res = await axios.get<{ success: boolean; watches?: MonitoredWatch[] }>('/api/user/watches');
      if (res.data.success && Array.isArray(res.data.watches)) setMonitoredSymbols(new Set(res.data.watches.map((w) => w.symbol)));
    } catch { /* ignore */ }
  }, [userId]);

  /* restore config */
  useEffect(() => {
    if (!mounted || !userId || hasRestoredRef.current) return;
    axios.get<{ success: boolean; config?: { symbols: MonitoredSymbol[]; timeframeBySymbol: Record<string, string>; emasBySymbol: Record<string, EMA[]>; trackBullish: boolean; trackBearish: boolean; selectedSymbol: string | null } }>('/api/user/config')
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
      .catch(() => { })
      .finally(() => { hasRestoredRef.current = true; });
  }, [mounted, userId]);

  /* persist config */
  const configPersistRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!mounted || !userId || !hasRestoredRef.current) return;
    if (configPersistRef.current) clearTimeout(configPersistRef.current);
    configPersistRef.current = setTimeout(() => {
      axios.put('/api/user/config', { symbols, timeframeBySymbol, emasBySymbol, trackBullish, trackBearish, selectedSymbol }).catch(() => { });
    }, 800);
    return () => { if (configPersistRef.current) clearTimeout(configPersistRef.current); };
  }, [mounted, userId, symbols, timeframeBySymbol, emasBySymbol, trackBullish, trackBearish, selectedSymbol]);

  /* restore monitoring */
  useEffect(() => {
    if (!mounted || !userId || hasRestoredMonitoredRef.current) return;
    hasRestoredMonitoredRef.current = true;
    setRestoringWatches(true);
    axios.get<{ success: boolean; watches?: MonitoredWatch[] }>('/api/user/watches')
      .then(async (res) => {
        const watches = res.data.success && Array.isArray(res.data.watches) ? res.data.watches : [];
        if (watches.length === 0) return;
        setMonitorStatus('Restoring monitoring…');
        const rsiMap: Record<string, RsiUiConfig> = {}; const emaEnabledMap: Record<string, boolean> = {};
        for (const w of watches) { if (w.rsi) rsiMap[w.symbol] = rsiPayloadToUi(w.rsi); emaEnabledMap[w.symbol] = w.trackBullish || w.trackBearish; }
        if (Object.keys(rsiMap).length) setRsiBySymbol((p) => ({ ...rsiMap, ...p }));
        if (Object.keys(emaEnabledMap).length) setEmaEnabledBySymbol((p) => ({ ...emaEnabledMap, ...p }));
        const restored: string[] = [];
        for (const w of watches) {
          try {
            const emaCheck = await axios.get<{ emas?: Record<number, number | null> }>(`/api/ema-status?symbol=${encodeURIComponent(w.symbol)}&timeframe=${encodeURIComponent(w.timeframe)}`);
            const warm = emaCheck.data?.emas && Object.values(emaCheck.data.emas).some((v) => v != null);
            if (warm) { restored.push(w.symbol); continue; }
            const r = await axios.post('/api/monitor', { symbol: w.symbol, timeframe: w.timeframe, emaPeriods: w.emaPeriods, trackBullish: w.trackBullish, trackBearish: w.trackBearish, exchange: w.exchange, currency: w.currency, rsi: w.rsi });
            if (r.data.success) restored.push(w.symbol);
          } catch { /* skip */ }
        }
        if (restored.length) setMonitoredSymbols((p) => new Set([...p, ...restored]));
        setMonitorStatus('');
      })
      .catch(() => { })
      .finally(() => setRestoringWatches(false));
  }, [mounted, userId]);

  /* socket.io */
  const pendingPriceRef = useRef<Record<string, PriceInfo>>({});
  const pendingEmaRef = useRef<Record<string, { emas: Record<number, number | null>; warmup: Record<number, number>; rsi?: RsiLive }>>({});
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushSocketUpdates = useCallback(() => {
    if (Object.keys(pendingPriceRef.current).length > 0) {
      const batch = pendingPriceRef.current; pendingPriceRef.current = {};
      setPriceByKey((prev) => {
        for (const [k, v] of Object.entries(batch)) { const old = prev[k]; if (old) setFlash(k, v.price >= old.price ? 'flash-up' : 'flash-down'); }
        return { ...prev, ...batch };
      });
      setPriceErrorByKey((prev) => { const next = { ...prev }; let ch = false; for (const k of Object.keys(batch)) if (next[k]) { delete next[k]; ch = true; } return ch ? next : prev; });
    }
    if (Object.keys(pendingEmaRef.current).length > 0) {
      const batch = pendingEmaRef.current; pendingEmaRef.current = {};
      const emaU: Record<string, Record<number, number | null>> = {}; const warmU: Record<string, Record<number, number>> = {}; const rsiU: Record<string, RsiLive> = {};
      for (const [k, v] of Object.entries(batch)) { warmU[k] = v.warmup; if (Object.keys(v.emas).some((p) => v.emas[Number(p)] != null)) emaU[k] = v.emas; if (v.rsi) rsiU[k] = v.rsi; }
      setEmaByKey((prev) => (Object.keys(emaU).length ? { ...prev, ...emaU } : prev));
      setWarmupByKey((prev) => ({ ...prev, ...warmU }));
      if (Object.keys(rsiU).length) setRsiByKey((prev) => ({ ...prev, ...rsiU }));
    }
    flushTimerRef.current = null;
  }, [setFlash]);
  const scheduleFlush = useCallback(() => { if (flushTimerRef.current === null) flushTimerRef.current = setTimeout(flushSocketUpdates, 120); }, [flushSocketUpdates]);

  useEffect(() => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const socket = io(origin, { path: '/socket.io', transports: ['polling', 'websocket'], reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000, reconnectionDelayMax: 10000, timeout: 20000 });
    socketRef.current = socket;
    socket.on('connect', () => { setConnected(true); if (userId) socket.emit('join:user', userId); });
    socket.on('disconnect', (reason) => { setConnected(false); if (reason === 'io server disconnect') socket.connect(); });
    socket.on('connect_error', () => setConnected(false));
    socket.on('price:update', (data: any) => {
      const sym = data.symbol; if (!sym) return;
      const key = watchKey(sym, data.timeframe ?? DEFAULT_TIMEFRAME);
      pendingPriceRef.current[key] = { price: data.price, change: data.change ?? 0, changePercent: data.changePercent ?? 0, currency: data.currency ?? 'INR', source: data.source ?? '', lastUpdate: new Date() };
      scheduleFlush();
    });
    socket.on('ema:update', (data: any) => {
      const sym = data.symbol; if (!sym) return;
      const key = watchKey(sym, data.timeframe || DEFAULT_TIMEFRAME);
      const emas2 = data.emas || {}; const warm = data.warmupProgress || {};
      if (!pendingEmaRef.current[key]) pendingEmaRef.current[key] = { emas: {}, warmup: {} };
      if (Object.keys(emas2).some((p) => emas2[p] != null)) pendingEmaRef.current[key].emas = emas2;
      pendingEmaRef.current[key].warmup = warm;
      if (data.rsi) pendingEmaRef.current[key].rsi = data.rsi;
      scheduleFlush();
    });
    socket.on('alert:crossover', (alert: AlertData) => {
      setAlerts((prev) => [alert, ...prev].slice(0, 100));
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(`${alert.crossoverType === 'bullish' ? '📈' : '📉'} ${alert.symbol} EMA Alert`, { body: `${alert.crossoverType.toUpperCase()}: EMA(${alert.fastPeriod}) crossed ${alert.crossoverType === 'bullish' ? 'above' : 'below'} EMA(${alert.slowPeriod})`, icon: '/signalstack-logo.png', tag: `alert-${alert.id}` });
      }
    });
    socket.on('alert:rsi', (alert: RsiAlertData) => { setRsiAlerts((prev) => [alert, ...prev].slice(0, 100)); });
    socket.on('monitor:status', (data: { symbol?: string; status?: string; message?: string }) => {
      setMonitorStatus(data.message || data.status || '');
      if (data.status === 'stopped') { if (data.symbol) setMonitoredSymbols((prev) => { const n = new Set(prev); n.delete(data.symbol!); return n; }); else setMonitoredSymbols(new Set()); }
    });
    return () => { if (flushTimerRef.current) clearTimeout(flushTimerRef.current); socket.disconnect(); };
  }, [scheduleFlush, userId]);

  useEffect(() => { if (userId && socketRef.current?.connected) socketRef.current.emit('join:user', userId); }, [userId]);

  /* fetch persisted alerts */
  useEffect(() => {
    if (!mounted || !userId) return;
    axios.get<{ success: boolean; alerts?: AlertData[] }>('/api/alerts').then((r) => { if (r.data.success && r.data.alerts?.length) setAlerts(r.data.alerts); }).catch(() => { });
  }, [mounted, userId]);

  /* poll ema status for selected */
  useEffect(() => {
    const symbol = displaySymbol; const timeframe = displayTimeframe;
    if (!symbol || !monitoredSymbols.has(symbol)) return;
    const key = watchKey(symbol, timeframe);
    const poll = async () => {
      try {
        const { data } = await axios.get<{ emas: Record<number, number | null>; warmupProgress: Record<number, number>; rsi?: RsiLive }>(`/api/ema-status?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`);
        if (data?.emas && Object.keys(data.emas).length) setEmaByKey((p) => ({ ...p, [key]: { ...p[key], ...data.emas } }));
        if (data?.warmupProgress && Object.keys(data.warmupProgress).length) setWarmupByKey((p) => ({ ...p, [key]: { ...p[key], ...data.warmupProgress } }));
        if (data?.rsi) setRsiByKey((p) => ({ ...p, [key]: data.rsi! }));
      } catch { /* ignore */ }
    };
    poll(); const id = setInterval(poll, 5000); return () => clearInterval(id);
  }, [displaySymbol, displayTimeframe, monitoredSymbols]);

  useEffect(() => { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); }, []);

  /* ---------- Search ---------- */
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchExchangeFilter, setSearchExchangeFilter] = useState<'ALL' | 'NSE' | 'NFO' | 'BSE'>('ALL');
  const [isSearching, setIsSearching] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const searchStocks = useCallback(async (query: string, filter: 'ALL' | 'NSE' | 'NFO' | 'BSE') => {
    if (!query || query.length < 1) { setSearchResults([]); return; }
    setIsSearching(true);
    try {
      const q = query.trim();
      if (filter !== 'ALL') {
        const res = await axios.post<{ success: boolean; results: SearchResult[] }>(`/api/search-symbols/${filter.toLowerCase()}`, { query: q });
        setSearchResults(res.data.success ? res.data.results : []);
      } else {
        const settled = await Promise.allSettled([
          axios.post<{ success: boolean; results: SearchResult[] }>('/api/search-symbols/nse', { query: q }),
          axios.post<{ success: boolean; results: SearchResult[] }>('/api/search-symbols/nfo', { query: q }),
          axios.post<{ success: boolean; results: SearchResult[] }>('/api/search-symbols/bse', { query: q }),
        ]);
        const seen = new Set<string>(); const merged: SearchResult[] = [];
        for (const s of settled) {
          if (s.status !== 'fulfilled' || !s.value?.data?.success || !Array.isArray(s.value.data.results)) continue;
          for (const r of s.value.data.results) { const k = `${r.exchange || 'NSE'}:${r.symbol}`; if (seen.has(k)) continue; seen.add(k); merged.push(r); }
        }
        setSearchResults(merged.slice(0, 30));
      }
    } catch { setSearchResults([]); } finally { setIsSearching(false); }
  }, []);

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedSearch = useCallback((query: string, filter: 'ALL' | 'NSE' | 'NFO' | 'BSE') => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (!query) { setSearchResults([]); return; }
    searchDebounceRef.current = setTimeout(() => searchStocks(query, filter), 380);
  }, [searchStocks]);

  useEffect(() => {
    if (searchOpen) { setTimeout(() => searchInputRef.current?.focus(), 240); }
    else { setSearchQuery(''); setSearchResults([]); setSearchExchangeFilter('ALL'); }
  }, [searchOpen]);

  const addSymbol = async (result: SearchResult) => {
    if (symbols.some((s) => s.symbol.toUpperCase() === result.symbol.toUpperCase())) { setSelectedSymbol(result.symbol); setSearchOpen(false); return; }
    const entry: MonitoredSymbol = { symbol: result.symbol, name: result.name, currency: result.currency || 'INR', exchange: result.exchange || 'NSE' };
    setSymbols((prev) => [...prev, entry]);
    setTimeframeBySymbol((prev) => ({ ...prev, [result.symbol]: DEFAULT_TIMEFRAME }));
    setEmasBySymbol((prev) => ({ ...prev, [result.symbol]: prev[result.symbol] ?? [9, 21, 50].map((p, i) => ({ id: Date.now() + i, period: p, color: COLORS[i % COLORS.length] })) }));
    setSelectedSymbol(result.symbol);
    setSearchOpen(false);
    if (userId) axios.post('/api/user/watchlist', { symbol: result.symbol }).catch(() => { });
  };

  const removeSymbol = async (sym: string) => {
    const tf = getTimeframe(sym);
    if (monitoredSymbols.has(sym)) { try { await axios.delete('/api/monitor', { data: { symbol: sym, timeframe: tf } }); } catch { /* ignore */ } setMonitoredSymbols((prev) => { const n = new Set(prev); n.delete(sym); return n; }); }
    const remaining = symbols.filter((s) => s.symbol !== sym);
    setSymbols(remaining);
    setTimeframeBySymbol((prev) => { const n = { ...prev }; delete n[sym]; return n; });
    setEmasBySymbol((prev) => { const n = { ...prev }; delete n[sym]; return n; });
    if (selectedSymbol === sym) setSelectedSymbol(remaining[0]?.symbol ?? null);
    const key = watchKey(sym, tf);
    setPriceByKey((prev) => { const n = { ...prev }; delete n[key]; return n; });
    setEmaByKey((prev) => { const n = { ...prev }; delete n[key]; return n; });
    if (userId) axios.delete('/api/user/watchlist', { params: { symbol: sym } }).catch(() => { });
  };

  /* ---------- Price fetch ---------- */
  const fetchPrice = useCallback(async (sym: string, tf: string, exchange?: string, skipLoading?: boolean) => {
    if (!sym) return;
    const exch = exchange ?? getExchange(sym);
    try {
      const res = await axios.post('/api/fetch-price', { symbol: sym, timeframe: tf, exchange: exch });
      const key = watchKey(sym, tf);
      if (res.data.success && res.data.data) {
        setPriceByKey((prev) => { const old = prev[key]; if (old) setFlash(key, res.data.data.price >= old.price ? 'flash-up' : 'flash-down'); return { ...prev, [key]: { price: res.data.data.price, change: res.data.data.change || 0, changePercent: res.data.data.changePercent || 0, currency: res.data.data.currency || 'INR', source: res.data.data.source || '', lastUpdate: new Date() } }; });
        setPriceErrorByKey((prev) => { const n = { ...prev }; delete n[key]; return n; });
      } else {
        setPriceErrorByKey((prev) => ({ ...prev, [key]: typeof res.data?.error === 'string' && res.data.error ? res.data.error : 'No price data for this symbol/timeframe (contract may be expired or illiquid).' }));
      }
    } catch { /* ignore */ } void skipLoading;
  }, [getExchange, setFlash]);

  /* ---------- Day summary (today/yesterday OHLC) for the Spotlight ---------- */
  const fetchDaySummary = useCallback(async (sym: string, exchange?: string) => {
    if (!sym) return;
    const exch = exchange ?? getExchange(sym);
    try {
      const res = await axios.post('/api/day-summary', { symbol: sym, exchange: exch });
      if (res.data.success && res.data.data) {
        setDaySummaryBySymbol((prev) => ({ ...prev, [sym]: res.data.data }));
      }
    } catch { /* ignore */ }
  }, [getExchange]);

  useEffect(() => {
    if (!mounted || !displaySymbol) return;
    fetchDaySummary(displaySymbol);
    const interval = setInterval(() => fetchDaySummary(displaySymbol), 60000);
    return () => clearInterval(interval);
  }, [mounted, displaySymbol, fetchDaySummary]);

  const timeframeFetchKey = useMemo(() => symbols.map((s) => `${s.symbol}:${timeframeBySymbol[s.symbol] ?? DEFAULT_TIMEFRAME}`).sort().join(','), [symbols, timeframeBySymbol]);
  const symbolsRef = useRef<MonitoredSymbol[]>(symbols); symbolsRef.current = symbols;
  const tfRef = useRef<Record<string, string>>(timeframeBySymbol); tfRef.current = timeframeBySymbol;
  const lastFetchedRef = useRef('');
  useEffect(() => {
    if (!symbols.length) return;
    if (lastFetchedRef.current === timeframeFetchKey) return;
    const prevMap: Record<string, string> = lastFetchedRef.current ? Object.fromEntries(lastFetchedRef.current.split(',').filter(Boolean).map((p) => { const i = p.indexOf(':'); return [p.slice(0, i), p.slice(i + 1)]; })) : {};
    const toFetch = symbolsRef.current.filter((s) => { const tf = tfRef.current[s.symbol] ?? DEFAULT_TIMEFRAME; const prev = prevMap[s.symbol]; return prev === undefined || prev !== tf; });
    lastFetchedRef.current = timeframeFetchKey;
    if (!toFetch.length) return;
    Promise.all(toFetch.map((s) => fetchPrice(s.symbol, tfRef.current[s.symbol] ?? DEFAULT_TIMEFRAME, s.exchange, true))).catch(() => { });
  }, [timeframeFetchKey, symbols.length, fetchPrice]);

  /* timeframe change (stops monitoring for that symbol if running) */
  const changeTimeframe = (sym: string, tf: string) => {
    const oldTf = getTimeframe(sym);
    if (monitoredSymbols.has(sym) && oldTf !== tf) {
      axios.delete('/api/monitor', { data: { symbol: sym, timeframe: oldTf } }).catch(() => { });
      setMonitoredSymbols((prev) => { const n = new Set(prev); n.delete(sym); return n; });
      if (userId) refetchWatches();
      const oldKey = watchKey(sym, oldTf);
      setEmaByKey((p) => { const n = { ...p }; delete n[oldKey]; return n; });
      setWarmupByKey((p) => { const n = { ...p }; delete n[oldKey]; return n; });
      setMonitorStatus(`Monitoring stopped — start again to use ${tf}`); setTimeout(() => setMonitorStatus(''), 4000);
    }
    setTimeframeBySymbol((prev) => ({ ...prev, [sym]: tf }));
  };

  /* ---------- EMA management ---------- */
  const stopMonitoringForSymbol = async (sym: string) => {
    const tf = getTimeframe(sym);
    try { await axios.delete('/api/monitor', { data: { symbol: sym, timeframe: tf } }); } catch { /* ignore */ }
    setMonitoredSymbols((prev) => { const n = new Set(prev); n.delete(sym); return n; });
    if (userId) refetchWatches();
    const key = watchKey(sym, tf);
    setEmaByKey((p) => { const n = { ...p }; delete n[key]; return n; });
    setWarmupByKey((p) => { const n = { ...p }; delete n[key]; return n; });
  };

  const addEma = (period?: number) => {
    if (!displaySymbol) return;
    const p = period || parseInt(newEmaPeriod, 10);
    if (!p || p <= 0) return;
    const current = emasBySymbol[displaySymbol] ?? [];
    if (current.some((e) => e.period === p)) return;
    setEmasBySymbol((prev) => ({ ...prev, [displaySymbol]: [...(prev[displaySymbol] ?? []), { id: Date.now(), period: p, color: COLORS[(prev[displaySymbol]?.length ?? 0) % COLORS.length] }].sort((a, b) => a.period - b.period) }));
    setNewEmaPeriod('');
    if (monitoredSymbols.has(displaySymbol)) { stopMonitoringForSymbol(displaySymbol); setMonitorStatus('Monitoring stopped — start again to apply EMA change'); setTimeout(() => setMonitorStatus(''), 4000); }
  };
  const removeEma = (id: number) => {
    if (!displaySymbol) return;
    setEmasBySymbol((prev) => ({ ...prev, [displaySymbol]: (prev[displaySymbol] ?? []).filter((e) => e.id !== id) }));
    if (monitoredSymbols.has(displaySymbol)) { stopMonitoringForSymbol(displaySymbol); setMonitorStatus('Monitoring stopped — start again to apply EMA change'); setTimeout(() => setMonitorStatus(''), 4000); }
  };

  const startMonitoringForSymbol = async (sym: string) => {
    if (restoringWatches || monitoringBusy) { setMonitorStatus('Please wait — monitoring is busy.'); return; }
    const symbolEmas = emasBySymbol[sym] ?? [];
    const emaOn = emaEnabledBySymbol[sym] ?? true;
    const symRsiUi = rsiBySymbol[sym] ?? EMPTY_RSI_UI;
    const tf = getTimeframe(sym);
    const rsiCheck = buildRsiPayload(symRsiUi, tf);
    const rsiOn = symRsiUi.enabled && rsiCheck.ok && !!rsiCheck.rsi;
    if (!emaOn && !rsiOn) { setMonitorStatus(`${sym}: enable EMA alerts, RSI alerts, or both.`); return; }
    if (emaOn && symbolEmas.length < 2) { setMonitorStatus(`${sym}: add at least 2 EMAs for crossover alerts.`); return; }
    if (!rsiCheck.ok) { setRsiFormError(rsiCheck.error); setMonitorStatus(`${sym}: ${rsiCheck.error}`); return; }
    const s = symbols.find((x) => x.symbol === sym); if (!s) return;
    try {
      setMonitoringBusy(true);
      setMonitorStatus(`Starting ${sym} — loading history and warming indicators (20–30s).`);
      const res = await axios.post('/api/monitor', { symbol: s.symbol, timeframe: tf, emaPeriods: symbolEmas.map((e) => e.period), trackBullish: emaOn ? trackBullish : false, trackBearish: emaOn ? trackBearish : false, exchange: s.exchange || 'NSE', currency: s.currency, rsi: rsiCheck.rsi });
      if (res.data.success) { setMonitoredSymbols((prev) => new Set(prev).add(sym)); setMonitorStatus(''); if (userId) refetchWatches(); }
      else setMonitorStatus(res.data.message || 'Failed');
    } catch { setMonitorStatus('Error'); } finally { setMonitoringBusy(false); }
  };

  const toggleMonitorSelected = () => {
    if (!displaySymbol) { setMonitorStatus('Add a symbol first.'); return; }
    if (monitoredSymbols.has(displaySymbol)) stopMonitoringForSymbol(displaySymbol);
    else startMonitoringForSymbol(displaySymbol);
  };

  /* ---------- Push / Email / Tools ---------- */
  const urlBase64ToUint8Array = (s: string): Uint8Array => {
    const pad = '='.repeat((4 - (s.length % 4)) % 4); const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64); const out = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i); return out;
  };
  const enablePush = async () => {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
      if ((await Notification.requestPermission()) !== 'granted') return;
      const reg = await navigator.serviceWorker.ready;
      const { data } = await axios.get<{ publicKey: string }>('/api/push-public-key');
      if (!data?.publicKey) return;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(data.publicKey) as BufferSource });
      await axios.post('/api/push-subscribe', sub.toJSON());
      setPushEnabled(true);
    } catch (e) { console.error('Push subscribe failed', e); }
  };
  const disablePush = async () => {
    if (!window.confirm('Turn alerts off? You will stop receiving push and in-app alerts until you enable them again.')) return;
    setPushEnabled(false);
    try { const reg = await navigator.serviceWorker?.ready; const sub = await reg?.pushManager?.getSubscription(); if (sub?.endpoint) { await axios.delete('/api/push-subscribe', { data: { endpoint: sub.endpoint } }); await sub.unsubscribe(); } } catch { /* ignore */ }
  };
  const sendTestEmail = async () => {
    setTestEmailStatus('sending'); setTestEmailMessage(null);
    try { const res = await axios.post<{ success: boolean; message?: string; error?: string; email?: string }>('/api/test-email'); if (res.data.success) { setTestEmailStatus('success'); setTestEmailMessage(res.data.message ?? (res.data.email ? `Sent to ${res.data.email}` : null)); } else { setTestEmailStatus('error'); setTestEmailMessage(res.data.error ?? 'Send failed'); } }
    catch { setTestEmailStatus('error'); setTestEmailMessage('Request failed'); }
    setTimeout(() => { setTestEmailStatus('idle'); setTestEmailMessage(null); }, 5000);
  };
  const sendTestPush = async (delaySeconds = 0) => {
    setTestPushStatus('sending'); setTestPushMessage(null);
    try { const res = await axios.post<{ success: boolean; message?: string; error?: string; sent?: number; scheduled?: boolean }>('/api/push-test', delaySeconds > 0 ? { delaySeconds } : {}); if (res.data.success) { setTestPushStatus('success'); setTestPushMessage(res.data.message ?? (res.data.sent != null ? `Sent to ${res.data.sent} device(s).` : 'Check your browser/tray.')); } else { setTestPushStatus('error'); setTestPushMessage((res.data.error ?? 'Send failed')); } }
    catch { setTestPushStatus('error'); setTestPushMessage('Network or server error.'); }
    setTimeout(() => { setTestPushStatus('idle'); setTestPushMessage(null); }, 6000);
  };
  const saveTelegramChatId = async () => {
    setTelegramStatus('saving'); setTelegramMessage(null);
    try {
      const res = await axios.put<{ success: boolean; error?: string }>('/api/user/telegram', { chatId: telegramChatId.trim() });
      if (res.data.success) { setTelegramStatus('success'); setTelegramMessage(telegramChatId.trim() ? 'Saved.' : 'Cleared.'); }
      else { setTelegramStatus('error'); setTelegramMessage(res.data.error || 'Save failed'); }
    } catch (e: any) { setTelegramStatus('error'); setTelegramMessage(e?.response?.data?.error || 'Save failed'); }
    setTimeout(() => { setTelegramStatus('idle'); setTelegramMessage(null); }, 5000);
  };
  const sendTelegramTest = async () => {
    setTelegramStatus('sending'); setTelegramMessage(null);
    try {
      const res = await axios.post<{ success: boolean; error?: string; message?: string }>('/api/user/telegram');
      if (res.data.success) { setTelegramStatus('success'); setTelegramMessage(res.data.message || 'Sent — check Telegram.'); }
      else { setTelegramStatus('error'); setTelegramMessage(res.data.error || 'Send failed'); }
    } catch (e: any) { setTelegramStatus('error'); setTelegramMessage(e?.response?.data?.error || 'Send failed'); }
    setTimeout(() => { setTelegramStatus('idle'); setTelegramMessage(null); }, 6000);
  };
  const disconnectTelegram = async () => {
    setTelegramStatus('saving'); setTelegramMessage(null);
    try {
      const res = await axios.put<{ success: boolean; error?: string }>('/api/user/telegram', { chatId: '' });
      if (res.data.success) { setTelegramChatId(''); setTelegramStatus('success'); setTelegramMessage('Disconnected.'); }
      else { setTelegramStatus('error'); setTelegramMessage(res.data.error || 'Failed'); }
    } catch (e: any) { setTelegramStatus('error'); setTelegramMessage(e?.response?.data?.error || 'Failed'); }
    setTimeout(() => { setTelegramStatus('idle'); setTelegramMessage(null); }, 5000);
  };
  const runCleanup = async () => {
    if (cleanupStatus === 'running') return;
    if (!window.confirm('Clean up your account? Removes duplicate symbol entries and stops orphan watches.')) return;
    setCleanupStatus('running'); setCleanupMessage(null);
    try {
      const res = await axios.post<{ success: boolean; duplicatesRemoved?: string[]; orphansStopped?: string[]; error?: string }>('/api/user/cleanup', {});
      if (res.data.success) { const d = res.data.duplicatesRemoved ?? []; const o = res.data.orphansStopped ?? []; setCleanupStatus('success'); setCleanupMessage(d.length || o.length ? [d.length && `Removed ${d.length} duplicate(s)`, o.length && `Stopped ${o.length} orphan(s)`].filter(Boolean).join(' · ') : 'Already tidy.'); if (userId) refetchWatches(); }
      else { setCleanupStatus('error'); setCleanupMessage(res.data.error ?? 'Cleanup failed'); }
    } catch (e: any) { setCleanupStatus('error'); setCleanupMessage(e?.response?.data?.error ?? 'Cleanup failed'); }
    setTimeout(() => { setCleanupStatus('idle'); setCleanupMessage(null); }, 8000);
  };

  /* ---------- Derived for view ---------- */
  type Combined = { kind: 'crossover'; data: AlertData } | { kind: 'rsi'; data: RsiAlertData };
  const combinedAlerts = useMemo<Combined[]>(() => {
    const xs: Combined[] = [];
    for (const a of alerts) xs.push({ kind: 'crossover', data: a });
    for (const a of rsiAlerts) xs.push({ kind: 'rsi', data: a });
    xs.sort((a, b) => new Date(b.data.timestamp).getTime() - new Date(a.data.timestamp).getTime());
    return xs;
  }, [alerts, rsiAlerts]);

  const todayAlerts = useMemo(
    () => combinedAlerts.filter((item) => isTodayTimestamp(item.data.timestamp)),
    [combinedAlerts],
  );

  const todayAlertItems = useMemo<TodayAlertItem[]>(() => {
    return todayAlerts.map((item) => {
      const at = new Date(item.data.timestamp);
      const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
      const day = at.toLocaleDateString('en-IN', { weekday: 'short' });
      if (item.kind === 'crossover') {
        const a = item.data;
        return {
          id: a.id,
          kind: 'ema' as const,
          symbol: a.symbol,
          bull: a.crossoverType === 'bullish',
          fastPeriod: a.fastPeriod,
          slowPeriod: a.slowPeriod,
          timeframe: a.timeframe,
          time,
          day,
          price: a.price,
          currency: a.currency,
        };
      }
      const a = item.data;
      return {
        id: a.id,
        kind: 'rsi' as const,
        symbol: a.symbol,
        bull: a.direction === 'bullish',
        signalType: a.signalType,
        period: a.period,
        rsiValue: a.rsiValue,
        timeframe: a.timeframe,
        time,
        day,
        price: a.price,
        currency: a.currency,
      };
    });
  }, [todayAlerts]);

  const stackedFor = (sym: string): 'bull' | 'bear' | null => {
    const tf = getTimeframe(sym); const vals = emaByKey[watchKey(sym, tf)]; const periods = (emasBySymbol[sym] ?? []).map((e) => e.period).sort((a, b) => a - b);
    if (!vals || periods.length < 2) return null;
    const f = vals[periods[0]]; const s = vals[periods[1]];
    if (f == null || s == null) return null;
    return f >= s ? 'bull' : 'bear';
  };
  const rsiFor = (sym: string): number | null => { const tf = getTimeframe(sym); return rsiByKey[watchKey(sym, tf)]?.value ?? null; };

  const sortedEmaPeriods = useMemo(() => emas.map((e) => e.period).sort((a, b) => a - b), [emas]);
  const spotFastP = sortedEmaPeriods[0]; const spotSlowP = sortedEmaPeriods[1];
  const spotFastVal = spotFastP != null ? (displayEmaValues[spotFastP] ?? null) : null;
  const spotSlowVal = spotSlowP != null ? (displayEmaValues[spotSlowP] ?? null) : null;

  const crossoverPairs = useMemo((): [number, number][] => {
    const ps = sortedEmaPeriods; const out: [number, number][] = [];
    for (let i = 0; i < ps.length - 1; i++) out.push([ps[i], ps[i + 1]]);
    return out;
  }, [sortedEmaPeriods]);

  const showLoadingModal = mounted && !!userId && restoringWatches;

  /* ============================================================
     RENDER
     ============================================================ */
  return (
    <div className={`ss-root ${dark ? 'dark' : ''}`}>
      {/* Topbar */}
      <header className="ss-topbar">
        <div className="ss-wordmark">
          <span className="ss-logo">
            <svg width={36} height={36} viewBox="0 0 40 40" fill="none" aria-hidden>
              <g stroke="#fff" strokeWidth={3.1} strokeLinecap="round">
                <line x1={11} y1={29} x2={11} y2={23} opacity={0.55} />
                <line x1={17} y1={29} x2={17} y2={19} opacity={0.78} />
                <line x1={23} y1={29} x2={23} y2={14} />
                <line x1={29} y1={29} x2={29} y2={9} />
              </g>
              <circle cx={29} cy={9} r={3.1} fill="#fff" />
            </svg>
          </span>
          <span className="ss-wordmark-text">
            <span className="ss-name">Signal<span className="ss-name-accent">Stack</span></span>
            <span className="ss-tag">EMA · RSI crossover alerts</span>
          </span>
        </div>
        <div className="ss-topbar-right">
          <LivePill connected={connected} />
          {userId && (
            <button type="button" className={`ss-icon-btn ${showTools ? 'active' : ''}`} onClick={() => setShowTools((s) => !s)} aria-label="Settings and tools">
              <Settings size={18} strokeWidth={2} />
            </button>
          )}
          <UserButton appearance={{ elements: { avatarBox: 'w-9 h-9' } }} />
        </div>
      </header>

      <main className="ss-content">
        {monitorStatus ? (
          <div className="ss-banner">
            <span className="ss-banner-text">{monitorStatus}</span>
          </div>
        ) : null}

        {/* tools drawer */}
        {userId && showTools && (
          <div className="cfg-card" style={{ marginBottom: 16 }}>
            <div className="tools">
              {mounted && 'serviceWorker' in navigator && pushAvailable !== false && (
                <button type="button" className={`tool-tile ${pushEnabled ? 'active' : ''}`} onClick={pushEnabled ? disablePush : enablePush}>
                  <Bell size={16} /><span>{pushEnabled ? 'Notifications on' : 'Enable notifications'}</span>
                </button>
              )}
              <button type="button" className="tool-tile" onClick={() => setDark((d) => !d)}>
                {dark ? <Sun size={16} /> : <Moon size={16} />}<span>{dark ? 'Light mode' : 'Dark mode'}</span>
              </button>
              <button type="button" className="tool-tile" onClick={sendTestEmail} disabled={testEmailStatus === 'sending'}>
                <Mail size={16} /><span>{testEmailStatus === 'sending' ? 'Sending…' : testEmailStatus === 'success' ? 'Email sent' : testEmailStatus === 'error' ? 'Email failed' : 'Test email'}</span>
              </button>
              <button type="button" className="tool-tile" onClick={() => sendTestPush(0)} disabled={testPushStatus === 'sending' || !pushEnabled}><Bell size={16} /><span>Test push now</span></button>
              <button type="button" className="tool-tile" onClick={() => sendTestPush(60)} disabled={testPushStatus === 'sending' || !pushEnabled}><Bell size={16} /><span>Test push later</span></button>
              <a href="/api/alert-log" download className="tool-tile"><Download size={16} /><span>Download log</span></a>
              <button type="button" className="tool-tile" onClick={runCleanup} disabled={cleanupStatus === 'running'}><Sparkles size={16} /><span>{cleanupStatus === 'running' ? 'Cleaning…' : cleanupStatus === 'success' ? 'Cleaned!' : 'Tidy account'}</span></button>
            </div>
            {(testEmailMessage || testPushMessage || cleanupMessage) && (
              <div className="tools-msg">
                {testEmailMessage && <div>Email: {testEmailMessage}</div>}
                {testPushMessage && <div>Push: {testPushMessage}</div>}
                {cleanupMessage && <div>Cleanup: {cleanupMessage}</div>}
              </div>
            )}
            <div className="tg-row">
              <div className="tg-label">
                <Send size={14} strokeWidth={2.2} />
                <span>Telegram alerts</span>
                {!telegramConfigured && <span className="tg-warn">bot not configured on server</span>}
              </div>

              {telegramChatId ? (
                <div className="tg-connect-row">
                  <span className="tg-connected-badge">✅ Connected</span>
                  <button type="button" className="tool-tile" onClick={sendTelegramTest} disabled={telegramStatus === 'sending' || !telegramConfigured}>
                    <Send size={14} /><span>{telegramStatus === 'sending' ? 'Sending…' : 'Test'}</span>
                  </button>
                  <button type="button" className="tool-tile" onClick={disconnectTelegram} disabled={telegramStatus === 'saving'}>
                    <X size={14} /><span>{telegramStatus === 'saving' ? 'Removing…' : 'Disconnect'}</span>
                  </button>
                </div>
              ) : telegramConnectUrl ? (
                <>
                  <div className="tg-connect-row">
                    <a className="tool-tile tg-connect-btn" href={telegramConnectUrl} target="_blank" rel="noreferrer noopener">
                      <Send size={14} /><span>Connect Telegram</span>
                    </a>
                  </div>
                  <div className="tg-hint">
                    Tap <b>Connect Telegram</b>, then press <b>Start</b> in the chat that opens —
                    we link it to your account automatically, no chat id to find.
                  </div>
                </>
              ) : (
                <div className="tg-hint">
                  {telegramConfigured
                    ? 'Bot username unavailable right now — reopen this panel in a moment.'
                    : <>Server admin: set <code>TELEGRAM_BOT_TOKEN</code> to enable Telegram alerts.</>}
                </div>
              )}

              <details className="tg-advanced">
                <summary>Advanced: enter chat id manually</summary>
                <div className="tg-input-row">
                  <input
                    className="tg-input"
                    inputMode="numeric"
                    placeholder="Your Telegram chat id (e.g. 123456789)"
                    value={telegramChatId}
                    onChange={(e) => setTelegramChatId(e.target.value.replace(/[^\d-]/g, ''))}
                  />
                  <button type="button" className="tool-tile" onClick={saveTelegramChatId} disabled={telegramStatus === 'saving'}>
                    <Check size={14} /><span>{telegramStatus === 'saving' ? 'Saving…' : 'Save'}</span>
                  </button>
                </div>
                <div className="tg-hint">
                  Open <code>@BotFather</code> → create or pick a bot, DM it, send <code>/start</code> —
                  the bot replies with what to do next.
                </div>
              </details>

              {telegramMessage && <div className="tools-msg">Telegram: {telegramMessage}</div>}
            </div>
          </div>
        )}

        {symbols.length === 0 ? (
          <EmptyState onAdd={() => setSearchOpen(true)} />
        ) : tab === 'live' ? (
          <>
          <div className="dash">
            <div className="dash-main">
              {displaySymbol && (
                <Spotlight
                  symbol={displaySymbol}
                  name={symbols.find((s) => s.symbol === displaySymbol)?.name}
                  exchange={getExchange(displaySymbol)}
                  currency={symbols.find((s) => s.symbol === displaySymbol)?.currency ?? 'INR'}
                  price={displayPrice?.price ?? null}
                  change={displayPrice?.change ?? 0}
                  changePercent={displayPrice?.changePercent ?? 0}
                  flash={flashByKey[displayKey] ?? ''}
                  priceError={displayPrice ? undefined : displayPriceError}
                  emaTimeframe={displayTimeframe}
                  rsiTimeframe={rsiUi.timeframe || undefined}
                  fastPeriod={spotFastP}
                  slowPeriod={spotSlowP}
                  fastVal={spotFastVal}
                  slowVal={spotSlowVal}
                  rsi={liveRsi?.value ?? null}
                  rsiPeriod={liveRsi?.period ?? parseInt(rsiUi.period || '14', 10)}
                  connected={connected}
                  daySummary={daySummaryBySymbol[displaySymbol] ?? null}
                />
              )}

              {/* panels */}
              <div className="panels">
                <div className="detail-grid">
                  <div className="panel">
                    <div className="panel-head">
                      <span className="panel-title"><Layers size={14} strokeWidth={2.2} /> EMA stack</span>
                      {stackedFor(displaySymbol ?? '') && <span className={`stack-state ${stackedFor(displaySymbol ?? '')}`}>{stackedFor(displaySymbol ?? '') === 'bull' ? 'Bullish' : 'Bearish'}</span>}
                    </div>
                    <div className="ema-vals">
                      {emas.length === 0 ? (
                        <div className="ema-empty">No EMAs yet — add them in Indicators.</div>
                      ) : [...emas].sort((a, b) => a.period - b.period).map((e) => {
                        const warm = displaySymbol ? (warmupByKey[displayKey]?.[e.period] ?? (monitoredSymbols.has(displaySymbol) ? 0 : 1)) : 1;
                        const val = displayEmaValues[e.period];
                        const ready = warm >= 1;
                        return (
                          <div key={e.id} className="ema-val-row">
                            <span className="ema-dot" style={{ background: e.color }} />
                            <span className="ema-period">EMA {e.period}</span>
                            <div className="ema-bar"><span style={{ width: `${Math.round(warm * 100)}%`, background: e.color }} /></div>
                            <span className="ema-num">{ready && val != null ? val.toFixed(2) : `${Math.round(warm * 100)}%`}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div className="panel">
                    <div className="panel-head"><span className="panel-title"><Activity size={14} strokeWidth={2.2} /> RSI ({liveRsi?.period ?? rsiUi.period})</span></div>
                    <RsiMeter value={liveRsi?.value ?? null} period={liveRsi?.period ?? parseInt(rsiUi.period || '14', 10)} warmup={liveRsi?.warmupProgress ?? 1}
                      overbought={parseInt(rsiUi.overbought || '70', 10)} oversold={parseInt(rsiUi.oversold || '30', 10)} />
                  </div>
                </div>
                <button type="button" className="detail-config-btn" onClick={() => setTab('config')}>
                  <Settings size={16} strokeWidth={2.2} /> Configure indicators
                  <ChevronRight size={16} strokeWidth={2.2} style={{ marginLeft: 'auto' }} />
                </button>
              </div>
            </div>

            {/* watchlist */}
            <div className="watchlist">
              <div className="section-head"><span className="section-title">Watchlist</span><span className="section-count">{symbols.length}</span></div>
              <div className="watch-rows">
                {symbols.map((s) => {
                  const tf = getTimeframe(s.symbol); const key = watchKey(s.symbol, tf); const pr = priceByKey[key];
                  return (
                    <WatchRow key={s.symbol}
                      symbol={s.symbol} name={s.name} exchange={s.exchange || 'NSE'} currency={s.currency}
                      price={pr?.price ?? null} changePercent={pr?.changePercent ?? 0} flash={flashByKey[key] ?? ''}
                      emaPeriods={(emasBySymbol[s.symbol] ?? []).map((e) => e.period).sort((a, b) => a - b)}
                      stacked={stackedFor(s.symbol)} rsi={rsiFor(s.symbol)}
                      monitoring={monitoredSymbols.has(s.symbol)} selected={s.symbol === displaySymbol}
                      onSelect={() => setSelectedSymbol(s.symbol)} />
                  );
                })}
              </div>
            </div>
          </div>

          <TodayAlerts items={todayAlertItems} />
          </>
        ) : (
          /* ---------- Config tab ---------- */
          <ConfigScreen
            symbol={displaySymbol}
            emaTimeframe={displayTimeframe}
            onEmaTimeframe={(tf) => displaySymbol && changeTimeframe(displaySymbol, tf)}
            emas={emas}
            emaAlertsEnabled={emaAlertsEnabled}
            onToggleEma={updateEmaEnabled}
            onAddEma={addEma}
            onRemoveEma={removeEma}
            newEmaPeriod={newEmaPeriod}
            setNewEmaPeriod={setNewEmaPeriod}
            crossoverPairs={crossoverPairs}
            rsiUi={rsiUi}
            updateRsi={updateRsi}
            rsiFormError={rsiFormError}
            trackBullish={trackBullish}
            trackBearish={trackBearish}
            onTrackBullish={() => { setTrackBullish((v) => !v); if (displaySymbol && monitoredSymbols.has(displaySymbol)) stopMonitoringForSymbol(displaySymbol); }}
            onTrackBearish={() => { setTrackBearish((v) => !v); if (displaySymbol && monitoredSymbols.has(displaySymbol)) stopMonitoringForSymbol(displaySymbol); }}
            monitoring={!!displaySymbol && monitoredSymbols.has(displaySymbol)}
            busy={monitoringBusy || restoringWatches}
            onToggleMonitor={toggleMonitorSelected}
            onRemoveSymbol={() => displaySymbol && removeSymbol(displaySymbol)}
            monitorStatus={monitorStatus}
          />
        )}
      </main>

      <BottomNav tab={tab} onTab={setTab} onAdd={() => setSearchOpen(true)} />

      {searchOpen && (
        <SearchSheet
          inputRef={searchInputRef}
          query={searchQuery}
          onQuery={(v) => { setSearchQuery(v); debouncedSearch(v, searchExchangeFilter); }}
          filter={searchExchangeFilter}
          onFilter={(f) => { setSearchExchangeFilter(f); if (searchQuery.trim()) debouncedSearch(searchQuery, f); }}
          results={searchResults}
          isSearching={isSearching}
          existing={symbols.map((s) => s.symbol)}
          onAdd={addSymbol}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {showLoadingModal && (
        <div className="ss-modal-scrim">
          <div className="ss-modal">
            <RefreshCw size={36} className="ss-spin" style={{ color: 'var(--accent)', marginBottom: 14 }} />
            <h3 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, margin: '0 0 8px' }}>Preparing your watches</h3>
            <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, margin: 0 }}>Fetching up to 90 days of price data and warming EMAs. This can take a moment.</p>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   Sub-views
   ============================================================ */
function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="spot" style={{ textAlign: 'center', padding: '40px 24px' }}>
      <div className="spot-glow" />
      <h1 className="spot-symbol" style={{ fontSize: 'clamp(26px,8vw,38px)' }}>Add your first symbol</h1>
      <p className="spot-name" style={{ maxWidth: 360, margin: '10px auto 22px' }}>
        Search NSE, NFO or BSE, set your EMA periods and RSI, then start monitoring for crossover alerts.
      </p>
      <button type="button" className="monitor-cta go" style={{ maxWidth: 280, margin: '0 auto' }} onClick={onAdd}>
        <Plus size={18} strokeWidth={2.4} /> Search symbols
      </button>
    </div>
  );
}

function Toggle({ on, disabled, onChange }: { on: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" className={`toggle ${on ? 'on' : ''}`} disabled={disabled} onClick={() => onChange(!on)} role="switch" aria-checked={on}>
      <span className="toggle-knob" />
    </button>
  );
}

interface ConfigProps {
  symbol: string | null;
  emaTimeframe: string;
  onEmaTimeframe: (tf: string) => void;
  emas: EMA[]; emaAlertsEnabled: boolean; onToggleEma: (v: boolean) => void;
  onAddEma: (p?: number) => void; onRemoveEma: (id: number) => void;
  newEmaPeriod: string; setNewEmaPeriod: (v: string) => void;
  crossoverPairs: [number, number][];
  rsiUi: RsiUiConfig; updateRsi: (u: (p: RsiUiConfig) => RsiUiConfig) => void; rsiFormError: string | null;
  trackBullish: boolean; trackBearish: boolean; onTrackBullish: () => void; onTrackBearish: () => void;
  monitoring: boolean; busy: boolean; onToggleMonitor: () => void; onRemoveSymbol: () => void; monitorStatus: string;
}

function ConfigScreen(p: ConfigProps) {
  const QUICK = [9, 21, 50, 100, 200];
  if (!p.symbol) {
    return <div className="config"><div className="cfg-card" style={{ textAlign: 'center', color: 'var(--muted)' }}>Select or add a symbol to configure indicators.</div></div>;
  }
  const dirLabel = [p.trackBullish && 'Bull', p.trackBearish && 'Bear'].filter(Boolean).join(' + ') || 'None';
  return (
    <div className="config">
      <div className="config-head">
        <div>
          <span className="config-eyebrow">Configuring</span>
          <h2 className="config-symbol">{p.symbol}</h2>
        </div>
        <DirTag dir={p.trackBearish && !p.trackBullish ? 'bear' : 'bull'} label={dirLabel} />
      </div>

      {/* EMA */}
      <div className="cfg-card">
        <div className="cfg-card-head"><span className="cfg-title"><Layers size={16} strokeWidth={2.2} /> EMA crossover</span><Toggle on={p.emaAlertsEnabled} onChange={p.onToggleEma} /></div>
        <div className={`cfg-body ${p.emaAlertsEnabled ? '' : 'dim'}`}>
          <span className="cfg-label">EMA timeframe</span>
          <div className="spot-tf" style={{ marginBottom: 12 }}>
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                type="button"
                className={`tf ${p.emaTimeframe === tf ? 'active' : ''}`}
                onClick={() => p.onEmaTimeframe(tf)}
              >
                {tf}
              </button>
            ))}
          </div>
          <span className="cfg-label">Active periods</span>
          <div className="ema-pills">
            {[...p.emas].sort((a, b) => a.period - b.period).map((e) => (
              <span key={e.id} className="ema-pill" style={{ '--pc': e.color } as React.CSSProperties}>
                <i className="ema-pill-dot" />{e.period}
                <button type="button" onClick={() => p.onRemoveEma(e.id)} aria-label={`Remove EMA ${e.period}`}><X size={12} strokeWidth={2.6} /></button>
              </span>
            ))}
            <div className="ema-add">
              <input inputMode="numeric" placeholder="+ add" value={p.newEmaPeriod}
                onChange={(e) => p.setNewEmaPeriod(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => { if (e.key === 'Enter') p.onAddEma(); }} />
            </div>
          </div>
          <div className="quick-row">
            {QUICK.map((q) => <button key={q} type="button" className="quick-ema" disabled={p.emas.some((e) => e.period === q)} onClick={() => p.onAddEma(q)}>{q}</button>)}
          </div>
          <span className="cfg-label" style={{ marginTop: 14 }}>Crossover pairs tracked</span>
          {p.crossoverPairs.length === 0 ? (
            <div className="pair-empty">Add at least two EMAs to track a crossover.</div>
          ) : (
            <div className="pair-list">
              {p.crossoverPairs.map(([f, s]) => (
                <div key={`${f}-${s}`} className="pair-item">
                  <span className="pair-fast">{f}</span><Activity size={13} strokeWidth={2.2} /><span className="pair-slow">{s}</span>
                  <span className="pair-label">fast / slow</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* RSI */}
      <div className="cfg-card">
        <div className="cfg-card-head"><span className="cfg-title"><Activity size={16} strokeWidth={2.2} /> RSI signals</span>
          <Toggle on={p.rsiUi.enabled} onChange={(v) => p.updateRsi((prev) => ({ ...prev, enabled: v, ...(v ? { signals: { ...DEFAULT_RSI_SIGNALS } } : {}) }))} />
        </div>
        <div className={`cfg-body ${p.rsiUi.enabled ? '' : 'dim'}`}>
          <span className="cfg-label">RSI timeframe</span>
          <div className="spot-tf" style={{ marginBottom: 12 }}>
            {TIMEFRAMES.map((tf) => {
              const active = (p.rsiUi.timeframe || p.emaTimeframe) === tf;
              const isDefault = !p.rsiUi.timeframe && tf === p.emaTimeframe;
              return (
                <button key={tf} type="button" className={`tf ${active ? 'active' : ''}`}
                  onClick={() => p.updateRsi((prev) => ({ ...prev, timeframe: tf === p.emaTimeframe ? '' : tf }))}>
                  {tf}{isDefault ? '*' : ''}
                </button>
              );
            })}
          </div>
          <div className="rsi-fields">
            <label className="rsi-field"><span>Period</span><input inputMode="numeric" value={p.rsiUi.period} onChange={(e) => p.updateRsi((prev) => ({ ...prev, period: e.target.value.replace(/\D/g, '') }))} /></label>
            <label className="rsi-field"><span>Overbought</span><input inputMode="numeric" value={p.rsiUi.overbought} onChange={(e) => p.updateRsi((prev) => ({ ...prev, overbought: e.target.value.replace(/\D/g, '') }))} /></label>
            <label className="rsi-field"><span>Oversold</span><input inputMode="numeric" value={p.rsiUi.oversold} onChange={(e) => p.updateRsi((prev) => ({ ...prev, oversold: e.target.value.replace(/\D/g, '') }))} /></label>
          </div>
          <span className="cfg-label" style={{ marginTop: 14 }}>Alert on</span>
          <div className="signal-list">
            {RSI_SIGNAL_ORDER.map((key) => {
              const on = p.rsiUi.signals[key];
              return (
                <div key={key}>
                  <button type="button" className={`signal-item ${on ? 'on' : ''}`} onClick={() => p.updateRsi((prev) => ({ ...prev, signals: { ...prev.signals, [key]: !prev.signals[key] } }))}>
                    <span className="signal-check">{on && <Check size={13} strokeWidth={3} />}</span>
                    {RSI_SIGNAL_LABELS_LONG[key]}
                  </button>
                  {key === 'signalLineCross' && on && (
                    <div className="signal-sub">EMA length
                      <input inputMode="numeric" value={p.rsiUi.signalLineLength} onChange={(e) => p.updateRsi((prev) => ({ ...prev, signalLineLength: e.target.value.replace(/\D/g, '') }))} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {p.rsiFormError && <div className="cfg-error">{p.rsiFormError}</div>}
        </div>
      </div>

      {/* Direction */}
      <div className="cfg-card">
        <div className="cfg-card-head"><span className="cfg-title"><Zap size={16} strokeWidth={2.2} /> Track direction</span></div>
        <div className="cfg-body">
          <div className="dir-toggles">
            <button type="button" className={`dir-toggle bull ${p.trackBullish ? 'on' : ''}`} onClick={p.onTrackBullish}><TrendingUp size={16} strokeWidth={2.4} /> Bullish</button>
            <button type="button" className={`dir-toggle bear ${p.trackBearish ? 'on' : ''}`} onClick={p.onTrackBearish}><TrendingDown size={16} strokeWidth={2.4} /> Bearish</button>
          </div>
        </div>
      </div>

      <button type="button" className={`monitor-cta ${p.monitoring ? 'halt' : 'go'}`} onClick={p.onToggleMonitor} disabled={p.busy}>
        <Power size={18} strokeWidth={2.4} /> {p.monitoring ? `Stop monitoring ${p.symbol}` : `Start monitoring ${p.symbol}`}
      </button>
      {p.monitorStatus && <div className="cfg-status">{p.monitorStatus}</div>}

      <button type="button" className="detail-config-btn" style={{ color: 'var(--bear)' }} onClick={p.onRemoveSymbol}>
        <Trash2 size={16} strokeWidth={2.2} /> Remove {p.symbol} from watchlist
      </button>
    </div>
  );
}

interface SearchSheetProps {
  inputRef: React.RefObject<HTMLInputElement | null>;
  query: string; onQuery: (v: string) => void;
  filter: 'ALL' | 'NSE' | 'NFO' | 'BSE'; onFilter: (f: 'ALL' | 'NSE' | 'NFO' | 'BSE') => void;
  results: SearchResult[]; isSearching: boolean; existing: string[];
  onAdd: (r: SearchResult) => void; onClose: () => void;
}
function SearchSheet(p: SearchSheetProps) {
  const EX: Array<'ALL' | 'NSE' | 'NFO' | 'BSE'> = ['ALL', 'NSE', 'NFO', 'BSE'];
  return (
    <div className="sheet-scrim" onClick={p.onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Add symbol">
        <div className="sheet-grab" />
        <div className="sheet-head"><h3>Add symbol</h3><button type="button" className="sheet-close" onClick={p.onClose} aria-label="Close"><X size={18} strokeWidth={2.4} /></button></div>
        <div className="search-box">
          <Search size={18} strokeWidth={2.2} />
          <input ref={p.inputRef} value={p.query} onChange={(e) => p.onQuery(e.target.value)} placeholder="Search RELIANCE, NIFTY 50, BANKNIFTY…" />
          {p.query && <button type="button" onClick={() => p.onQuery('')} aria-label="Clear"><X size={16} strokeWidth={2.4} /></button>}
        </div>
        <div className="ex-filters">{EX.map((e) => <button key={e} type="button" className={`ex-chip ${p.filter === e ? 'active' : ''}`} onClick={() => p.onFilter(e)}>{e}</button>)}</div>
        <div className="results">
          {p.results.length === 0 ? (
            <div className="results-empty">{p.isSearching ? 'Searching…' : p.query ? 'No symbols found. Try “RELIANCE” or “NIFTY 50”.' : 'Type to search NSE, NFO and BSE.'}</div>
          ) : p.results.map((r) => {
            const added = p.existing.includes(r.symbol); const meta = optionMeta(r.symbol, r.exchange);
            return (
              <button key={`${r.symbol}-${r.exchange}`} type="button" className="result-row" disabled={added} onClick={() => p.onAdd(r)}>
                <div>
                  <div className="result-symrow">
                    <span className="result-symbol">{r.symbol}</span>
                    <span className={`result-exch ex-${r.exchange}`}>{r.exchange}</span>
                    {meta.side && <span className={`result-side ${meta.side === 'CE' ? 'ce' : 'pe'}`}>{meta.side}</span>}
                  </div>
                  <span className="result-name">{r.name}</span>
                </div>
                {added ? <span className="result-added"><Check size={14} strokeWidth={2.6} /> Added</span> : <span className="result-add"><Plus size={16} strokeWidth={2.6} /></span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
