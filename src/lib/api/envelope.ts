import { ApiError } from "./errors";

/** Response envelope (docs/API_SPEC.md §1). Times are epoch milliseconds. */
export type SuccessEnvelope<T> = { ok: true; data: T; server_now: number; state_version?: number };
export type FailureEnvelope = {
  ok: false;
  error: { code: string; message: string; details?: Record<string, unknown> };
  server_now: number;
};

const BASE_HEADERS = { "Cache-Control": "no-store" } as const;

export function success<T>(
  data: T,
  now: number,
  init: { status?: number; headers?: HeadersInit } = {},
): Response {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(BASE_HEADERS)) headers.set(k, v);
  const body: SuccessEnvelope<T> = { ok: true, data, server_now: now };
  return Response.json(body, { status: init.status ?? 200, headers });
}

export function failure(error: ApiError, now: number, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  for (const [k, v] of Object.entries(BASE_HEADERS)) headers.set(k, v);
  for (const [k, v] of Object.entries(error.headers ?? {})) headers.set(k, v);
  const body: FailureEnvelope = {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
    server_now: now,
  };
  return Response.json(body, { status: error.status, headers });
}

/**
 * Runs a handler body and turns anything it throws into an envelope. An `ApiError` keeps its own code and status;
 * anything else becomes a generic retryable 503. Nothing from the thrown value (it may carry request data or
 * infrastructure detail) is put in the response, and only its name is logged: never a body, password or token.
 */
export async function respond(
  now: () => number,
  run: () => Promise<Response>,
  clearCookie?: () => string,
): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    const apiError =
      err instanceof ApiError
        ? err
        : new ApiError("SERVICE_UNAVAILABLE", "Temporarily unavailable. Please retry.");
    if (!(err instanceof ApiError)) {
      console.error("api: unexpected error", err instanceof Error ? err.name : typeof err);
    }
    const headers = new Headers();
    if (clearCookie && apiError.code === "UNAUTHENTICATED") {
      headers.append("Set-Cookie", clearCookie());
    }
    return failure(apiError, now(), headers);
  }
}
