-- Normalized user profile, symbol watchlist, and default EMA periods (Clerk user_id)
-- Run in Supabase SQL Editor if not applied via migrations.

CREATE TABLE IF NOT EXISTS profiles (
  user_id TEXT PRIMARY KEY,
  email TEXT,
  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS watchlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, symbol)
);

CREATE INDEX IF NOT EXISTS idx_watchlist_user_id ON watchlist (user_id);

CREATE TABLE IF NOT EXISTS ema_settings (
  user_id TEXT PRIMARY KEY,
  ema_1 INTEGER NOT NULL DEFAULT 10,
  ema_2 INTEGER NOT NULL DEFAULT 20,
  ema_3 INTEGER NOT NULL DEFAULT 50,
  ema_4 INTEGER NOT NULL DEFAULT 200,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE profiles IS 'Clerk user profile (email/name for cross-check)';
COMMENT ON TABLE watchlist IS 'User symbol list — source of truth for which symbols are watched';
COMMENT ON TABLE ema_settings IS 'Default EMA periods applied when a symbol has no per-symbol EMA config';
