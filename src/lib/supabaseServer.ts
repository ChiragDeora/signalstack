/**
 * Server-side Supabase client (service role).
 * Use only in API routes or server code — never expose to the client.
 * Returns null if env vars are missing (callers should no-op or return empty).
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let client: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient | null {
  if (!url || !serviceRoleKey) return null;
  if (!client) client = createClient(url, serviceRoleKey);
  return client;
}
