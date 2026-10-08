import { timingSafeEqual } from "node:crypto";

import { failure, success } from "@/lib/api/envelope";
import { ApiError } from "@/lib/api/errors";
import type { Db } from "@/lib/db/adapter";
import { z } from "zod";

/**
 * `GET /api/cron/expire-teams` (Patch B15): the scheduled safety net that persists the ENDED status of teams whose
 * timer ran out while nobody was looking. Lazy finalization (every participant read and every refused mutation) is the
 * primary correctness path; this only makes the stored state converge even for a team that never reads again.
 *
 * Authentication is a bearer secret and nothing else (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`):
 *   - the secret is compared in constant time, and a missing, malformed or wrong header is a 401 BEFORE any database call;
 *   - a deployment without `CRON_SECRET` refuses everything (fail closed);
 *   - only GET exists, so there is no cookie, no Origin check and no CSRF surface; other methods are 405;
 *   - the response is `no-store` and never contains the secret, and nothing request-supplied reaches the database.
 */
export interface CronDeps {
  db: () => Db;
  /** The configured secret, or `undefined` when none is set. */
  secret: () => string | undefined;
  now: () => number;
}

/** One sweep processes at most this many teams (the database function caps it at 1000). */
export const SWEEP_LIMIT = 200;

const sweepResultSchema = z.number().int().nonnegative();

function secretMatches(header: string | null, secret: string): boolean {
  const match = /^Bearer (\S+)$/.exec(header ?? "");
  if (!match) return false;
  const given = Buffer.from(match[1]!);
  const expected = Buffer.from(secret);
  // Equal-length buffers are compared in constant time; a length mismatch is already a rejection.
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const unauthorized = (deps: CronDeps) =>
  failure(new ApiError("UNAUTHENTICATED", "Unauthorized"), deps.now(), {
    "WWW-Authenticate": "Bearer",
  });

export function createExpireTeamsHandler(deps: CronDeps) {
  return async (request: Request): Promise<Response> => {
    const secret = deps.secret();
    if (!secret || !secretMatches(request.headers.get("authorization"), secret)) {
      return unauthorized(deps);
    }
    try {
      const raw = await deps.db().rpc("expire_due_teams", { p_limit: SWEEP_LIMIT });
      const parsed = sweepResultSchema.safeParse(raw);
      if (!parsed.success) throw new Error("malformed result");
      return success({ finalized: parsed.data }, deps.now());
    } catch (err) {
      console.error("cron: expire_due_teams failed", err instanceof Error ? err.name : typeof err);
      return failure(
        new ApiError("SERVICE_UNAVAILABLE", "Temporarily unavailable. Please retry."),
        deps.now(),
      );
    }
  };
}

/** Anything but GET: 405 with an `Allow` header (and, as everywhere, no body that could leak anything). */
export function methodNotAllowed(): Response {
  return new Response(null, {
    status: 405,
    headers: { Allow: "GET", "Cache-Control": "no-store" },
  });
}
