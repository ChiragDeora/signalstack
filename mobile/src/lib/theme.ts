/**
 * Theme mirroring the PWA's design tokens so the mobile app feels native to SignalStack.
 * Single source — referenced from every component instead of inline literals.
 */
// useColorScheme intentionally not used — we lock the mobile app to light to
// match the PWA's default appearance. A user-toggleable dark mode lives in the
// Tools panel (same UX as the web).

export interface Theme {
  bg: string;
  surface: string;
  surface2: string;
  border: string;
  ink: string;
  ink2: string;
  muted: string;
  accent: string;
  accentInk: string;
  accentSoft: string;
  bull: string;
  bullBg: string;
  bear: string;
  bearBg: string;
  radius: { sm: number; md: number; lg: number; pill: number };
  spacing: (n: number) => number;
  fontMono: string;
  fontDisplay: string;
}

const light: Theme = {
  bg: '#f3f6fb',
  surface: '#ffffff',
  surface2: '#eef2f8',
  border: '#e1e7f0',
  ink: '#0b1220',
  ink2: '#475569',
  muted: '#64748b',
  accent: '#1f6dff',
  accentInk: '#0a3aa6',
  accentSoft: 'rgba(31,109,255,0.15)',
  bull: '#10b981',
  bullBg: 'rgba(16,185,129,0.12)',
  bear: '#ef4444',
  bearBg: 'rgba(239,68,68,0.12)',
  radius: { sm: 8, md: 12, lg: 16, pill: 999 },
  spacing: (n) => n * 4,
  fontMono: 'Menlo',
  fontDisplay: 'System',
};

const dark: Theme = {
  ...light,
  bg: '#070a13',
  surface: '#0e1422',
  surface2: '#161d2e',
  border: '#1c2538',
  ink: '#e6ecf6',
  ink2: '#9aa6bb',
  muted: '#6b7894',
  accentSoft: 'rgba(31,109,255,0.25)',
};

export function useTheme(): Theme {
  return light;
}

export const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const;
export const DEFAULT_TIMEFRAME = '5m';
export const COLORS = ['#1f6dff', '#0bb5d6', '#8b5cf6', '#f59e0b', '#ec4899', '#10b981'];

export function formatPrice(v: number | null | undefined, currency = 'INR'): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const sym: Record<string, string> = { INR: '₹', USD: '$', GBP: '£', EUR: '€', JPY: '¥' };
  return (sym[currency] ?? '') + v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
