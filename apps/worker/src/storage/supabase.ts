import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@udara/db-types";
import type { Env } from "../env.js";

export type Db = SupabaseClient<Database>;

/**
 * Service-role client (the Supabase secret key bypasses RLS: Worker only, rule 1).
 * Returns null when storage isn't configured; ingestion then stays off and the live view
 * keeps working.
 */
export function serviceClient(env: Env): Db | null {
  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_SECRET_KEY?.trim();
  if (!url || !key || url.includes("xxxxxxxx")) return null;
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
