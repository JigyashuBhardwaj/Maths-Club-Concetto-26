/**
 * Database adapter (docs/ARCHITECTURE.md §3, A1). Route handlers talk to the engine only through `rpc`, so they can
 * be unit-tested with a fake. The production implementation (`./supabase`) uses the service-role key and exists only
 * on the server.
 */

/** The database functions the server may call. Extend deliberately; a typo must not reach the database. */
export type DbFunction =
  | "participant_login"
  | "staff_login"
  | "resolve_session"
  | "revoke_session"
  | "start_team_competition"
  | "get_team_state"
  | "set_competition_status";

export interface Db {
  /** Calls one database function and returns its JSON result. Throws `DbError` on any transport/database error. */
  rpc(fn: DbFunction, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * Carries no request data: `fn` and a SQLSTATE-like code are enough to debug, and nothing here can leak a secret.
 * `appCode` is set only for an application error the engine raised on purpose (`P0001` whose message is a stable
 * upper-case code such as `COMPETITION_PAUSED`); `details` is the parsed JSON `DETAIL` of that error, if any.
 */
export class DbError extends Error {
  readonly fn: DbFunction;
  readonly code: string | undefined;
  readonly appCode: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    fn: DbFunction,
    code?: string,
    app: { appCode?: string; details?: Record<string, unknown> } = {},
  ) {
    super(`database call failed: ${fn}${code ? ` (${code})` : ""}`);
    this.name = "DbError";
    this.fn = fn;
    this.code = code;
    this.appCode = app.appCode;
    this.details = app.details;
  }
}

const APP_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

/**
 * Builds a `DbError` from a PostgREST error object (`{ code, message, details }`). The message is trusted as an
 * application code only when the SQLSTATE is `P0001` AND it has the shape of a code; everything else keeps only the
 * SQLSTATE, so raw database text can never reach a response or a log through this path.
 */
export function toDbError(
  fn: DbFunction,
  error: { code?: string; message?: string; details?: string | null },
): DbError {
  const isApp =
    error.code === "P0001" && typeof error.message === "string" && APP_CODE.test(error.message);
  if (!isApp) return new DbError(fn, error.code);
  let details: Record<string, unknown> | undefined;
  if (typeof error.details === "string" && error.details.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(error.details);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        details = parsed as Record<string, unknown>;
      }
    } catch {
      details = undefined;
    }
  }
  return new DbError(fn, error.code, { appCode: error.message, details });
}
