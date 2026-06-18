import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, ActivityIndicator, Modal, Pressable } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';
import { Activity, Plus, SlidersHorizontal, Settings as SettingsIcon, Layers, User, LogOut, X } from 'lucide-react-native';
import { useAuth, useUser, useClerk } from '@clerk/clerk-expo';
import { useTheme, DEFAULT_TIMEFRAME, COLORS } from '@/lib/theme';
import { api, setAuthToken } from '@/lib/api';
import { getSocket, joinUserRoom } from '@/lib/socket';
import { MonitoredWatch, SymbolMeta, PriceInfo, RsiLive, EMA, SearchResult, CrossoverAlert, RsiAlert, DaySummary } from '@/lib/types';
import { Spotlight } from '@/components/Spotlight';
import { WatchRow } from '@/components/WatchRow';
import { RsiMeter } from '@/components/RsiMeter';
import { LivePill } from '@/components/LivePill';
import { SearchSheet } from './SearchSheet';
import { ConfigScreen, RsiUiConfig, EMPTY_RSI_UI, buildRsiPayload } from './ConfigScreen';
import { ToolsScreen } from './ToolsScreen';

function watchKey(symbol: string, timeframe: string) { return `${symbol.toUpperCase()}:${timeframe}`; }

function rsiPayloadToUi(p: any): RsiUiConfig {
  if (!p || !p.enabled) return EMPTY_RSI_UI;
  return {
    enabled: true,
    period: String(p.period),
    overbought: String(p.overbought),
    oversold: String(p.oversold),
    signalLineLength: p.signalLineLength != null ? String(p.signalLineLength) : '14',
    timeframe: p.timeframe || '',
    signals: { ...p.signals },
  };
}

function Logo({ size = 36, color = '#fff' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <Line x1={11} y1={29} x2={11} y2={23} stroke={color} strokeWidth={3.1} strokeLinecap="round" opacity={0.55} />
      <Line x1={17} y1={29} x2={17} y2={19} stroke={color} strokeWidth={3.1} strokeLinecap="round" opacity={0.78} />
      <Line x1={23} y1={29} x2={23} y2={14} stroke={color} strokeWidth={3.1} strokeLinecap="round" />
      <Line x1={29} y1={29} x2={29} y2={9} stroke={color} strokeWidth={3.1} strokeLinecap="round" />
      <Circle cx={29} cy={9} r={3.1} fill={color} />
    </Svg>
  );
}

function EmptyState({ onAdd, t }: { onAdd: () => void; t: ReturnType<typeof useTheme> }) {
  return (
    <View style={[styles.emptyCard, { backgroundColor: t.surface, borderColor: t.border }]}>
      <Text style={[styles.emptyTitle, { color: t.ink }]}>Add your first symbol</Text>
      <Text style={[styles.emptySub, { color: t.muted }]}>
        Search NSE, NFO or BSE, set your EMA periods and RSI, then start monitoring for crossover alerts.
      </Text>
      <TouchableOpacity activeOpacity={0.85} style={[styles.emptyCta, { backgroundColor: t.accent }]} onPress={onAdd}>
        <Plus size={18} color="#fff" />
        <Text style={styles.emptyCtaTxt}>Search symbols</Text>
      </TouchableOpacity>
    </View>
  );
}

export function HomeScreen() {
  const t = useTheme();
  const { userId, getToken } = useAuth();
  const { user } = useUser();
  const { signOut } = useClerk();
  const [tab, setTab] = useState<'live' | 'config' | 'tools'>('live');
  const [accountOpen, setAccountOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [connected, setConnected] = useState(false);

  const [symbols, setSymbols] = useState<SymbolMeta[]>([]);
  const [tfBySymbol, setTfBySymbol] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [emasBySymbol, setEmasBySymbol] = useState<Record<string, EMA[]>>({});
  const [rsiBySymbol, setRsiBySymbol] = useState<Record<string, RsiUiConfig>>({});
  const [emaEnabledBySymbol, setEmaEnabledBySymbol] = useState<Record<string, boolean>>({});
  const [trackBullish, setTrackBullish] = useState(true);
  const [trackBearish, setTrackBearish] = useState(true);
  const [monitored, setMonitored] = useState<Set<string>>(new Set());

  const [priceByKey, setPriceByKey] = useState<Record<string, PriceInfo>>({});
  const [emaByKey, setEmaByKey] = useState<Record<string, Record<number, number | null>>>({});
  const [warmupByKey, setWarmupByKey] = useState<Record<string, Record<number, number>>>({});
  const [rsiByKey, setRsiByKey] = useState<Record<string, RsiLive>>({});
  const [daySummaryBySymbol, setDaySummaryBySymbol] = useState<Record<string, DaySummary>>({});
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(true);

  const getTf = (s: string) => tfBySymbol[s] ?? DEFAULT_TIMEFRAME;
  const displaySymbol = selected ?? symbols[0]?.symbol ?? null;
  const displayTf = displaySymbol ? getTf(displaySymbol) : DEFAULT_TIMEFRAME;
  const displayKey = displaySymbol ? watchKey(displaySymbol, displayTf) : '';
  const displayPrice = displaySymbol ? priceByKey[displayKey] : undefined;
  const liveRsi = displaySymbol ? rsiByKey[displayKey] : undefined;
  const emas = displaySymbol ? (emasBySymbol[displaySymbol] ?? []) : [];
  const sortedPeriods = useMemo(() => emas.map((e) => e.period).sort((a, b) => a - b), [emas]);
  const rsiUi = displaySymbol ? (rsiBySymbol[displaySymbol] ?? EMPTY_RSI_UI) : EMPTY_RSI_UI;
  const emaAlertsEnabled = displaySymbol ? (emaEnabledBySymbol[displaySymbol] ?? true) : true;

  // Today / yesterday OHLC for the Spotlight.
  useEffect(() => {
    if (!displaySymbol) return;
    const sym = displaySymbol;
    const exchange = symbols.find((s) => s.symbol === sym)?.exchange ?? 'NSE';
    const load = () => {
      api.post<{ success: boolean; data?: DaySummary }>('/api/day-summary', { symbol: sym, exchange })
        .then((r) => { if (r.data.success && r.data.data) setDaySummaryBySymbol((prev) => ({ ...prev, [sym]: r.data.data as DaySummary })); })
        .catch(() => { /* ignore */ });
    };
    load();
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, [displaySymbol, symbols]);

  // Push a fresh JWT into axios on every render where userId is present.
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const tok = await getToken();
      if (alive) setAuthToken(tok || null);
    };
    refresh();
    const id = setInterval(refresh, 50_000);
    return () => { alive = false; clearInterval(id); };
  }, [getToken, userId]);

  // Restore watches/config
  useEffect(() => {
    if (!userId) return;
    (async () => {
      try {
        // Ensure the JWT is in axios *before* the first call. The other token
        // refresh effect races with this one — without this, the initial
        // /api/user/config goes out without auth, gets 401, and we silently
        // render an empty UI.
        const tok = await getToken();
        if (tok) setAuthToken(tok);
        const [cfg, watches] = await Promise.all([
          api.get<{ success: boolean; config?: any }>('/api/user/config').catch((e) => { if (__DEV__) console.warn('[restore] /api/user/config failed:', e?.response?.status, e?.message); return null; }),
          api.get<{ success: boolean; watches?: MonitoredWatch[] }>('/api/user/watches').catch((e) => { if (__DEV__) console.warn('[restore] /api/user/watches failed:', e?.response?.status, e?.message); return null; }),
        ]);
        if (cfg?.data.success && cfg.data.config) {
          const c = cfg.data.config;
          if (Array.isArray(c.symbols)) setSymbols(c.symbols);
          if (c.timeframeBySymbol) setTfBySymbol(c.timeframeBySymbol);
          if (c.emasBySymbol) setEmasBySymbol(c.emasBySymbol);
          setTrackBullish(c.trackBullish !== false);
          setTrackBearish(c.trackBearish !== false);
          if (c.selectedSymbol) setSelected(c.selectedSymbol);
        }
        if (watches?.data.success && Array.isArray(watches.data.watches)) {
          const rsiMap: Record<string, RsiUiConfig> = {};
          const emaEnabledMap: Record<string, boolean> = {};
          const mon = new Set<string>();
          for (const w of watches.data.watches) {
            mon.add(w.symbol);
            if (w.rsi) rsiMap[w.symbol] = rsiPayloadToUi(w.rsi);
            emaEnabledMap[w.symbol] = w.trackBullish || w.trackBearish;
          }
          setMonitored(mon);
          setRsiBySymbol((p) => ({ ...rsiMap, ...p }));
          setEmaEnabledBySymbol((p) => ({ ...emaEnabledMap, ...p }));
        }
      } finally {
        setRestoring(false);
      }
    })();
  }, [userId]);

  // Socket wiring
  useEffect(() => {
    const s = getSocket();
    const onConnect = () => { setConnected(true); if (userId) joinUserRoom(userId); };
    const onDisconnect = () => setConnected(false);
    const onPrice = (data: any) => {
      const k = watchKey(data.symbol, data.timeframe ?? DEFAULT_TIMEFRAME);
      setPriceByKey((p) => ({ ...p, [k]: { price: data.price, change: data.change ?? 0, changePercent: data.changePercent ?? 0, currency: data.currency ?? 'INR', source: data.source ?? '', lastUpdate: new Date() } }));
    };
    const onEma = (data: any) => {
      const k = watchKey(data.symbol, data.timeframe ?? DEFAULT_TIMEFRAME);
      if (data.emas) setEmaByKey((p) => ({ ...p, [k]: { ...p[k], ...data.emas } }));
      if (data.warmupProgress) setWarmupByKey((p) => ({ ...p, [k]: data.warmupProgress }));
      if (data.rsi) setRsiByKey((p) => ({ ...p, [k]: data.rsi }));
    };
    const onCross = (a: CrossoverAlert) => {
      // The OS notification is delivered separately via Expo push. Here we
      // could push to in-app alert list — keep concise for the scaffold.
    };
    const onRsi = (a: RsiAlert) => { /* idem */ };
    s.on('connect', onConnect); s.on('disconnect', onDisconnect);
    s.on('price:update', onPrice); s.on('ema:update', onEma);
    s.on('alert:crossover', onCross); s.on('alert:rsi', onRsi);
    if (s.connected && userId) joinUserRoom(userId);
    return () => {
      s.off('connect', onConnect); s.off('disconnect', onDisconnect);
      s.off('price:update', onPrice); s.off('ema:update', onEma);
      s.off('alert:crossover', onCross); s.off('alert:rsi', onRsi);
    };
  }, [userId]);

  // Initial price fetch for each symbol on the current timeframe
  useEffect(() => {
    if (!symbols.length) return;
    symbols.forEach(async (s) => {
      const tf = getTf(s.symbol);
      try {
        const r = await api.post<{ success: boolean; data?: any }>('/api/fetch-price', { symbol: s.symbol, timeframe: tf, exchange: s.exchange || 'NSE' });
        if (r.data.success && r.data.data) {
          const d = r.data.data;
          setPriceByKey((p) => ({ ...p, [watchKey(s.symbol, tf)]: { price: d.price, change: d.change || 0, changePercent: d.changePercent || 0, currency: d.currency || 'INR', source: d.source || '', lastUpdate: new Date() } }));
        }
      } catch { /* noop */ }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbols.length]);

  // Add / remove symbols
  const addSymbol = async (r: SearchResult) => {
    if (symbols.some((s) => s.symbol === r.symbol)) { setSelected(r.symbol); setSearchOpen(false); return; }
    const entry: SymbolMeta = { symbol: r.symbol, name: r.name, currency: r.currency || 'INR', exchange: r.exchange || 'NSE' };
    setSymbols((p) => [...p, entry]);
    setTfBySymbol((p) => ({ ...p, [r.symbol]: DEFAULT_TIMEFRAME }));
    setEmasBySymbol((p) => ({ ...p, [r.symbol]: p[r.symbol] ?? [9, 21, 50].map((per, i) => ({ id: Date.now() + i, period: per, color: COLORS[i % COLORS.length] })) }));
    setSelected(r.symbol);
    setSearchOpen(false);
    try { await api.post('/api/user/watchlist', { symbol: r.symbol }); } catch { /* noop */ }
  };

  const removeSymbol = async (sym: string) => {
    const tf = getTf(sym);
    if (monitored.has(sym)) {
      try { await api.delete('/api/monitor', { data: { symbol: sym, timeframe: tf } }); } catch { /* noop */ }
      setMonitored((p) => { const n = new Set(p); n.delete(sym); return n; });
    }
    setSymbols((p) => p.filter((s) => s.symbol !== sym));
    if (selected === sym) setSelected(null);
    try { await api.delete('/api/user/watchlist', { params: { symbol: sym } }); } catch { /* noop */ }
  };

  const changeEmaTimeframe = (sym: string, tf: string) => {
    const old = getTf(sym);
    if (monitored.has(sym) && old !== tf) {
      api.delete('/api/monitor', { data: { symbol: sym, timeframe: old } }).catch(() => {});
      setMonitored((p) => { const n = new Set(p); n.delete(sym); return n; });
      setStatus(`Monitoring stopped — start again to use ${tf}`);
      setTimeout(() => setStatus(''), 4000);
    }
    setTfBySymbol((p) => ({ ...p, [sym]: tf }));
  };

  const startMonitoring = async (sym: string) => {
    const symbolEmas = emasBySymbol[sym] ?? [];
    const emaOn = emaEnabledBySymbol[sym] ?? true;
    const symRsi = rsiBySymbol[sym] ?? EMPTY_RSI_UI;
    const tf = getTf(sym);
    const rsiCheck = buildRsiPayload(symRsi, tf);
    const rsiOn = symRsi.enabled && rsiCheck.ok && !!rsiCheck.rsi;
    if (!emaOn && !rsiOn) { Alert.alert('Monitor', `${sym}: enable EMA or RSI alerts.`); return; }
    if (emaOn && symbolEmas.length < 2) { Alert.alert('Monitor', `${sym}: add at least 2 EMAs.`); return; }
    if (!rsiCheck.ok) { Alert.alert('Monitor', rsiCheck.error); return; }
    const s = symbols.find((x) => x.symbol === sym); if (!s) return;
    setBusy(true);
    setStatus(`Starting ${sym} — loading history…`);
    try {
      const r = await api.post<{ success: boolean; message?: string }>('/api/monitor', {
        symbol: s.symbol,
        timeframe: tf,
        emaPeriods: symbolEmas.map((e) => e.period),
        trackBullish: emaOn ? trackBullish : false,
        trackBearish: emaOn ? trackBearish : false,
        exchange: s.exchange || 'NSE',
        currency: s.currency,
        rsi: rsiCheck.rsi,
      });
      if (r.data.success) { setMonitored((p) => new Set(p).add(sym)); setStatus(''); }
      else setStatus(r.data.message || 'Failed');
    } catch (e: any) { setStatus(e?.response?.data?.error || 'Error'); }
    setBusy(false);
  };
  const stopMonitoring = async (sym: string) => {
    const tf = getTf(sym);
    try { await api.delete('/api/monitor', { data: { symbol: sym, timeframe: tf } }); } catch { /* noop */ }
    setMonitored((p) => { const n = new Set(p); n.delete(sym); return n; });
  };

  const toggleMonitor = () => {
    if (!displaySymbol) return;
    if (monitored.has(displaySymbol)) stopMonitoring(displaySymbol);
    else startMonitoring(displaySymbol);
  };

  const updateRsi = (updater: (p: RsiUiConfig) => RsiUiConfig) => {
    if (!displaySymbol) return;
    setRsiBySymbol((prev) => ({ ...prev, [displaySymbol]: updater(prev[displaySymbol] ?? EMPTY_RSI_UI) }));
  };
  const addEma = (period: number) => {
    if (!displaySymbol || !period) return;
    setEmasBySymbol((prev) => {
      const cur = prev[displaySymbol] ?? [];
      if (cur.some((e) => e.period === period)) return prev;
      return { ...prev, [displaySymbol]: [...cur, { id: Date.now(), period, color: COLORS[cur.length % COLORS.length] }].sort((a, b) => a.period - b.period) };
    });
    if (monitored.has(displaySymbol)) stopMonitoring(displaySymbol);
  };
  const removeEma = (id: number) => {
    if (!displaySymbol) return;
    setEmasBySymbol((prev) => ({ ...prev, [displaySymbol]: (prev[displaySymbol] ?? []).filter((e) => e.id !== id) }));
    if (monitored.has(displaySymbol)) stopMonitoring(displaySymbol);
  };

  const stackedFor = (sym: string): 'bull' | 'bear' | null => {
    const tf = getTf(sym); const vals = emaByKey[watchKey(sym, tf)]; const ps = (emasBySymbol[sym] ?? []).map((e) => e.period).sort((a, b) => a - b);
    if (!vals || ps.length < 2) return null;
    const f = vals[ps[0]]; const s = vals[ps[1]];
    if (f == null || s == null) return null;
    return f >= s ? 'bull' : 'bear';
  };
  const rsiFor = (sym: string): number | null => rsiByKey[watchKey(sym, getTf(sym))]?.value ?? null;

  if (restoring) {
    return <View style={[styles.center, { backgroundColor: t.bg }]}><ActivityIndicator color={t.accent} /></View>;
  }

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <View style={[styles.topbar, { borderBottomColor: t.border }]}>
        <View style={styles.wordmark}>
          <View style={[styles.logoBox, { backgroundColor: t.accent }]}>
            <Logo size={22} />
          </View>
          <View>
            <Text style={[styles.brand, { color: t.ink }]}>Signal<Text style={{ color: t.accent }}>Stack</Text></Text>
            <Text style={[styles.brandTag, { color: t.muted }]}>EMA · RSI crossover alerts</Text>
          </View>
        </View>
        <View style={styles.topbarRight}>
          <LivePill connected={connected} />
          <TouchableOpacity
            onPress={() => setTab(tab === 'tools' ? 'live' : 'tools')}
            style={[styles.iconBtn, { backgroundColor: tab === 'tools' ? t.accentSoft : t.surface2, borderColor: t.border }]}
          >
            <SettingsIcon size={16} color={tab === 'tools' ? t.accent : t.ink2} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setAccountOpen(true)} activeOpacity={0.8}>
            <View style={[styles.avatar, { backgroundColor: t.accent }]}>
              {(() => {
                const initial =
                  (user?.firstName?.[0] ||
                    user?.primaryEmailAddress?.emailAddress?.[0] ||
                    '').toUpperCase();
                return initial
                  ? <Text style={styles.avatarTxt}>{initial}</Text>
                  : <User size={16} color="#fff" />;
              })()}
            </View>
          </TouchableOpacity>
        </View>
      </View>

      {status ? (
        <View style={[styles.banner, { backgroundColor: t.surface2 }]}><Text style={{ color: t.ink2 }}>{status}</Text></View>
      ) : null}

      {tab === 'live' ? (
        symbols.length === 0 ? (
          <View style={{ padding: 16, paddingBottom: 100 }}>
            <EmptyState onAdd={() => setSearchOpen(true)} t={t} />
          </View>
        ) : (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 100 }}>
          {displaySymbol && (
            <Spotlight
              symbol={displaySymbol}
              name={symbols.find((s) => s.symbol === displaySymbol)?.name}
              exchange={symbols.find((s) => s.symbol === displaySymbol)?.exchange ?? 'NSE'}
              currency={symbols.find((s) => s.symbol === displaySymbol)?.currency ?? 'INR'}
              price={displayPrice?.price ?? null}
              change={displayPrice?.change ?? 0}
              changePercent={displayPrice?.changePercent ?? 0}
              emaTimeframe={displayTf}
              rsiTimeframe={rsiUi.timeframe || undefined}
              fastPeriod={sortedPeriods[0]}
              slowPeriod={sortedPeriods[1]}
              fastVal={sortedPeriods[0] != null ? (emaByKey[displayKey]?.[sortedPeriods[0]] ?? null) : null}
              slowVal={sortedPeriods[1] != null ? (emaByKey[displayKey]?.[sortedPeriods[1]] ?? null) : null}
              rsi={liveRsi?.value ?? null}
              rsiPeriod={liveRsi?.period}
              connected={connected}
              daySummary={daySummaryBySymbol[displaySymbol] ?? null}
              onChangeTimeframe={(tf) => displaySymbol && changeEmaTimeframe(displaySymbol, tf)}
            />
          )}

          {/* EMA stack panel (full width) */}
          {displaySymbol && (
            <View style={[panel.box, { backgroundColor: t.surface, borderColor: t.border }]}>
              <View style={panel.head}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                  <Layers size={14} color={t.ink2} />
                  <Text style={[panel.title, { color: t.ink2 }]}>EMA stack</Text>
                </View>
                {stackedFor(displaySymbol) && (
                  <Text style={{ color: stackedFor(displaySymbol) === 'bull' ? t.bull : t.bear, fontSize: 11, fontWeight: '700' }}>
                    {stackedFor(displaySymbol) === 'bull' ? 'Bullish' : 'Bearish'}
                  </Text>
                )}
              </View>
              {emas.length === 0 ? (
                <Text style={{ color: t.muted, fontSize: 12 }}>No EMAs yet — add them in Indicators.</Text>
              ) : (
                [...emas].sort((a, b) => a.period - b.period).map((e) => {
                  const val = emaByKey[displayKey]?.[e.period];
                  const warm = warmupByKey[displayKey]?.[e.period] ?? (monitored.has(displaySymbol) ? 0 : 1);
                  const ready = warm >= 1;
                  return (
                    <View key={e.id} style={panel.emaRow}>
                      <View style={[panel.dot, { backgroundColor: e.color }]} />
                      <Text style={[panel.emaLabel, { color: t.ink }]}>EMA {e.period}</Text>
                      <View style={[panel.emaBar, { backgroundColor: t.surface2 }]}>
                        <View style={{ width: `${Math.round(warm * 100)}%`, height: '100%', backgroundColor: e.color, borderRadius: 999 }} />
                      </View>
                      <Text style={[panel.emaNum, { color: t.ink2 }]}>
                        {ready && val != null ? val.toFixed(2) : `${Math.round(warm * 100)}%`}
                      </Text>
                    </View>
                  );
                })
              )}
            </View>
          )}

          {/* RSI panel (full width) */}
          {displaySymbol && (
            <View style={[panel.box, { backgroundColor: t.surface, borderColor: t.border }]}>
              <View style={panel.head}>
                <Activity size={14} color={t.ink2} />
                <Text style={[panel.title, { color: t.ink2 }]}>RSI ({liveRsi?.period ?? rsiUi.period})</Text>
              </View>
              <RsiMeter
                value={liveRsi?.value ?? null}
                period={liveRsi?.period ?? parseInt(rsiUi.period || '14', 10)}
                warmup={liveRsi?.warmupProgress ?? 1}
                overbought={parseInt(rsiUi.overbought || '70', 10)}
                oversold={parseInt(rsiUi.oversold || '30', 10)}
              />
            </View>
          )}

          {/* Configure indicators row — matches PWA .detail-config-btn */}
          {displaySymbol && (
            <TouchableOpacity
              activeOpacity={0.82}
              onPress={() => setTab('config')}
              style={[panel.cfgBtn, { backgroundColor: t.surface, borderColor: t.border }]}
            >
              <SettingsIcon size={16} color={t.ink} />
              <Text style={[panel.cfgTxt, { color: t.ink }]}>Configure indicators</Text>
              <Text style={{ color: t.muted, fontSize: 18 }}>›</Text>
            </TouchableOpacity>
          )}

          {/* Watchlist */}
          <View style={{ marginTop: 8 }}>
            <View style={panel.secHead}>
              <Text style={[panel.secTitle, { color: t.ink }]}>Watchlist</Text>
              <Text style={[panel.secCount, { color: t.muted }]}>{symbols.length}</Text>
            </View>
            <View style={{ gap: 8 }}>
              {symbols.map((s) => {
                const tf = getTf(s.symbol); const k = watchKey(s.symbol, tf); const pr = priceByKey[k];
                return (
                  <WatchRow
                    key={s.symbol}
                    symbol={s.symbol}
                    name={s.name}
                    exchange={s.exchange || 'NSE'}
                    currency={s.currency}
                    price={pr?.price ?? null}
                    changePercent={pr?.changePercent ?? 0}
                    emaPeriods={(emasBySymbol[s.symbol] ?? []).map((e) => e.period).sort((a, b) => a - b)}
                    stacked={stackedFor(s.symbol)}
                    rsi={rsiFor(s.symbol)}
                    monitoring={monitored.has(s.symbol)}
                    selected={s.symbol === displaySymbol}
                    onSelect={() => setSelected(s.symbol)}
                  />
                );
              })}
            </View>
          </View>
        </ScrollView>
        )
      ) : tab === 'config' ? (
        <ConfigScreen
          symbol={displaySymbol}
          emaTimeframe={displayTf}
          onEmaTimeframe={(tf) => displaySymbol && changeEmaTimeframe(displaySymbol, tf)}
          emas={emas}
          emaAlertsEnabled={emaAlertsEnabled}
          onToggleEma={(v) => displaySymbol && setEmaEnabledBySymbol((p) => ({ ...p, [displaySymbol]: v }))}
          onAddEma={addEma}
          onRemoveEma={removeEma}
          rsiUi={rsiUi}
          updateRsi={updateRsi}
          trackBullish={trackBullish}
          trackBearish={trackBearish}
          onTrackBullish={() => { setTrackBullish((v) => !v); if (displaySymbol && monitored.has(displaySymbol)) stopMonitoring(displaySymbol); }}
          onTrackBearish={() => { setTrackBearish((v) => !v); if (displaySymbol && monitored.has(displaySymbol)) stopMonitoring(displaySymbol); }}
          monitoring={!!displaySymbol && monitored.has(displaySymbol)}
          busy={busy}
          onToggleMonitor={toggleMonitor}
          onRemoveSymbol={() => displaySymbol && removeSymbol(displaySymbol)}
          status={status}
        />
      ) : (
        <ToolsScreen />
      )}

      {/* Bottom nav — mirrors .bottom-nav / .nav-item.active / .nav-add from the PWA */}
      <View style={[styles.nav, { backgroundColor: t.surface, borderColor: t.border }]}>
        <TouchableOpacity
          activeOpacity={0.85}
          style={[styles.navItem, tab === 'live' && { backgroundColor: t.accentSoft }]}
          onPress={() => setTab('live')}
        >
          <Activity size={20} color={tab === 'live' ? t.accentInk : t.muted} />
          <Text style={[styles.navTxt, { color: tab === 'live' ? t.accentInk : t.muted }]}>Live</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.navAdd, { backgroundColor: t.accent }]} onPress={() => setSearchOpen(true)}>
          <Plus size={24} color="#fff" />
        </TouchableOpacity>
        <TouchableOpacity
          activeOpacity={0.85}
          style={[styles.navItem, tab === 'config' && { backgroundColor: t.accentSoft }]}
          onPress={() => setTab('config')}
        >
          <SlidersHorizontal size={20} color={tab === 'config' ? t.accentInk : t.muted} />
          <Text style={[styles.navTxt, { color: tab === 'config' ? t.accentInk : t.muted }]}>Indicators</Text>
        </TouchableOpacity>
      </View>

      <SearchSheet
        open={searchOpen}
        existing={symbols.map((s) => s.symbol)}
        onAdd={addSymbol}
        onClose={() => setSearchOpen(false)}
      />

      <Modal visible={accountOpen} transparent animationType="fade" onRequestClose={() => setAccountOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setAccountOpen(false)}>
          <Pressable style={[styles.accountCard, { backgroundColor: t.surface, borderColor: t.border }]} onPress={(e) => e.stopPropagation()}>
            <View style={styles.accountHead}>
              <View style={[styles.accountAvatar, { backgroundColor: t.accent }]}>
                <User size={22} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.accountName, { color: t.ink }]} numberOfLines={1}>
                  {user?.fullName || user?.firstName || 'Account'}
                </Text>
                <Text style={[styles.accountEmail, { color: t.muted }]} numberOfLines={1}>
                  {user?.primaryEmailAddress?.emailAddress || ''}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setAccountOpen(false)} style={styles.accountClose}>
                <X size={18} color={t.muted} />
              </TouchableOpacity>
            </View>
            <TouchableOpacity
              activeOpacity={0.85}
              style={[styles.accountAction, { backgroundColor: t.surface2, borderColor: t.border }]}
              onPress={() => { setAccountOpen(false); setTab('tools'); }}
            >
              <SettingsIcon size={16} color={t.ink} />
              <Text style={[styles.accountActionTxt, { color: t.ink }]}>Manage account</Text>
            </TouchableOpacity>
            <TouchableOpacity
              activeOpacity={0.85}
              style={[styles.accountAction, styles.accountSignOut, { borderColor: t.bear + '55' }]}
              onPress={async () => { setAccountOpen(false); try { await signOut(); } catch { /* noop */ } }}
            >
              <LogOut size={16} color={t.bear} />
              <Text style={[styles.accountActionTxt, { color: t.bear }]}>Sign out</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  topbar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10, borderBottomWidth: 1 },
  wordmark: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  logoBox: { width: 34, height: 34, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  brand: { fontSize: 16, fontWeight: '800' },
  brandTag: { fontSize: 10, fontWeight: '600', letterSpacing: 0.2, marginTop: -1 },
  topbarRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  iconBtn: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  avatar: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  avatarTxt: { color: '#fff', fontWeight: '800', fontSize: 14 },
  banner: { padding: 10, marginHorizontal: 16, marginTop: 10, borderRadius: 10 },
  // Matches PWA .bottom-nav: rounded pill, 8px gap, 8px padding, no popped plus button.
  nav: { position: 'absolute', alignSelf: 'center', bottom: 16, flexDirection: 'row', alignItems: 'center', gap: 8, padding: 8, borderRadius: 999, borderWidth: 1, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 8 },
  // Each item is a 92px column with rounded highlight on active (.nav-item / .nav-item.active).
  navItem: { alignItems: 'center', justifyContent: 'center', gap: 3, paddingVertical: 8, width: 92, borderRadius: 16 },
  navTxt: { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.2 },
  // .nav-add: 52x52, inline, accent bg, white plus.
  navAdd: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  emptyCard: { padding: 28, borderRadius: 18, borderWidth: 1, alignItems: 'center', gap: 12 },
  emptyTitle: { fontSize: 24, fontWeight: '800', textAlign: 'center' },
  emptySub: { fontSize: 13, lineHeight: 19, textAlign: 'center', maxWidth: 320 },
  emptyCta: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18, paddingVertical: 12, borderRadius: 999, marginTop: 6 },
  emptyCtaTxt: { color: '#fff', fontWeight: '700', fontSize: 14 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(11,18,32,0.5)', justifyContent: 'center', padding: 24 },
  accountCard: { borderRadius: 16, borderWidth: 1, padding: 18, gap: 12 },
  accountHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  accountAvatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  accountName: { fontSize: 16, fontWeight: '800' },
  accountEmail: { fontSize: 12, marginTop: 2 },
  accountClose: { padding: 4 },
  accountAction: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 12, borderWidth: 1 },
  accountSignOut: { backgroundColor: 'rgba(239,68,68,0.08)' },
  accountActionTxt: { fontSize: 14, fontWeight: '700' },
});

const panel = StyleSheet.create({
  box: { padding: 12, borderRadius: 14, borderWidth: 1, gap: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  title: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  emaRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  emaLabel: { fontFamily: 'Menlo', fontSize: 12, fontWeight: '700', width: 64 },
  emaBar: { flex: 1, height: 8, borderRadius: 999, overflow: 'hidden' },
  emaNum: { fontFamily: 'Menlo', fontSize: 12, fontWeight: '700', minWidth: 56, textAlign: 'right' },
  secHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  secTitle: { fontSize: 14, fontWeight: '800' },
  secCount: { fontSize: 12, fontWeight: '700' },
  // .detail-config-btn equivalent
  cfgBtn: { flexDirection: 'row', alignItems: 'center', gap: 9, padding: 13, borderRadius: 13, borderWidth: 1, shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  cfgTxt: { fontSize: 13, fontWeight: '600', flex: 1 },
});
