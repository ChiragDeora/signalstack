import React from 'react';
import { TouchableOpacity, View, Text, StyleSheet } from 'react-native';
import { ArrowUp, ArrowDown } from 'lucide-react-native';
import { useTheme, formatPrice } from '@/lib/theme';

interface Props {
  symbol: string;
  name?: string;
  exchange: string;
  currency: string;
  price: number | null;
  changePercent: number;
  emaPeriods: number[];
  stacked: 'bull' | 'bear' | null;
  rsi: number | null;
  monitoring: boolean;
  selected: boolean;
  onSelect: () => void;
}

export function WatchRow(p: Props) {
  const t = useTheme();
  const up = p.changePercent >= 0;
  const stackColor = p.stacked === 'bull' ? t.bull : p.stacked === 'bear' ? t.bear : t.muted;
  const rsiOver = p.rsi != null && p.rsi >= 70;
  const rsiUnder = p.rsi != null && p.rsi <= 30;
  const rsiColor = rsiOver ? t.bear : rsiUnder ? t.bull : t.ink2;

  return (
    <TouchableOpacity
      onPress={p.onSelect}
      activeOpacity={0.82}
      style={[
        styles.row,
        {
          backgroundColor: t.surface,
          borderColor: p.selected ? t.accent : t.border,
          borderWidth: p.selected ? 2 : 1,
        },
      ]}
    >
      <View style={styles.left}>
        <View style={styles.symRow}>
          <Text style={[styles.symbol, { color: t.ink }]}>{p.symbol}</Text>
          {p.exchange !== 'NSE' && (
            <View style={[styles.badge, { backgroundColor: t.surface2 }]}>
              <Text style={[styles.badgeTxt, { color: t.ink2 }]}>{p.exchange}</Text>
            </View>
          )}
        </View>
        {p.name && <Text style={[styles.name, { color: t.muted }]} numberOfLines={1}>{p.name}</Text>}
        <View style={styles.metaRow}>
          <Text style={[styles.meta, { color: stackColor }]}>EMA {p.emaPeriods.length ? p.emaPeriods.join('·') : '—'}</Text>
          {p.rsi != null && (
            <>
              <Text style={[styles.metaSep, { color: t.muted }]}>/</Text>
              <Text style={[styles.meta, { color: rsiColor }]}>RSI {p.rsi.toFixed(0)}</Text>
            </>
          )}
        </View>
      </View>
      <View style={styles.right}>
        <Text style={[styles.price, { color: t.ink }]}>{formatPrice(p.price, p.currency)}</Text>
        {p.price != null && (
          <View style={styles.chgRow}>
            {up ? <ArrowUp size={12} color={t.bull} /> : <ArrowDown size={12} color={t.bear} />}
            <Text style={[styles.chgTxt, { color: up ? t.bull : t.bear }]}>
              {up ? '+' : ''}{p.changePercent.toFixed(2)}%
            </Text>
          </View>
        )}
        {p.monitoring && <Text style={[styles.monTxt, { color: t.bull }]}>● Monitoring</Text>}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 12, borderRadius: 14, gap: 12 },
  left: { flex: 1, minWidth: 0, gap: 2 },
  symRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  symbol: { fontSize: 14, fontWeight: '800' },
  badge: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 5 },
  badgeTxt: { fontSize: 9, fontWeight: '700' },
  name: { fontSize: 11 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  meta: { fontFamily: 'Menlo', fontSize: 11, fontWeight: '700' },
  metaSep: { fontSize: 11 },
  right: { alignItems: 'flex-end', gap: 2 },
  price: { fontFamily: 'Menlo', fontSize: 14, fontWeight: '800' },
  chgRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  chgTxt: { fontFamily: 'Menlo', fontSize: 11, fontWeight: '700' },
  monTxt: { fontSize: 10, fontWeight: '700' },
});
