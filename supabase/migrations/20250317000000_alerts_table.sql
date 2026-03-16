-- Per-user crossover alert history (persisted across refreshes and restarts)
-- Run in Supabase Dashboard → SQL Editor → New query → paste and Run.

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  fast_period INTEGER NOT NULL,
  slow_period INTEGER NOT NULL,
  fast_ema_value DOUBLE PRECISION NOT NULL,
  slow_ema_value DOUBLE PRECISION NOT NULL,
  crossover_type TEXT NOT NULL CHECK (crossover_type IN ('bullish', 'bearish')),
  price DOUBLE PRECISION NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  timestamp TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alerts_user_id ON alerts (user_id);
CREATE INDEX IF NOT EXISTS idx_alerts_user_created ON alerts (user_id, created_at DESC);
