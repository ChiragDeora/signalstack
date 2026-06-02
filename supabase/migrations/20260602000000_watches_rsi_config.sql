-- SignalStack: add RSI config to watches table
-- Adds nullable rsi_config jsonb column. When null/missing → RSI tracking disabled.
-- When present, expected shape:
-- {
--   "enabled": true,
--   "period": 14,
--   "overbought": 70,
--   "oversold": 30,
--   "signals": {
--     "overboughtCross": true,
--     "oversoldCross": true,
--     "thresholdBreach": false,
--     "centerlineCross": false
--   }
-- }

ALTER TABLE watches
  ADD COLUMN IF NOT EXISTS rsi_config JSONB;
