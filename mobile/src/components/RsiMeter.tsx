import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '@/lib/theme';

interface Props {
  value: number | null;
  overbought?: number;
  oversold?: number;
  period?: number;
  warmup?: number;
}

export function RsiMeter({ value, overbought = 70, oversold = 30, period = 14, warmup = 1 }: Props) {
  const t = useTheme();
  if (value == null) {
    return <Text style={{ color: t.muted, fontSize: 12 }}>Start monitoring to see live RSI({period}).</Text>;
  }
  const v = Math.max(0, Math.min(100, value));
  const zone = v >= overbought ? 'over' : v <= oversold ? 'under' : 'neutral';
  const color = zone === 'over' ? t.bear : zone === 'under' ? t.bull : t.ink2;

  return (
    <View>
      <View style={styles.row}>
        <Text style={[styles.value, { color }]}>{v.toFixed(1)}</Text>
        <Text style={[styles.zone, { color }]}>
          {zone === 'over' ? 'Overbought' : zone === 'under' ? 'Oversold' : 'Neutral'}
        </Text>
      </View>
      <View style={[styles.track, { backgroundColor: t.surface2 }]}>
        <View style={[styles.zoneFill, { width: `${oversold}%`, backgroundColor: t.bullBg, left: 0 }]} />
        <View
          style={[
            styles.zoneFill,
            { width: `${100 - overbought}%`, backgroundColor: t.bearBg, right: 0 },
          ]}
        />
        <View style={[styles.marker, { left: `${v}%`, backgroundColor: color, shadowColor: color }]} />
      </View>
      <View style={styles.scale}>
        <Text style={[styles.scaleNum, { color: t.muted }]}>0</Text>
        <Text style={[styles.scaleNum, { color: t.muted }]}>{oversold}</Text>
        <Text style={[styles.scaleNum, { color: t.muted }]}>{overbought}</Text>
        <Text style={[styles.scaleNum, { color: t.muted }]}>100</Text>
      </View>
      {warmup < 1 && <Text style={[styles.warm, { color: t.muted }]}>{Math.round(warmup * 100)}% warmed</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  value: { fontFamily: 'Menlo', fontWeight: '800', fontSize: 24 },
  zone: { fontWeight: '700', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 },
  track: { height: 10, borderRadius: 5, position: 'relative', overflow: 'hidden' },
  zoneFill: { position: 'absolute', top: 0, bottom: 0 },
  marker: { position: 'absolute', top: -2, width: 4, height: 14, borderRadius: 2, marginLeft: -2 },
  scale: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  scaleNum: { fontFamily: 'Menlo', fontSize: 10 },
  warm: { fontSize: 10, marginTop: 4, fontStyle: 'italic' },
});
