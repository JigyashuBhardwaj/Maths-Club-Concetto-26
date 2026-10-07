import { isIP } from "node:net";

import type { z } from "zod";

import { respond, success } from "@/lib/api/envelope";
import { ApiError, authFailureToError } from "@/lib/api/errors";
import { dbFailureSchema, participantLoginSchema, staffLoginSchema } from "@/lib/contracts/auth";
import type { Db } from "@/lib/db/adapter";
import type { AuthEnv } from "@/lib/env/auth";

import { buildClearedSessionCookie, buildSessionCookie, readSessionToken } from "./cookies";
import { assertSameOrigin } from "./origin";
import { parsePrincipal, principalToData, resolvePrincipal } from "./principal";
import { generateSessionToken, hashSessionToken } from "./session";

/** Everything a handler needs from the outside world, so tests can inject a fake database and a fixed clock. */
export interface AuthDeps {
  db: () => Db;
  env: () => AuthEnv;
  now: () => number;
  /** Overridable for deterministic tests; production uses a CSPRNG. */
  newToken?: () => string;
}

/** Login bodies carry three short strings; 2 KB is the documented limit for non-answer requests (API_SPEC §8). */
const MAX_BODY_BYTES = 2048;

export async function readJson<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<z.infer<S>> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) {
    throw new ApiError("VALIDATION_FAILED", "Send a JSON body.");
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new ApiError("VALIDATION_FAILED", "Request body is too large.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new ApiError("VALIDATION_FAILED", "Request body is too large.");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ApiError("VALIDATION_FAILED", "Request body is not valid JSON.");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    // Field NAMES only. The values (a password among them) are never echoed back or logged.
    const fields = [
      ...new Set(parsed.error.issues.flatMap((i) => (i.path.length ? [i.path.join(".")] : []))),
    ];
    const unknown = parsed.error.issues.some((i) => i.code === "unrecognized_keys");
    throw new ApiError(
      "VALIDATION_FAILED",
      unknown ? "Unexpected field in request." : "Invalid request.",
      {
        details: { fields },
      },
    );
  }
  return parsed.data;
}

/** First address of `X-Forwarded-For` (set by the platform), only if it is a valid IP; recorded for the audit trail. */
function clientIp(request: Request): string | null {
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first && isIP(first) ? first : null;
}

function userAgent(request: Request): string | null {
  const ua = request.headers.get("user-agent");
  return ua ? ua.slice(0, 256) : null;
}

/** Shared tail of both logins: the database refused, or the principal it returned is valid and gets a cookie. */
function finishLogin(raw: unknown, token: string, deps: AuthDeps): Response {
  const refusal = dbFailureSchema.safeParse(raw);
  if (refusal.success) throw authFailureToError(refusal.data);
  const principal = parsePrincipal(raw);
  const headers = new Headers();
  headers.append("Set-Cookie", buildSessionCookie(token));
  return success(principalToData(principal), deps.now(), { headers });
}

/** POST /api/auth/participant/login */
export function createParticipantLoginHandler(deps: AuthDeps) {
  return (request: Request): Promise<Response> =>
    respond(deps.now, async () => {
      const env = deps.env();
      assertSameOrigin(request, env.APP_ORIGIN);
      const input = await readJson(request, participantLoginSchema);
      const token = (deps.newToken ?? generateSessionToken)();
      const raw = await deps.db().rpc("participant_login", {
        p_login_id: input.teamLoginId,
        p_password: input.password,
        p_admission_no: input.admissionNo,
        p_token_hash: hashSessionToken(token, env.SESSION_TOKEN_PEPPER),
        p_ip: clientIp(request),
        p_user_agent: userAgent(request),
      });
      return finishLogin(raw, token, deps);
    });
}

/** POST /api/auth/staff/login */
export function createStaffLoginHandler(deps: AuthDeps) {
  return (request: Request): Promise<Response> =>
    respond(deps.now, async () => {
      const env = deps.env();
      assertSameOrigin(request, env.APP_ORIGIN);
      const input = await readJson(request, staffLoginSchema);
      const token = (deps.newToken ?? generateSessionToken)();
      const raw = await deps.db().rpc("staff_login", {
        p_username: input.username,
        p_password: input.password,
        p_token_hash: hashSessionToken(token, env.SESSION_TOKEN_PEPPER),
        p_ip: clientIp(request),
        p_user_agent: userAgent(request),
      });
      return finishLogin(raw, token, deps);
    });
}

/** POST /api/auth/logout — idempotent: always clears the cookie and answers 200, whether or not a session existed. */
export function createLogoutHandler(deps: AuthDeps) {
  return (request: Request): Promise<Response> =>
    respond(deps.now, async () => {
      const env = deps.env();
      assertSameOrigin(request, env.APP_ORIGIN);
      const token = readSessionToken(request.headers.get("cookie"));
      if (token) {
        await deps.db().rpc("revoke_session", {
          p_token_hash: hashSessionToken(token, env.SESSION_TOKEN_PEPPER),
        });
      }
      const headers = new Headers();
      headers.append("Set-Cookie", buildClearedSessionCookie());
      return success({}, deps.now(), { headers });
    });
}

/** GET /api/auth/me — the principal behind the cookie; a dead cookie is a 401 that also clears it. */
export function createMeHandler(deps: AuthDeps) {
  return (request: Request): Promise<Response> =>
    respond(
      deps.now,
      async () => {
        const env = deps.env();
        const principal = await resolvePrincipal(deps.db(), request, env.SESSION_TOKEN_PEPPER);
        return success(principalToData(principal), deps.now());
      },
      buildClearedSessionCookie,
    );
}
