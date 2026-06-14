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
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginVertical: 8 },
  pill: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 9, borderWidth: 1, minWidth: 42, alignItems: 'center' },
  txt: { fontFamily: 'Menlo', fontSize: 11.5, fontWeight: '700' },
});
