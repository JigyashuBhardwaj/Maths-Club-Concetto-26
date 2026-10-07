/**
 * Browser-side helper for the JSON API (docs/API_SPEC.md §1). It carries no credentials of its own: the session is
 * the HttpOnly cookie the browser attaches to same-origin requests, which script cannot read. Nothing here is ever
 * persisted (no localStorage / sessionStorage).
 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      /** HTTP status, or 0 when the request never completed (offline, aborted). */
      status: number;
      /** The API's stable error code, or NETWORK_ERROR / BAD_RESPONSE when there was no usable envelope. */
      code: string;
      details?: Record<string, unknown>;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function postJson<T>(
  url: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, code: "NETWORK_ERROR" };
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, status: response.status, code: "BAD_RESPONSE" };
  }
  const envelope = asRecord(json);
  if (envelope?.ok === true && response.ok) return { ok: true, data: envelope.data as T };
  const error = asRecord(envelope?.error);
  const code = typeof error?.code === "string" ? error.code : "BAD_RESPONSE";
  const details = asRecord(error?.details) ?? undefined;
  return { ok: false, status: response.status, code, details };
}
