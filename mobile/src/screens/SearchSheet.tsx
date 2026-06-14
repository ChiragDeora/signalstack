import React, { useEffect, useRef, useState } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity, StyleSheet, FlatList, ActivityIndicator,
} from 'react-native';
import { X, Plus, Check, Search } from 'lucide-react-native';
import { useTheme } from '@/lib/theme';
import { api } from '@/lib/api';
import { SearchResult } from '@/lib/types';

interface Props {
  open: boolean;
  existing: string[];
  onAdd: (r: SearchResult) => void;
  onClose: () => void;
}

const FILTERS: Array<'ALL' | 'NSE' | 'NFO' | 'BSE'> = ['ALL', 'NSE', 'NFO', 'BSE'];

export function SearchSheet({ open, existing, onAdd, onClose }: Props) {
  const t = useTheme();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'ALL' | 'NSE' | 'NFO' | 'BSE'>('ALL');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const debRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) { setQuery(''); setResults([]); setFilter('ALL'); }
  }, [open]);

  useEffect(() => {
    if (debRef.current) clearTimeout(debRef.current);
    if (!query.trim()) { setResults([]); return; }
    debRef.current = setTimeout(async () => {
      setBusy(true);
      try {
        if (filter !== 'ALL') {
          const res = await api.post<{ success: boolean; results: SearchResult[] }>(`/api/search-symbols/${filter.toLowerCase()}`, { query: query.trim() });
          setResults(res.data.success ? res.data.results : []);
        } else {
          const calls = await Promise.allSettled([
            api.post<{ success: boolean; results: SearchResult[] }>('/api/search-symbols/nse', { query: query.trim() }),
            api.post<{ success: boolean; results: SearchResult[] }>('/api/search-symbols/nfo', { query: query.trim() }),
            api.post<{ success: boolean; results: SearchResult[] }>('/api/search-symbols/bse', { query: query.trim() }),
          ]);
          const seen = new Set<string>(); const merged: SearchResult[] = [];
          for (const c of calls) {
            if (c.status === 'fulfilled' && c.value.data.success) {
              for (const r of c.value.data.results) {
                const k = `${r.exchange || 'NSE'}:${r.symbol}`;
                if (seen.has(k)) continue; seen.add(k); merged.push(r);
              }
            }
          }
          setResults(merged.slice(0, 30));
        }
      } catch { setResults([]); } finally { setBusy(false); }
    }, 380);
    return () => { if (debRef.current) clearTimeout(debRef.current); };
  }, [query, filter]);

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.scrim}>
        <View style={[styles.sheet, { backgroundColor: t.surface }]}>
          <View style={styles.head}>
            <Text style={[styles.title, { color: t.ink }]}>Add symbol</Text>
            <TouchableOpacity onPress={onClose}><X size={22} color={t.ink} /></TouchableOpacity>
          </View>
          <View style={[styles.searchBox, { backgroundColor: t.surface2, borderColor: t.border }]}>
            <Search size={16} color={t.muted} />
            <TextInput
              autoFocus
              placeholder="RELIANCE, NIFTY 50, BANKNIFTY…"
              placeholderTextColor={t.muted}
              value={query}
              onChangeText={setQuery}
              style={[styles.input, { color: t.ink }]}
            />
          </View>
          <View style={styles.filters}>
            {FILTERS.map((f) => (
              <TouchableOpacity
                key={f}
                onPress={() => setFilter(f)}
                style={[styles.filter, { backgroundColor: filter === f ? t.accent : t.surface2, borderColor: t.border }]}
              >
                <Text style={{ color: filter === f ? '#fff' : t.ink2, fontSize: 11, fontWeight: '700' }}>{f}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {busy ? (
            <View style={styles.center}><ActivityIndicator color={t.accent} /></View>
          ) : (
            <FlatList
              data={results}
              keyExtractor={(r) => `${r.symbol}-${r.exchange}`}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={() => (
                <Text style={[styles.empty, { color: t.muted }]}>
                  {query ? 'No symbols found. Try "RELIANCE" or "NIFTY 50".' : 'Type to search NSE, NFO and BSE.'}
                </Text>
              )}
              renderItem={({ item }) => {
                const added = existing.includes(item.symbol);
                return (
                  <TouchableOpacity
                    disabled={added}
                    onPress={() => onAdd(item)}
                    style={[styles.resultRow, { borderColor: t.border }]}
                  >
                    <View style={{ flex: 1 }}>
                      <View style={styles.resultTop}>
                        <Text style={{ color: t.ink, fontWeight: '700', fontSize: 14 }}>{item.symbol}</Text>
                        <Text style={{ color: t.muted, fontSize: 10, fontWeight: '700' }}>{item.exchange}</Text>
                      </View>
                      <Text style={{ color: t.muted, fontSize: 11 }} numberOfLines={1}>{item.name}</Text>
                    </View>
                    {added ? (
                      <View style={styles.addedTag}><Check size={12} color={t.bull} /><Text style={{ color: t.bull, fontSize: 11, fontWeight: '700' }}> Added</Text></View>
                    ) : (
                      <Plus size={18} color={t.accent} />
                    )}
                  </TouchableOpacity>
                );
              }}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { padding: 16, borderTopLeftRadius: 22, borderTopRightRadius: 22, maxHeight: '90%', minHeight: '55%' },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  title: { fontSize: 18, fontWeight: '800' },
  searchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, height: 44, borderRadius: 10, borderWidth: 1 },
  input: { flex: 1, fontSize: 14 },
  filters: { flexDirection: 'row', gap: 6, marginVertical: 10 },
  filter: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
  resultRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12, borderBottomWidth: 1 },
  resultTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  addedTag: { flexDirection: 'row', alignItems: 'center' },
  center: { padding: 30, alignItems: 'center' },
  empty: { textAlign: 'center', padding: 24, fontSize: 12.5 },
});
