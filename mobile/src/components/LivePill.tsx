import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '@/lib/theme';

export function LivePill({ connected }: { connected: boolean }) {
  const t = useTheme();
  const color = connected ? t.bull : t.bear;
  return (
    <View style={[styles.pill, { backgroundColor: color + '22', borderColor: color + '44' }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.txt, { color }]}>{connected ? 'LIVE' : 'OFFLINE'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  txt: { fontSize: 10, fontWeight: '800', letterSpacing: 0.4 },
});
