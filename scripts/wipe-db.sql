-- ================================================
-- Wipe all data from SignalStack tables (keep schema)
-- Run via Supabase SQL Editor or psql
-- ================================================

TRUNCATE TABLE alerts RESTART IDENTITY CASCADE;
TRUNCATE TABLE watches RESTART IDENTITY CASCADE;
TRUNCATE TABLE push_subscriptions RESTART IDENTITY CASCADE;
TRUNCATE TABLE watchlist RESTART IDENTITY CASCADE;
TRUNCATE TABLE ema_settings RESTART IDENTITY CASCADE;
TRUNCATE TABLE profiles RESTART IDENTITY CASCADE;
TRUNCATE TABLE user_config RESTART IDENTITY CASCADE;

-- Verify
SELECT 'alerts' AS "table", count(*) FROM alerts
UNION ALL SELECT 'watches', count(*) FROM watches
UNION ALL SELECT 'push_subscriptions', count(*) FROM push_subscriptions
UNION ALL SELECT 'watchlist', count(*) FROM watchlist
UNION ALL SELECT 'ema_settings', count(*) FROM ema_settings
UNION ALL SELECT 'profiles', count(*) FROM profiles
UNION ALL SELECT 'user_config', count(*) FROM user_config;
