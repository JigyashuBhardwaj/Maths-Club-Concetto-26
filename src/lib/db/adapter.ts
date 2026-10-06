/**
 * Database adapter (docs/ARCHITECTURE.md §3, A1). Route handlers talk to the engine only through `rpc`, so they can
 * be unit-tested with a fake. The production implementation (`./supabase`) uses the service-role key and exists only
 * on the server.
 */

/** The database functions the server may call. Extend deliberately; a typo must not reach the database. */
export type DbFunction = "participant_login" | "staff_login" | "resolve_session" | "revoke_session";

export interface Db {
  /** Calls one database function and returns its JSON result. Throws `DbError` on any transport/database error. */
  rpc(fn: DbFunction, args: Record<string, unknown>): Promise<unknown>;
}

/** Carries no request data: `fn` and a SQLSTATE-like code are enough to debug, and nothing here can leak a secret. */
export class DbError extends Error {
  readonly fn: DbFunction;
  readonly code: string | undefined;

  constructor(fn: DbFunction, code?: string) {
    super(`database call failed: ${fn}${code ? ` (${code})` : ""}`);
    this.name = "DbError";
    this.fn = fn;
    this.code = code;
  }
}
