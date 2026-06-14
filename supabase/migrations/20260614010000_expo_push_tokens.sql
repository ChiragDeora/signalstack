-- Store Expo push tokens for the React Native (Android) app.
create table if not exists public.expo_push_tokens (
  token text primary key,
  user_id text not null,
  platform text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists expo_push_tokens_user_idx on public.expo_push_tokens (user_id);
