/**
 * API error codes and their HTTP statuses (docs/API_SPEC.md §1–§2). Only the codes the implemented layers can produce
 * are listed (auth in B9, the competition runtime in B10); later patches extend the table rather than inventing codes
 * in handlers.
 */
export const ERROR_STATUS = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  VALIDATION_FAILED: 400,
  RATE_LIMITED: 429,
  NOT_FOUND: 404,
  COMPETITION_NOT_RUNNING: 423,
  COMPETITION_PAUSED: 423,
  TEAM_NOT_STARTED: 409,
  TEAM_ENDED: 409,
  ALREADY_SUBMITTED: 409,
  COMPETITION_NOT_READY: 409,
  INVALID_COMPETITION_TRANSITION: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  USERNAME_TAKEN: 409,
  TEAM_CODE_TAKEN: 409,
  LOGIN_ID_TAKEN: 409,
  ADMISSION_NO_TAKEN: 409,
  SERVICE_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/** Every authentication failure says exactly this, whichever credential was wrong (docs/API_SPEC.md §3). */
export const INVALID_CREDENTIALS_MESSAGE = "Invalid credentials";

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  readonly headers?: Record<string, string>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = options.details;
    this.headers = options.headers;
  }
}

/** The result a login function returns when it refuses (`{ ok: false, code, ... }`) mapped to an API error. */
export function authFailureToError(result: {
  code: string;
  retry_after_seconds?: number;
}): ApiError {
  switch (result.code) {
    case "RATE_LIMITED": {
      const wait = Math.max(1, Math.ceil(result.retry_after_seconds ?? 1));
      return new ApiError("RATE_LIMITED", "Too many attempts. Try again later.", {
        details: { retry_after_seconds: wait },
        headers: { "Retry-After": String(wait) },
      });
    }
    case "COMPETITION_NOT_RUNNING":
      return new ApiError("COMPETITION_NOT_RUNNING", "The competition is not open.");
    case "UNAUTHENTICATED":
    case "INVALID_CREDENTIALS":
      return new ApiError("UNAUTHENTICATED", INVALID_CREDENTIALS_MESSAGE);
    default:
      // Unknown codes must never leak through as something more specific than a generic failure.
      return new ApiError("UNAUTHENTICATED", INVALID_CREDENTIALS_MESSAGE);
  }
}

/** Client-safe messages for the codes the database can raise. The database message is never forwarded. */
const DB_ERROR_MESSAGES: Partial<Record<ErrorCode, string>> = {
  VALIDATION_FAILED: "Invalid request.",
  FORBIDDEN: "You are not allowed to do that.",
  NOT_FOUND: "Not found.",
  COMPETITION_NOT_RUNNING: "The competition is not open.",
  COMPETITION_PAUSED: "The competition is paused.",
  TEAM_NOT_STARTED: "The team has not started.",
  TEAM_ENDED: "The team's time has ended.",
  ALREADY_SUBMITTED: "Team already submitted.",
  COMPETITION_NOT_READY: "The competition is not ready to open.",
  INVALID_COMPETITION_TRANSITION: "That change is not allowed in the current state.",
  IDEMPOTENCY_KEY_REUSED: "This Idempotency-Key was already used for a different request.",
  USERNAME_TAKEN: "That username is already taken.",
  TEAM_CODE_TAKEN: "That Team ID is already in use.",
  LOGIN_ID_TAKEN: "That Login ID is already in use.",
  ADMISSION_NO_TAKEN: "An admission number is already registered to a team.",
};

/** Only these codes may carry details, and only flat primitives: counts, state names and field names. */
const DETAILS_ALLOWED = new Set<ErrorCode>([
  "VALIDATION_FAILED",
  "COMPETITION_NOT_READY",
  "INVALID_COMPETITION_TRANSITION",
  "ADMISSION_NO_TAKEN",
]);

function safeDetails(code: ErrorCode, raw: unknown): Record<string, unknown> | undefined {
  if (!DETAILS_ALLOWED.has(code) || typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 8)) {
    if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 64);
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      out[k] = (v as string[]).slice(0, 8).map((x) => x.slice(0, 64));
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Maps an application error raised by a database function (`P0001`, message = stable code) to an API error. Anything
 * else — a constraint violation, a transport failure, an unknown code — becomes a generic retryable 503: raw
 * PostgreSQL text is never put in a response.
 */
export function dbRaisedToApiError(
  appCode: string | undefined,
  details: Record<string, unknown> | undefined,
): ApiError {
  const code = appCode as ErrorCode | undefined;
  const message = code ? DB_ERROR_MESSAGES[code] : undefined;
  if (code && message) {
    return new ApiError(code, message, { details: safeDetails(code, details) });
  }
  return new ApiError("SERVICE_UNAVAILABLE", "Temporarily unavailable. Please retry.");
}
