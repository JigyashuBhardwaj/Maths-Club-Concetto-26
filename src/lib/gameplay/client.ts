/**
 * Browser-side calls of the participant gameplay API (Patch B13). The session is the HttpOnly cookie the browser
 * attaches to same-origin requests; nothing here is persisted (no localStorage / sessionStorage) and nothing in a
 * request is authority: the team and member come from the session, and every state, balance and timer the screen
 * shows comes back from the server.
 *
 * Every function returns a result, never throws, and carries the envelope's `server_now` / `state_version` so the
 * caller can align its clock and ignore a stale snapshot.
 */
import { enterResultSchema, questionResultSchema } from "@/lib/contracts/gameplay";
import type { Question } from "@/lib/contracts/gameplay";
import { teamStateSchema, type TeamState } from "@/lib/contracts/runtime";

export type CallFailure = {
  ok: false;
  /** HTTP status, or 0 when the request never completed (offline, aborted). */
  status: number;
  /** The API's stable error code, or NETWORK_ERROR / BAD_RESPONSE when there was no usable envelope. */
  code: string;
  details?: Record<string, unknown>;
};
export type CallOk<T> = {
  ok: true;
  data: T;
  serverNow: number | null;
  stateVersion: number | null;
};
export type CallResult<T> = CallOk<T> | CallFailure;

const record = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export async function call(
  method: "GET" | "POST" | "PUT",
  url: string,
  opts: { body?: unknown; key?: string; fetchImpl?: typeof fetch } = {},
): Promise<CallResult<unknown>> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.key) headers["Idempotency-Key"] = opts.key;
  let response: Response;
  try {
    response = await (opts.fetchImpl ?? fetch)(url, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
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
  const envelope = record(json);
  if (envelope?.ok === true && response.ok) {
    return {
      ok: true,
      data: envelope.data,
      serverNow: typeof envelope.server_now === "number" ? envelope.server_now : null,
      stateVersion: typeof envelope.state_version === "number" ? envelope.state_version : null,
    };
  }
  const error = record(envelope?.error);
  return {
    ok: false,
    status: response.status,
    code: typeof error?.code === "string" ? error.code : "BAD_RESPONSE",
    details: record(error?.details) ?? undefined,
  };
}

/** Validates a successful payload against its whitelist; anything else is a BAD_RESPONSE, never trusted. */
export function checked<T>(
  r: CallResult<unknown>,
  parse: (data: unknown) => T | null,
): CallResult<T> {
  if (!r.ok) return r;
  const data = parse(r.data);
  if (data === null) return { ok: false, status: 200, code: "BAD_RESPONSE" };
  return { ...r, data };
}

const parseState = (d: unknown): TeamState | null => {
  const p = teamStateSchema.safeParse(d);
  return p.success ? p.data : null;
};

export interface StartOutcome {
  started_now: boolean;
}

/** `GET /api/p/state` — the authoritative snapshot of the caller's own team. */
export async function fetchTeamState(fetchImpl?: typeof fetch): Promise<CallResult<TeamState>> {
  return checked(await call("GET", "/api/p/state", { fetchImpl }), parseState);
}

/** `POST /api/p/start` — "Enter competition": the first valid member starts the team timer (idempotent). */
export async function enterCompetition(key: string): Promise<CallResult<TeamState>> {
  return checked(await call("POST", "/api/p/start", { key }), parseState);
}

/** `POST /api/p/themes/:id/unlock` — team-wide, charged once. Returns the fresh snapshot. */
export async function unlockThemeCall(
  themeId: number,
  key: string,
): Promise<CallResult<TeamState>> {
  return checked(await call("POST", `/api/p/themes/${themeId}/unlock`, { key }), parseState);
}

/** `GET /api/p/questions/:id` — the body (once entered), the shared draft and the team's own submission. */
export async function fetchQuestion(questionId: number): Promise<CallResult<Question>> {
  const r = await call("GET", `/api/p/questions/${questionId}`);
  return checked(r, (d) => {
    const p = questionResultSchema.pick({ question: true }).safeParse(d);
    return p.success ? p.data.question : null;
  });
}

/** `POST /api/p/questions/:id/enter` — opening the page starts the question's own timer once; no Start button. */
export async function enterQuestionCall(
  questionId: number,
  key: string,
): Promise<CallResult<Question>> {
  const r = await call("POST", `/api/p/questions/${questionId}/enter`, { key });
  return checked(r, (d) => {
    const p = enterResultSchema.pick({ started_now: true, question: true }).safeParse(d);
    return p.success ? p.data.question : null;
  });
}

export interface DraftSaved {
  version: number;
  updated_by_slot: number | null;
  updated_at: number | null;
}

/** `PUT /api/p/questions/:id/draft` — compare-and-set autosave of the shared draft. */
export async function saveDraftCall(
  questionId: number,
  answer: string,
  expectedVersion: number,
): Promise<CallResult<DraftSaved>> {
  const r = await call("PUT", `/api/p/questions/${questionId}/draft`, {
    body: { answer, explanation: "", expectedVersion },
  });
  return checked(r, (d) => {
    const o = record(d);
    return o && typeof o.version === "number"
      ? {
          version: o.version,
          updated_by_slot: typeof o.updated_by_slot === "number" ? o.updated_by_slot : null,
          updated_at: typeof o.updated_at === "number" ? o.updated_at : null,
        }
      : null;
  });
}

/** `POST /api/p/questions/:id/submit` — freezes the question timer; the team waits for review. */
export async function submitAnswerCall(
  questionId: number,
  answer: string,
  key: string,
): Promise<CallResult<Question>> {
  const r = await call("POST", `/api/p/questions/${questionId}/submit`, {
    body: { answer, explanation: "" },
    key,
  });
  return checked(r, (d) => {
    const q = record(d)?.question;
    const p = questionResultSchema.shape.question.safeParse(q);
    return p.success ? p.data : null;
  });
}

/**
 * `POST /api/p/heartbeat` — "this browser is still here" (Patch B14). It only refreshes the session's last-seen time,
 * which the Admin matrix shows as IN / OUT. It carries no data, never throws and its answer is ignored; a lost beat is
 * simply followed by the next one (the Admin sees OUT only after a whole timeout without any).
 */
export async function sendHeartbeat(fetchImpl?: typeof fetch): Promise<CallResult<unknown>> {
  return call("POST", "/api/p/heartbeat", { fetchImpl });
}
