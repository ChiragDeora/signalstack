-- SignalStack: user config, watches, push subscriptions (Clerk user_id)
-- Run in Supabase Dashboard → SQL Editor → New query → paste and Run.

-- User UI config (symbols, timeframes, EMAs, preferences) — one row per user
CREATE TABLE IF NOT EXISTS user_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL UNIQUE,
  symbols JSONB NOT NULL DEFAULT '[]',
  timeframe_by_symbol JSONB NOT NULL DEFAULT '{}',
  emas_by_symbol JSONB NOT NULL DEFAULT '{}',
  track_bullish BOOLEAN NOT NULL DEFAULT true,
  track_bearish BOOLEAN NOT NULL DEFAULT true,
  selected_symbol TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_config_user_id ON user_config (user_id);

-- Active monitoring watches (per user) — restored on server startup
CREATE TABLE IF NOT EXISTS watches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  ema_periods JSONB NOT NULL DEFAULT '[]',
  track_bullish BOOLEAN NOT NULL DEFAULT true,
  track_bearish BOOLEAN NOT NULL DEFAULT true,
  exchange TEXT NOT NULL DEFAULT 'NSE',
  currency TEXT NOT NULL DEFAULT 'INR',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, symbol, timeframe)
);

CREATE INDEX IF NOT EXISTS idx_watches_user_id ON watches (user_id);

-- Push notification subscriptions — restored on server startup
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT,
  endpoint TEXT NOT NULL UNIQUE,
  keys_p256dh TEXT NOT NULL,
  keys_auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_endpoint ON push_subscriptions (endpoint);
