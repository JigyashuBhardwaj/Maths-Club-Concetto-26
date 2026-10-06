import "server-only";

import { createClient } from "@supabase/supabase-js";

import { DbError, type Db, type DbFunction } from "./adapter";

/**
 * Service-role implementation of the adapter. The service-role key bypasses Row Level Security, so this module must
 * only ever run on the server (`server-only`) and the key must never be a NEXT_PUBLIC_ variable.
 */
export function createSupabaseDb(config: { url: string; serviceRoleKey: string }): Db {
  const client = createClient(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return {
    async rpc(fn: DbFunction, args: Record<string, unknown>) {
      const { data, error } = await client.rpc(fn, args);
      if (error) throw new DbError(fn, error.code);
      return data;
    },
  };
}
