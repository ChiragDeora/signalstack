'use client';

/* ============================================================
   SignalStack — presentational UI components (typed, props-driven)
   Used by EMAAlertSystem.tsx. Pure view layer, no data fetching.
   ============================================================ */
import React from 'react';
import {
  Activity, ArrowUp, ArrowDown, TrendingUp, TrendingDown, Plus, SlidersHorizontal,
} from 'lucide-react';
import type { DaySummary } from '@/lib/daySummary';

export const CURRENCY: Record<string, string> = { INR: '₹', USD: '$', GBP: '£', EUR: '€', JPY: '¥' };
export function fmtPrice(v: number | null | undefined, currency = 'INR'): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const sym = CURRENCY[currency] ?? '';
  return sym + v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function optionMeta(sym: string, exchange?: string): { isOption: boolean; side: 'CE' | 'PE' | null } {
  if (exchange && exchange !== 'NFO') return { isOption: false, side: null };
  const u = sym.toUpperCase();
  const isCE = u.endsWith('CE'); const isPE = u.endsWith('PE');
  return { isOption: isCE || isPE, side: isCE ? 'CE' : isPE ? 'PE' : null };
}

/* ---- Live radar indicator ---- */
export function LivePill({ connected }: { connected: boolean }) {
  return (
    <div className={`live ${connected ? 'on' : 'off'}`}>
      <span className="live-radar">
        <span className="live-core" />
        <span className="live-ring" />
        <span className="live-ring r2" />
      </span>
      <span className="live-text">{connected ? 'LIVE' : 'OFFLINE'}</span>
    </div>
  );
}

/* ---- RSI linear meter ---- */
export function RsiMeter({ value, overbought = 70, oversold = 30, period = 14, warmup = 1 }: {
  value: number | null; overbought?: number; oversold?: number; period?: number; warmup?: number;
}) {
  if (value == null) {
    return <div className="rsi-disabled">Start monitoring to see live RSI({period}).</div>;
  }
  const v = Math.max(0, Math.min(100, value));
  const zone = v >= overbought ? 'over' : v <= oversold ? 'under' : 'neutral';
  const zoneColor = zone === 'over' ? 'var(--bear)' : zone === 'under' ? 'var(--bull)' : 'var(--accent-ink)';
  return (
    <div className="rsi-meter">
      <div className="rsi-meter-top">
        <span className="rsi-meter-value" style={{ color: zoneColor }}>{v.toFixed(1)}</span>
        <span className="rsi-meter-zone" style={{ color: zoneColor }}>
          {zone === 'over' ? 'Overbought' : zone === 'under' ? 'Oversold' : 'Neutral'}
        </span>
      </div>
      <div className="rsi-track">
        <span className="rsi-zone under" style={{ width: `${oversold}%` }} />
        <span className="rsi-zone over" style={{ width: `${100 - overbought}%` }} />
        <span className="rsi-marker" style={{ left: `${v}%`, background: zoneColor }} />
      </div>
      <div className="rsi-scale"><span>0</span><span>{oversold}</span><span>{overbought}</span><span>100</span></div>
      {warmup < 1 && <span className="rsi-warm">{Math.round(warmup * 100)}% warmed</span>}
    </div>
  );
}

/* ---- EMA / RSI / exchange sub-badge ---- */
export function SignalBadge({ kind, label }: { kind: 'ema' | 'rsi' | 'exchange'; label?: string }) {
  const text = label ?? (kind === 'ema' ? 'EMA' : kind === 'rsi' ? 'RSI' : label ?? '');
  return (
    <span className={`ss-badge ss-badge-${kind}`}>
      <span className="ss-badge-dot" aria-hidden />
      {text}
    </span>
  );
}

/* ---- Direction tag ---- */
export function DirTag({ dir, label }: { dir: 'bull' | 'bear'; label: string }) {
  return (
    <span className={`dir-tag ${dir}`}>
      {dir === 'bull' ? <ArrowUp size={12} strokeWidth={2.8} /> : <ArrowDown size={12} strokeWidth={2.8} />}
      {label}
    </span>
  );
}

export interface SpotlightProps {
  symbol: string; name?: string; exchange: string; currency: string;
  price: number | null; change: number; changePercent: number; flash: '' | 'flash-up' | 'flash-down';
  priceError?: string;
  emaTimeframe: string;
  rsiTimeframe?: string;
  fastPeriod?: number; slowPeriod?: number; fastVal: number | null; slowVal: number | null;
  rsi: number | null;
  rsiPeriod?: number;
  connected: boolean;
  daySummary?: DaySummary | null;
}

/* ---- Selected-symbol spotlight ---- */
export function Spotlight(p: SpotlightProps) {
  const up = p.changePercent >= 0;
  const meta = optionMeta(p.symbol, p.exchange);
  const haveEmas = p.fastVal != null && p.slowVal != null;
  const bull = haveEmas ? (p.fastVal as number) >= (p.slowVal as number) : true;

  return (
    <section className={`spot ${bull ? 'bull' : 'bear'}`}>
      <div className="spot-glow" />
      <div className="spot-head">
        <span className="spot-eyebrow">
          <LivePill connected={p.connected} />
          <span className="spot-exch">{p.exchange}</span>
          {meta.side && <span className={`wr-side ${meta.side === 'CE' ? 'ce' : 'pe'}`}>{meta.side}</span>}
        </span>
        {haveEmas && (
          <DirTag dir={bull ? 'bull' : 'bear'} label={bull ? 'Stacked bullish' : 'Stacked bearish'} />
        )}
      </div>

      <div className="spot-title">
        <h1 className="spot-symbol">{p.symbol}</h1>
        <span className="spot-name">
          {p.name ? p.name : `${p.symbol} (${p.exchange} Equity)`}
        </span>
      </div>

      {p.priceError ? (
        <div className="spot-err">{p.priceError}</div>
      ) : (
        <div className="spot-priceblock">
          <span className={`spot-price ${up ? 'up' : 'down'} ${p.flash}`}>{fmtPrice(p.price, p.currency)}</span>
          {p.price != null && (
            <span className={`spot-chg ${up ? 'up' : 'down'}`}>
              {up ? <TrendingUp size={14} strokeWidth={2.6} /> : <TrendingDown size={14} strokeWidth={2.6} />}
              {up ? '+' : ''}{p.change.toFixed(2)} · {up ? '+' : ''}{p.changePercent.toFixed(2)}%
            </span>
          )}
        </div>
      )}

      <div className="spot-tf-readout">
        <span className="spot-tf-chip">
          <span className="spot-tf-chip-label">EMA</span>
          <span className="spot-tf-chip-val">{p.emaTimeframe}</span>
        </span>
        {p.rsiTimeframe && p.rsiTimeframe !== p.emaTimeframe && (
          <span className="spot-tf-chip">
            <span className="spot-tf-chip-label">RSI</span>
            <span className="spot-tf-chip-val">{p.rsiTimeframe}</span>
          </span>
        )}
        <span className="spot-tf-hint">Change in Indicators →</span>
      </div>

      <div className="cross-readout">
        <div className="cross-side fast">
          <span className="cs-label">EMA {p.fastPeriod ?? '—'} · FAST</span>
          <span className="cs-value">{p.fastVal != null ? p.fastVal.toFixed(2) : '—'}</span>
        </div>
        <div className={`cross-node ${bull ? 'bull' : 'bear'}`}>
          <span className="cn-ring" />
          {bull ? <ArrowUp size={20} strokeWidth={2.6} /> : <ArrowDown size={20} strokeWidth={2.6} />}
        </div>
        <div className="cross-side slow">
          <span className="cs-label">EMA {p.slowPeriod ?? '—'} · SLOW</span>
          <span className="cs-value">{p.slowVal != null ? p.slowVal.toFixed(2) : '—'}</span>
        </div>
      </div>

      <div className="spot-stats">
        <div className="sstat">
          <span className="sstat-label">RSI ({p.rsiPeriod ?? 14})</span>
          <span className="sstat-value">{p.rsi != null ? p.rsi.toFixed(1) : '—'}</span>
        </div>
        <div className="sstat">
          <span className="sstat-label">Direction</span>
          <span className="sstat-value" style={haveEmas ? { color: bull ? 'var(--bull)' : 'var(--bear)' } : undefined}>
            {haveEmas ? (bull ? 'Bullish' : 'Bearish') : '—'}
          </span>
        </div>
      </div>

      {p.daySummary && (
        <div className="spot-day">
          <div className="spot-day-row">
            <span className="spot-day-label">Today</span>
            <span className="spot-day-chip"><b>O</b>{fmtPrice(p.daySummary.today.open, p.currency)}</span>
            <span className="spot-day-chip"><b>H</b>{fmtPrice(p.daySummary.today.high, p.currency)}</span>
            <span className="spot-day-chip"><b>L</b>{fmtPrice(p.daySummary.today.low, p.currency)}</span>
            <span className="spot-day-chip"><b>C</b>{fmtPrice(p.daySummary.today.close, p.currency)}</span>
          </div>
          {p.daySummary.yesterday && (
            <div className="spot-day-row">
              <span className="spot-day-label">Yesterday</span>
              <span className="spot-day-chip"><b>O</b>{fmtPrice(p.daySummary.yesterday.open, p.currency)}</span>
              <span className="spot-day-chip"><b>H</b>{fmtPrice(p.daySummary.yesterday.high, p.currency)}</span>
              <span className="spot-day-chip"><b>L</b>{fmtPrice(p.daySummary.yesterday.low, p.currency)}</span>
              <span className="spot-day-chip"><b>C</b>{fmtPrice(p.daySummary.yesterday.close, p.currency)}</span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export interface WatchRowProps {
  symbol: string; name?: string; exchange: string; currency: string;
  price: number | null; changePercent: number; flash: '' | 'flash-up' | 'flash-down';
  emaPeriods: number[]; stacked: 'bull' | 'bear' | null; rsi: number | null;
  monitoring: boolean; selected: boolean; onSelect: () => void;
}

/* ---- Watchlist row ---- */
export function WatchRow(p: WatchRowProps) {
  const up = p.changePercent >= 0;
  const meta = optionMeta(p.symbol, p.exchange);
  return (
    <button type="button" className={`watch-row ${p.selected ? 'sel' : ''}`} onClick={p.onSelect}>
      <div className="wr-left">
        <div className="wr-sym">
          <span className="wr-symbol">{p.symbol}</span>
          {p.exchange !== 'NSE' && <SignalBadge kind="exchange" label={p.exchange} />}
          {meta.side && <span className={`wr-side ${meta.side === 'CE' ? 'ce' : 'pe'}`}>{meta.side}</span>}
        </div>
        {p.name && <span className="wr-name">{p.name}</span>}
        <div className="wr-meta">
          <span className={`meta-stack ${p.stacked ?? ''}`}>
            <i className="meta-bar" />
            EMA {p.emaPeriods.length ? p.emaPeriods.join('·') : '—'}
          </span>
          {p.rsi != null && (
            <>
              <span className="meta-sep">/</span>
              <span className={`meta-rsi ${p.rsi >= 70 ? 'over' : p.rsi <= 30 ? 'under' : ''}`}>RSI {p.rsi.toFixed(0)}</span>
            </>
          )}
        </div>
      </div>
      <div className="wr-right">
        <span className={`wr-price ${p.flash}`}>{fmtPrice(p.price, p.currency)}</span>
        {p.price != null && (
          <span className={`wr-chg ${up ? 'up' : 'down'}`}>
            {up ? <ArrowUp size={12} strokeWidth={2.4} /> : <ArrowDown size={12} strokeWidth={2.4} />}
            {up ? '+' : ''}{p.changePercent.toFixed(2)}%
          </span>
        )}
        {p.monitoring && <span className="wr-monitor">● Monitoring</span>}
      </div>
    </button>
  );
}

/* ---- Today's alerts ---- */
export type TodayAlertItem =
  | {
      id: string; kind: 'ema'; symbol: string; bull: boolean;
      fastPeriod: number; slowPeriod: number; timeframe: string; time: string; day: string;
      price: number; currency: string;
    }
  | {
      id: string; kind: 'rsi'; symbol: string; bull: boolean;
      signalType: 'overboughtCross' | 'oversoldCross' | 'thresholdBreach' | 'centerlineCross' | 'signalLineCross';
      period: number; rsiValue: number; timeframe: string; time: string; day: string;
      price: number; currency: string;
    };

const RSI_SIGNAL_SHORT = {
  signalLineCross: 'Signal',
  overboughtCross: 'OB cross',
  oversoldCross: 'OS cross',
  centerlineCross: '50 cross',
  thresholdBreach: 'Level',
} as const;

function TodayAlertRow({ item }: { item: TodayAlertItem }) {
  const up = item.bull;
  const meta = item.kind === 'ema'
    ? `${item.fastPeriod}${up ? ' ↑ ' : ' ↓ '}${item.slowPeriod}`
    : `${item.rsiValue.toFixed(0)} · ${RSI_SIGNAL_SHORT[item.signalType]}`;

  return (
    <div className="watch-row alert-item">
      <div className="wr-left">
        <div className="wr-sym">
          <span className="wr-symbol">{item.symbol}</span>
          <SignalBadge kind={item.kind === 'ema' ? 'ema' : 'rsi'} />
        </div>
        <div className="wr-meta">
          <span className="meta-stack">{meta}</span>
          <span className="meta-sep">·</span>
          <span>{item.time}</span>
          <span className="meta-sep">·</span>
          <span>{item.timeframe}</span>
        </div>
      </div>
      <div className="wr-right">
        <span className="wr-price">{fmtPrice(item.price, item.currency)}</span>
        <span className={`wr-chg ${up ? 'up' : 'down'}`}>
          {up ? <ArrowUp size={12} strokeWidth={2.4} /> : <ArrowDown size={12} strokeWidth={2.4} />}
          {up ? 'Bull' : 'Bear'}
        </span>
      </div>
    </div>
  );
}

export function TodayAlerts({ items }: { items: TodayAlertItem[] }) {
  if (items.length === 0) return null;

  return (
    <section className="today-alerts" aria-label="Today's alerts">
      <div className="section-head">
        <span className="section-title">Today&apos;s alerts</span>
        <span className="section-count">{items.length}</span>
      </div>
      <div className="watch-rows">
        {items.map((item) => (
          <TodayAlertRow key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}

/* ---- Bottom nav ---- */
export function BottomNav({ tab, onTab, onAdd }: { tab: 'live' | 'config'; onTab: (t: 'live' | 'config') => void; onAdd: () => void }) {
  return (
    <nav className="bottom-nav">
      <button type="button" className={`nav-item ${tab === 'live' ? 'active' : ''}`} onClick={() => onTab('live')}>
        <Activity size={22} strokeWidth={2.1} /><span>Live</span>
      </button>
      <button type="button" className="nav-add" onClick={onAdd} aria-label="Add symbol">
        <Plus size={24} strokeWidth={2.6} />
      </button>
      <button type="button" className={`nav-item ${tab === 'config' ? 'active' : ''}`} onClick={() => onTab('config')}>
        <SlidersHorizontal size={22} strokeWidth={2.1} /><span>Indicators</span>
      </button>
    </nav>
  );
}
