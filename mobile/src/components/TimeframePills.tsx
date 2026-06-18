import React from 'react';
import { View, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { useTheme, TIMEFRAMES } from '@/lib/theme';

interface Props {
  value: string;
  defaultValue?: string;
  onChange: (tf: string) => void;
}

export function TimeframePills({ value, defaultValue, onChange }: Props) {
  const t = useTheme();
  return (
    <View style={styles.row}>
      {TIMEFRAMES.map((tf) => {
        const active = (value || defaultValue) === tf;
        const isDefault = !value && tf === defaultValue;
        return (
          <TouchableOpacity
            key={tf}
            activeOpacity={0.84}
            onPress={() => onChange(tf === defaultValue ? '' : tf)}
            style={[
              styles.pill,
              {
                backgroundColor: active ? t.accent : t.surface2,
                borderColor: active ? t.accent : t.border,
              },
            ]}
          >
            <Text style={[styles.txt, { color: active ? '#fff' : t.ink2 }]}>
              {tf}{isDefault ? '*' : ''}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  // Equal-flex columns so all 7 timeframes fit on one row (no wrap),
  // matching the PWA's `.spot-tf` grid layout.
  row: { flexDirection: 'row', gap: 5, marginVertical: 8 },
  pill: { flex: 1, paddingVertical: 7, borderRadius: 8, borderWidth: 1, alignItems: 'center' },
  txt: { fontFamily: 'Menlo', fontSize: 11, fontWeight: '700' },
});
