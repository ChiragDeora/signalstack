import React from 'react';
import { Animated, TouchableOpacity, StyleSheet } from 'react-native';
import { useTheme } from '@/lib/theme';

export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  const t = useTheme();
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={() => onChange(!on)}
      style={[styles.track, { backgroundColor: on ? t.accent : t.surface2, borderColor: t.border }]}
    >
      <Animated.View
        style={[
          styles.knob,
          { backgroundColor: '#fff', transform: [{ translateX: on ? 18 : 2 }] },
        ]}
      />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  track: { width: 40, height: 22, borderRadius: 999, borderWidth: 1, justifyContent: 'center' },
  knob: { width: 16, height: 16, borderRadius: 8 },
});
