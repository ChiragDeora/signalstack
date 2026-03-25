-- ================================================
-- Wipe all data from SignalStack tables (keep schema)
-- Run via Supabase SQL Editor or psql
-- ================================================

TRUNCATE TABLE alerts RESTART IDENTITY CASCADE;
TRUNCATE TABLE watches RESTART IDENTITY CASCADE;
TRUNCATE TABLE push_subscriptions RESTART IDENTITY CASCADE;
TRUNCATE TABLE user_config RESTART IDENTITY CASCADE;

-- Verify
SELECT 'alerts' AS "table", count(*) FROM alerts
UNION ALL SELECT 'watches', count(*) FROM watches
UNION ALL SELECT 'push_subscriptions', count(*) FROM push_subscriptions
UNION ALL SELECT 'user_config', count(*) FROM user_config;
