/**
 * Server-side Supabase client (service role).
 * Use only in API routes or server code — never expose to the client.
 * Returns null if env vars are missing (callers should no-op or return empty).
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let client: SupabaseClient | null = null;
let loggedMissing = false;

export function getSupabaseAdmin(): SupabaseClient | null {
  if (!url || !serviceRoleKey) {
    if (!loggedMissing) {
      loggedMissing = true;
      const missing = [];
      if (!url) missing.push('NEXT_PUBLIC_SUPABASE_URL');
      if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
      console.error('[supabaseServer] Supabase not configured. Add to .env or .env.local:', missing.join(', '));
    }
    return null;
  }
  if (!client) client = createClient(url, serviceRoleKey);
  return client;
}
