import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { Activity, Plus, SlidersHorizontal, Settings as SettingsIcon, Layers } from 'lucide-react-native';
import { useAuth } from '@clerk/clerk-expo';
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

export function HomeScreen() {
  const t = useTheme();
  const { userId, getToken } = useAuth();
  const [tab, setTab] = useState<'live' | 'config' | 'tools'>('live');
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
        const [cfg, watches] = await Promise.all([
          api.get<{ success: boolean; config?: any }>('/api/user/config').catch(() => null),
          api.get<{ success: boolean; watches?: MonitoredWatch[] }>('/api/user/watches').catch(() => null),
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
        <Text style={[styles.brand, { color: t.ink }]}>Signal<Text style={{ color: t.accent }}>Stack</Text></Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <LivePill connected={connected} />
        </View>
      </View>

      {status ? (
        <View style={[styles.banner, { backgroundColor: t.surface2 }]}><Text style={{ color: t.ink2 }}>{status}</Text></View>
      ) : null}

      {tab === 'live' ? (
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
            />
          )}

          {/* EMA + RSI panels */}
          {displaySymbol && (
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={[panel.box, { backgroundColor: t.surface, borderColor: t.border, flex: 1 }]}>
                <View style={panel.head}><Layers size={14} color={t.ink2} /><Text style={[panel.title, { color: t.ink2 }]}>EMA stack</Text></View>
                {emas.length === 0 ? (
                  <Text style={{ color: t.muted, fontSize: 12 }}>No EMAs yet.</Text>
                ) : (
                  [...emas].sort((a, b) => a.period - b.period).map((e) => {
                    const val = emaByKey[displayKey]?.[e.period];
                    const warm = warmupByKey[displayKey]?.[e.period] ?? (monitored.has(displaySymbol) ? 0 : 1);
                    return (
                      <View key={e.id} style={panel.emaRow}>
                        <View style={[panel.dot, { backgroundColor: e.color }]} />
                        <Text style={[panel.emaLabel, { color: t.ink }]}>EMA {e.period}</Text>
                        <Text style={[panel.emaNum, { color: t.ink2 }]}>{warm >= 1 && val != null ? val.toFixed(2) : `${Math.round(warm * 100)}%`}</Text>
                      </View>
                    );
                  })
                )}
              </View>
              <View style={[panel.box, { backgroundColor: t.surface, borderColor: t.border, flex: 1 }]}>
                <View style={panel.head}><Activity size={14} color={t.ink2} /><Text style={[panel.title, { color: t.ink2 }]}>RSI ({liveRsi?.period ?? rsiUi.period})</Text></View>
                <RsiMeter value={liveRsi?.value ?? null} period={liveRsi?.period ?? parseInt(rsiUi.period || '14', 10)} warmup={liveRsi?.warmupProgress ?? 1} overbought={parseInt(rsiUi.overbought || '70', 10)} oversold={parseInt(rsiUi.oversold || '30', 10)} />
              </View>
            </View>
          )}

          <TouchableOpacity onPress={() => setTab('config')} style={[panel.cfgBtn, { backgroundColor: t.surface, borderColor: t.border }]}>
            <SettingsIcon size={16} color={t.ink} />
            <Text style={{ color: t.ink, fontWeight: '700', flex: 1, marginLeft: 8 }}>Configure indicators</Text>
            <Text style={{ color: t.muted }}>→</Text>
          </TouchableOpacity>

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

      {/* Bottom nav */}
      <View style={[styles.nav, { backgroundColor: t.surface, borderColor: t.border }]}>
        <TouchableOpacity style={styles.navItem} onPress={() => setTab('live')}>
          <Activity size={22} color={tab === 'live' ? t.accent : t.muted} />
          <Text style={[styles.navTxt, { color: tab === 'live' ? t.accent : t.muted }]}>Live</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.navAdd, { backgroundColor: t.accent }]} onPress={() => setSearchOpen(true)}>
          <Plus size={24} color="#fff" />
        </TouchableOpacity>
        <TouchableOpacity style={styles.navItem} onPress={() => setTab('config')}>
          <SlidersHorizontal size={22} color={tab === 'config' ? t.accent : t.muted} />
          <Text style={[styles.navTxt, { color: tab === 'config' ? t.accent : t.muted }]}>Indicators</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navItem} onPress={() => setTab('tools')}>
          <SettingsIcon size={22} color={tab === 'tools' ? t.accent : t.muted} />
          <Text style={[styles.navTxt, { color: tab === 'tools' ? t.accent : t.muted }]}>Tools</Text>
        </TouchableOpacity>
      </View>

      <SearchSheet
        open={searchOpen}
        existing={symbols.map((s) => s.symbol)}
        onAdd={addSymbol}
        onClose={() => setSearchOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  topbar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10, borderBottomWidth: 1 },
  brand: { fontSize: 18, fontWeight: '800' },
  banner: { padding: 10, marginHorizontal: 16, marginTop: 10, borderRadius: 10 },
  nav: { position: 'absolute', left: 16, right: 16, bottom: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', paddingVertical: 8, borderRadius: 24, borderWidth: 1, shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 6 },
  navItem: { alignItems: 'center', justifyContent: 'center', gap: 1, paddingVertical: 4, paddingHorizontal: 14 },
  navTxt: { fontSize: 10, fontWeight: '700' },
  navAdd: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', marginTop: -18 },
});

const panel = StyleSheet.create({
  box: { padding: 12, borderRadius: 14, borderWidth: 1, gap: 6 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  title: { fontSize: 11, fontWeight: '700' },
  emaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  emaLabel: { fontFamily: 'Menlo', fontSize: 11, flex: 1 },
  emaNum: { fontFamily: 'Menlo', fontSize: 11, fontWeight: '700' },
  cfgBtn: { flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: 12, borderWidth: 1 },
  secHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  secTitle: { fontSize: 14, fontWeight: '800' },
  secCount: { fontSize: 12, fontWeight: '700' },
});
