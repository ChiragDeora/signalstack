import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert } from 'react-native';
import { Power, Layers, Activity, X, Check, TrendingUp, TrendingDown, Trash2, Zap } from 'lucide-react-native';
import { useTheme, TIMEFRAMES } from '@/lib/theme';
import { EMA, RsiPayload, RsiSignalFlags } from '@/lib/types';
import { Toggle } from '@/components/Toggle';
import { TimeframePills } from '@/components/TimeframePills';

export interface RsiUiConfig {
  enabled: boolean;
  period: string;
  overbought: string;
  oversold: string;
  signalLineLength: string;
  timeframe: string;
  signals: RsiSignalFlags;
}

export const EMPTY_RSI_UI: RsiUiConfig = {
  enabled: false, period: '14', overbought: '70', oversold: '30',
  signalLineLength: '14', timeframe: '',
  signals: { overboughtCross: false, oversoldCross: false, thresholdBreach: false, centerlineCross: false, signalLineCross: false },
};

const RSI_SIGNAL_ORDER: Array<keyof RsiSignalFlags> = ['signalLineCross', 'overboughtCross', 'oversoldCross', 'centerlineCross'];
const RSI_LABELS: Record<keyof RsiSignalFlags, string> = {
  signalLineCross: 'Signal line cross',
  overboughtCross: 'Overbought cross (bearish)',
  oversoldCross: 'Oversold cross (bullish)',
  thresholdBreach: 'Threshold breach',
  centerlineCross: 'Centerline (50) cross',
};

export function buildRsiPayload(ui: RsiUiConfig, emaTf: string): { ok: true; rsi?: RsiPayload } | { ok: false; error: string } {
  if (!ui.enabled) return { ok: true };
  const period = parseInt(ui.period || '14', 10);
  const overbought = parseFloat(ui.overbought || '70');
  const oversold = parseFloat(ui.oversold || '30');
  if (!Number.isFinite(period) || period < 2 || period > 200) return { ok: false, error: 'RSI period must be 2–200' };
  if (!Number.isFinite(overbought) || overbought <= 50 || overbought > 100) return { ok: false, error: 'Overbought must be 51–100' };
  if (!Number.isFinite(oversold) || oversold < 0 || oversold >= 50) return { ok: false, error: 'Oversold must be 0–49' };
  if (!Object.values(ui.signals).some(Boolean)) return { ok: false, error: 'Pick at least one RSI signal' };
  const payload: RsiPayload = { enabled: true, period, overbought, oversold, signals: ui.signals };
  if (ui.signals.signalLineCross) {
    const sl = parseInt(ui.signalLineLength || '14', 10);
    if (!Number.isFinite(sl) || sl < 2 || sl > 200) return { ok: false, error: 'Signal line EMA length 2–200' };
    payload.signalLineLength = sl;
  }
  if (ui.timeframe && ui.timeframe !== emaTf) payload.timeframe = ui.timeframe;
  return { ok: true, rsi: payload };
}

interface Props {
  symbol: string | null;
  emaTimeframe: string;
  onEmaTimeframe: (tf: string) => void;
  emas: EMA[];
  emaAlertsEnabled: boolean;
  onToggleEma: (v: boolean) => void;
  onAddEma: (p: number) => void;
  onRemoveEma: (id: number) => void;
  rsiUi: RsiUiConfig;
  updateRsi: (u: (p: RsiUiConfig) => RsiUiConfig) => void;
  trackBullish: boolean;
  trackBearish: boolean;
  onTrackBullish: () => void;
  onTrackBearish: () => void;
  monitoring: boolean;
  busy: boolean;
  onToggleMonitor: () => void;
  onRemoveSymbol: () => void;
  status: string;
}

export function ConfigScreen(p: Props) {
  const t = useTheme();
  const [newEma, setNewEma] = useState('');
  const QUICK = [9, 21, 50, 100, 200];

  if (!p.symbol) {
    return (
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }]}>
          <Text style={{ color: t.muted, textAlign: 'center' }}>Select or add a symbol to configure indicators.</Text>
        </View>
      </ScrollView>
    );
  }

  const dirLabel = [p.trackBullish && 'Bull', p.trackBearish && 'Bear'].filter(Boolean).join(' + ') || 'None';

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 100 }}>
      <View style={styles.head}>
        <View>
          <Text style={{ color: t.muted, fontSize: 10, fontWeight: '700', letterSpacing: 0.5 }}>CONFIGURING</Text>
          <Text style={{ color: t.ink, fontSize: 22, fontWeight: '800' }}>{p.symbol}</Text>
        </View>
        <View style={[styles.dirTag, { backgroundColor: (p.trackBearish && !p.trackBullish ? t.bear : t.bull) + '22' }]}>
          <Text style={{ color: p.trackBearish && !p.trackBullish ? t.bear : t.bull, fontSize: 11, fontWeight: '700' }}>{dirLabel}</Text>
        </View>
      </View>

      {/* EMA card */}
      <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }]}>
        <View style={styles.cardHead}>
          <View style={styles.cardTitleRow}><Layers size={16} color={t.ink} /><Text style={[styles.cardTitle, { color: t.ink }]}>EMA crossover</Text></View>
          <Toggle on={p.emaAlertsEnabled} onChange={p.onToggleEma} />
        </View>
        <View style={{ opacity: p.emaAlertsEnabled ? 1 : 0.5 }}>
          <Text style={[styles.label, { color: t.muted }]}>EMA timeframe</Text>
          <TimeframePills value={p.emaTimeframe} onChange={p.onEmaTimeframe} />

          <Text style={[styles.label, { color: t.muted, marginTop: 4 }]}>Active periods</Text>
          <View style={styles.pillRow}>
            {[...p.emas].sort((a, b) => a.period - b.period).map((e) => (
              <View key={e.id} style={[styles.emaPill, { backgroundColor: e.color + '22', borderColor: e.color + '55' }]}>
                <Text style={{ color: t.ink, fontFamily: 'Menlo', fontWeight: '700' }}>{e.period}</Text>
                <TouchableOpacity onPress={() => p.onRemoveEma(e.id)}><X size={12} color={t.ink2} /></TouchableOpacity>
              </View>
            ))}
            <View style={[styles.emaAdd, { backgroundColor: t.surface2, borderColor: t.border }]}>
              <TextInput
                inputMode="numeric"
                placeholder="+ add"
                placeholderTextColor={t.muted}
                value={newEma}
                onChangeText={(v) => setNewEma(v.replace(/\D/g, ''))}
                onSubmitEditing={() => { const n = parseInt(newEma, 10); if (n > 0) { p.onAddEma(n); setNewEma(''); } }}
                style={{ color: t.ink, minWidth: 50, fontSize: 12, fontFamily: 'Menlo' }}
              />
            </View>
          </View>
          <View style={[styles.pillRow, { marginTop: 6 }]}>
            {QUICK.map((q) => (
              <TouchableOpacity
                key={q}
                disabled={p.emas.some((e) => e.period === q)}
                onPress={() => p.onAddEma(q)}
                style={[styles.quickEma, { backgroundColor: t.surface2, borderColor: t.border, opacity: p.emas.some((e) => e.period === q) ? 0.35 : 1 }]}
              >
                <Text style={{ color: t.ink2, fontFamily: 'Menlo', fontWeight: '700', fontSize: 12 }}>{q}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </View>

      {/* RSI card */}
      <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }]}>
        <View style={styles.cardHead}>
          <View style={styles.cardTitleRow}><Activity size={16} color={t.ink} /><Text style={[styles.cardTitle, { color: t.ink }]}>RSI signals</Text></View>
          <Toggle on={p.rsiUi.enabled} onChange={(v) => p.updateRsi((prev) => ({ ...prev, enabled: v }))} />
        </View>
        <View style={{ opacity: p.rsiUi.enabled ? 1 : 0.5 }}>
          <Text style={[styles.label, { color: t.muted }]}>RSI timeframe</Text>
          <TimeframePills
            value={p.rsiUi.timeframe}
            defaultValue={p.emaTimeframe}
            onChange={(tf) => p.updateRsi((prev) => ({ ...prev, timeframe: tf }))}
          />
          <View style={styles.rsiFields}>
            {(['period', 'overbought', 'oversold'] as const).map((k) => (
              <View key={k} style={[styles.rsiField, { backgroundColor: t.surface2, borderColor: t.border }]}>
                <Text style={[styles.label, { color: t.muted }]}>{k}</Text>
                <TextInput
                  inputMode="numeric"
                  value={p.rsiUi[k]}
                  onChangeText={(v) => p.updateRsi((prev) => ({ ...prev, [k]: v.replace(/\D/g, '') }))}
                  style={{ color: t.ink, fontFamily: 'Menlo', fontSize: 16, fontWeight: '700' }}
                />
              </View>
            ))}
          </View>
          <Text style={[styles.label, { color: t.muted, marginTop: 10 }]}>Alert on</Text>
          {RSI_SIGNAL_ORDER.map((key) => {
            const on = p.rsiUi.signals[key];
            return (
              <View key={key}>
                <TouchableOpacity
                  onPress={() => p.updateRsi((prev) => ({ ...prev, signals: { ...prev.signals, [key]: !prev.signals[key] } }))}
                  style={[styles.signalItem, { backgroundColor: on ? t.accentSoft : t.surface2, borderColor: on ? t.accent : t.border }]}
                >
                  <View style={[styles.check, { backgroundColor: on ? t.accent : 'transparent', borderColor: on ? t.accent : t.border }]}>
                    {on && <Check size={11} color="#fff" />}
                  </View>
                  <Text style={{ color: t.ink, fontWeight: '600', fontSize: 13 }}>{RSI_LABELS[key]}</Text>
                </TouchableOpacity>
                {key === 'signalLineCross' && on && (
                  <View style={[styles.signalSub, { backgroundColor: t.surface2 }]}>
                    <Text style={[styles.label, { color: t.muted, marginRight: 8 }]}>EMA length</Text>
                    <TextInput
                      inputMode="numeric"
                      value={p.rsiUi.signalLineLength}
                      onChangeText={(v) => p.updateRsi((prev) => ({ ...prev, signalLineLength: v.replace(/\D/g, '') }))}
                      style={{ color: t.ink, fontFamily: 'Menlo', fontSize: 14, fontWeight: '700', minWidth: 40 }}
                    />
                  </View>
                )}
              </View>
            );
          })}
        </View>
      </View>

      {/* Direction card */}
      <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }]}>
        <View style={styles.cardHead}>
          <View style={styles.cardTitleRow}><Zap size={16} color={t.ink} /><Text style={[styles.cardTitle, { color: t.ink }]}>Track direction</Text></View>
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TouchableOpacity
            onPress={p.onTrackBullish}
            style={[styles.dirBtn, { backgroundColor: p.trackBullish ? t.bull + '22' : t.surface2, borderColor: p.trackBullish ? t.bull : t.border }]}
          >
            <TrendingUp size={16} color={p.trackBullish ? t.bull : t.ink2} />
            <Text style={{ color: p.trackBullish ? t.bull : t.ink2, fontWeight: '700' }}>Bullish</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={p.onTrackBearish}
            style={[styles.dirBtn, { backgroundColor: p.trackBearish ? t.bear + '22' : t.surface2, borderColor: p.trackBearish ? t.bear : t.border }]}
          >
            <TrendingDown size={16} color={p.trackBearish ? t.bear : t.ink2} />
            <Text style={{ color: p.trackBearish ? t.bear : t.ink2, fontWeight: '700' }}>Bearish</Text>
          </TouchableOpacity>
        </View>
      </View>

      <TouchableOpacity
        onPress={p.onToggleMonitor}
        disabled={p.busy}
        style={[styles.ctaBtn, { backgroundColor: p.monitoring ? t.bear : t.accent, opacity: p.busy ? 0.5 : 1 }]}
      >
        <Power size={18} color="#fff" />
        <Text style={styles.ctaTxt}>{p.monitoring ? `Stop monitoring ${p.symbol}` : `Start monitoring ${p.symbol}`}</Text>
      </TouchableOpacity>
      {p.status ? <Text style={{ color: t.muted, fontSize: 12, textAlign: 'center' }}>{p.status}</Text> : null}

      <TouchableOpacity
        onPress={() => Alert.alert(`Remove ${p.symbol}?`, 'This stops monitoring and removes it from your watchlist.',
          [{ text: 'Cancel', style: 'cancel' }, { text: 'Remove', style: 'destructive', onPress: p.onRemoveSymbol }])}
        style={styles.removeBtn}
      >
        <Trash2 size={16} color={t.bear} />
        <Text style={{ color: t.bear, fontWeight: '700' }}>Remove {p.symbol} from watchlist</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  card: { padding: 14, borderRadius: 16, borderWidth: 1, gap: 10 },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardTitle: { fontSize: 14, fontWeight: '700' },
  label: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  emaPill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
  emaAdd: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, borderWidth: 1 },
  quickEma: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, borderWidth: 1 },
  rsiFields: { flexDirection: 'row', gap: 8, marginTop: 6 },
  rsiField: { flex: 1, padding: 10, borderRadius: 10, borderWidth: 1 },
  signalItem: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 12, borderWidth: 1, marginTop: 6 },
  signalSub: { marginTop: 6, padding: 10, borderRadius: 10, flexDirection: 'row', alignItems: 'center' },
  check: { width: 18, height: 18, borderRadius: 4, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  dirTag: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  dirBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, padding: 14, borderRadius: 12, borderWidth: 1 },
  ctaBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 14, borderRadius: 14 },
  ctaTxt: { color: '#fff', fontWeight: '800', fontSize: 14 },
  removeBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, padding: 12, marginTop: 4 },
});
