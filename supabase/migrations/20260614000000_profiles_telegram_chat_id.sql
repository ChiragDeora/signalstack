-- Add optional Telegram chat id so users can receive alerts in Telegram.
alter table public.profiles
  add column if not exists telegram_chat_id text;
