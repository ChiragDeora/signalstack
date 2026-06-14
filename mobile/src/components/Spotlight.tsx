import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { TrendingUp, TrendingDown, ArrowUp, ArrowDown } from 'lucide-react-native';
import { formatPrice, useTheme } from '@/lib/theme';
import { LivePill } from './LivePill';
import type { DaySummary } from '@/lib/types';

interface Props {
  symbol: string;
  name?: string;
  exchange: string;
  currency: string;
  price: number | null;
  change: number;
  changePercent: number;
  emaTimeframe: string;
  rsiTimeframe?: string;
  fastPeriod?: number;
  slowPeriod?: number;
  fastVal: number | null;
  slowVal: number | null;
  rsi: number | null;
  rsiPeriod?: number;
  connected: boolean;
  priceError?: string;
  daySummary?: DaySummary | null;
}

export function Spotlight(p: Props) {
  const t = useTheme();
  const up = p.changePercent >= 0;
  const haveEmas = p.fastVal != null && p.slowVal != null;
  const bull = haveEmas ? (p.fastVal as number) >= (p.slowVal as number) : true;
  const dirColor = bull ? t.bull : t.bear;

  return (
    <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }]}>
      <View style={styles.head}>
        <View style={styles.headLeft}>
          <LivePill connected={p.connected} />
          <View style={[styles.exch, { backgroundColor: t.surface2 }]}>
            <Text style={[styles.exchTxt, { color: t.ink2 }]}>{p.exchange}</Text>
          </View>
        </View>
        {haveEmas && (
          <View style={[styles.stackTag, { backgroundColor: dirColor + '22' }]}>
            {bull ? <ArrowUp size={12} color={dirColor} /> : <ArrowDown size={12} color={dirColor} />}
            <Text style={[styles.stackTagTxt, { color: dirColor }]}>{bull ? 'Stacked bullish' : 'Stacked bearish'}</Text>
          </View>
        )}
      </View>

      <Text style={[styles.symbol, { color: t.ink }]} numberOfLines={1}>{p.symbol}</Text>
      <Text style={[styles.name, { color: t.muted }]} numberOfLines={1}>
        {p.name ? p.name : `${p.symbol} (${p.exchange} Equity)`}
      </Text>

      {p.priceError ? (
        <View style={[styles.err, { backgroundColor: t.bearBg, borderColor: t.bear + '44' }]}>
          <Text style={[styles.errTxt, { color: t.bear }]}>{p.priceError}</Text>
        </View>
      ) : (
        <View style={styles.priceRow}>
          <Text style={[styles.price, { color: up ? t.bull : t.bear }]}>{formatPrice(p.price, p.currency)}</Text>
          {p.price != null && (
            <View style={styles.chgRow}>
              {up ? <TrendingUp size={14} color={t.bull} /> : <TrendingDown size={14} color={t.bear} />}
              <Text style={[styles.chgTxt, { color: up ? t.bull : t.bear }]}>
                {up ? '+' : ''}{p.change.toFixed(2)} · {up ? '+' : ''}{p.changePercent.toFixed(2)}%
              </Text>
            </View>
          )}
        </View>
      )}

      <View style={styles.tfChips}>
        <View style={[styles.tfChip, { backgroundColor: t.surface2, borderColor: t.border }]}>
          <Text style={[styles.tfChipLabel, { color: t.muted }]}>EMA</Text>
          <Text style={[styles.tfChipVal, { color: t.ink }]}>{p.emaTimeframe}</Text>
        </View>
        {p.rsiTimeframe && p.rsiTimeframe !== p.emaTimeframe && (
          <View style={[styles.tfChip, { backgroundColor: t.surface2, borderColor: t.border }]}>
            <Text style={[styles.tfChipLabel, { color: t.muted }]}>RSI</Text>
            <Text style={[styles.tfChipVal, { color: t.ink }]}>{p.rsiTimeframe}</Text>
          </View>
        )}
        <Text style={[styles.tfHint, { color: t.muted }]}>Change in Indicators →</Text>
      </View>

      <View style={styles.crossRow}>
        <View style={[styles.crossSide, { backgroundColor: bull ? t.bullBg : t.bearBg, borderColor: dirColor + '55' }]}>
          <Text style={[styles.csLabel, { color: dirColor }]}>EMA {p.fastPeriod ?? '—'} · FAST</Text>
          <Text style={[styles.csVal, { color: t.ink }]}>{p.fastVal != null ? p.fastVal.toFixed(2) : '—'}</Text>
        </View>
        <View style={[styles.crossNode, { backgroundColor: dirColor }]}>
          {bull ? <ArrowUp size={18} color="#fff" /> : <ArrowDown size={18} color="#fff" />}
        </View>
        <View style={[styles.crossSide, { backgroundColor: t.surface2, borderColor: t.border }]}>
          <Text style={[styles.csLabel, { color: t.muted }]}>EMA {p.slowPeriod ?? '—'} · SLOW</Text>
          <Text style={[styles.csVal, { color: t.ink }]}>{p.slowVal != null ? p.slowVal.toFixed(2) : '—'}</Text>
        </View>
      </View>

      <View style={styles.stats}>
        <View style={[styles.stat, { backgroundColor: t.surface2 }]}>
          <Text style={[styles.statLabel, { color: t.muted }]}>RSI ({p.rsiPeriod ?? 14})</Text>
          <Text style={[styles.statVal, { color: t.ink }]}>{p.rsi != null ? p.rsi.toFixed(1) : '—'}</Text>
        </View>
        <View style={[styles.stat, { backgroundColor: t.surface2 }]}>
          <Text style={[styles.statLabel, { color: t.muted }]}>Direction</Text>
          <Text style={[styles.statVal, { color: haveEmas ? dirColor : t.ink }]}>
            {haveEmas ? (bull ? 'Bullish' : 'Bearish') : '—'}
          </Text>
        </View>
      </View>

      {p.daySummary && (
        <View style={styles.dayBlock}>
          <View style={styles.dayRow}>
            <Text style={[styles.dayLabel, { color: t.muted }]}>Today</Text>
            <DayChip t={t} label="O" value={formatPrice(p.daySummary.today.open, p.currency)} />
            <DayChip t={t} label="H" value={formatPrice(p.daySummary.today.high, p.currency)} />
            <DayChip t={t} label="L" value={formatPrice(p.daySummary.today.low, p.currency)} />
            <DayChip t={t} label="C" value={formatPrice(p.daySummary.today.close, p.currency)} />
          </View>
          {p.daySummary.yesterday && (
            <View style={styles.dayRow}>
              <Text style={[styles.dayLabel, { color: t.muted }]}>Yesterday</Text>
              <DayChip t={t} label="O" value={formatPrice(p.daySummary.yesterday.open, p.currency)} />
              <DayChip t={t} label="H" value={formatPrice(p.daySummary.yesterday.high, p.currency)} />
              <DayChip t={t} label="L" value={formatPrice(p.daySummary.yesterday.low, p.currency)} />
              <DayChip t={t} label="C" value={formatPrice(p.daySummary.yesterday.close, p.currency)} />
            </View>
          )}
        </View>
      )}
    </View>
  );
}

function DayChip({ t, label, value }: { t: ReturnType<typeof useTheme>; label: string; value: string }) {
  return (
    <View style={[styles.dayChip, { backgroundColor: t.surface2, borderColor: t.border }]}>
      <Text style={[styles.dayChipLabel, { color: t.muted }]}>{label}</Text>
      <Text style={[styles.dayChipVal, { color: t.ink }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: 16, borderRadius: 18, borderWidth: 1, gap: 8 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  headLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  exch: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  exchTxt: { fontSize: 11, fontWeight: '700', letterSpacing: 0.4 },
  stackTag: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  stackTagTxt: { fontSize: 11, fontWeight: '700' },
  symbol: { fontSize: 30, fontWeight: '800', marginTop: 4 },
  name: { fontSize: 12 },
  priceRow: { marginTop: 6, gap: 4 },
  price: { fontFamily: 'Menlo', fontSize: 34, fontWeight: '800' },
  chgRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  chgTxt: { fontFamily: 'Menlo', fontSize: 13, fontWeight: '700' },
  err: { padding: 10, borderRadius: 10, borderWidth: 1 },
  errTxt: { fontSize: 12, fontWeight: '600' },
  tfChips: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  tfChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, borderWidth: 1 },
  tfChipLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 0.4 },
  tfChipVal: { fontFamily: 'Menlo', fontSize: 12, fontWeight: '700' },
  tfHint: { fontSize: 11 },
  crossRow: { flexDirection: 'row', alignItems: 'stretch', gap: 8, marginTop: 6 },
  crossSide: { flex: 1, padding: 10, borderRadius: 12, borderWidth: 1 },
  csLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase' },
  csVal: { fontFamily: 'Menlo', fontSize: 20, fontWeight: '800', marginTop: 4 },
  crossNode: { width: 34, height: 34, borderRadius: 17, alignSelf: 'center', alignItems: 'center', justifyContent: 'center' },
  stats: { flexDirection: 'row', gap: 8 },
  stat: { flex: 1, padding: 10, borderRadius: 12 },
  statLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase' },
  statVal: { fontFamily: 'Menlo', fontSize: 16, fontWeight: '800', marginTop: 4 },
  dayBlock: { gap: 6, marginTop: 4 },
  dayRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  dayLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', width: 64 },
  dayChip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, borderWidth: 1 },
  dayChipLabel: { fontSize: 10, fontWeight: '700' },
  dayChipVal: { fontFamily: 'Menlo', fontSize: 12, fontWeight: '600' },
});
