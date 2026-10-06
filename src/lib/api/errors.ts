/**
 * API error codes and their HTTP statuses (docs/API_SPEC.md §1–§2). Only the codes the auth layer can produce are
 * listed; later patches extend the table rather than inventing codes in handlers.
 */
export const ERROR_STATUS = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  VALIDATION_FAILED: 400,
  RATE_LIMITED: 429,
  COMPETITION_NOT_RUNNING: 423,
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
