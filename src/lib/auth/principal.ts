import { ApiError } from "@/lib/api/errors";
import { dbPrincipalSchema, type AuthPrincipalData } from "@/lib/contracts/auth";
import type { TeamStatus } from "@/lib/contracts/competition";
import type { Db } from "@/lib/db/adapter";

import { readSessionToken } from "./cookies";
import { hashSessionToken } from "./session";

export type Principal =
  | {
      role: "PARTICIPANT";
      sessionId: string;
      expiresAt: number;
      member: { id: string; slot: number };
      team: { id: string; code: string; name: string; status: TeamStatus };
    }
  | {
      role: "ADMIN" | "SUPER_ADMIN";
      sessionId: string;
      expiresAt: number;
      staff: { id: string; name: string };
    };

/** Validates a `resolve_session` / login result from the database and turns it into a principal. */
export function parsePrincipal(raw: unknown): Principal {
  const parsed = dbPrincipalSchema.safeParse(raw);
  // A malformed result is an infrastructure fault, not an authentication outcome: never treat it as a login.
  if (!parsed.success)
    throw new ApiError("SERVICE_UNAVAILABLE", "Temporarily unavailable. Please retry.");
  const r = parsed.data;
  const base = { sessionId: r.session.id, expiresAt: Date.parse(r.session.expires_at) };
  if (r.role === "PARTICIPANT") {
    return { role: "PARTICIPANT", ...base, member: r.member, team: r.team };
  }
  return { role: r.role, ...base, staff: { id: r.staff.id, name: r.staff.display_name } };
}

/** The `data` shape returned to the client by login and `GET /api/auth/me`. */
export function principalToData(p: Principal): AuthPrincipalData {
  if (p.role === "PARTICIPANT") {
    return {
      role: "PARTICIPANT",
      member: { id: p.member.id, slot: p.member.slot },
      team: {
        id: p.team.id,
        code: p.team.code,
        name: p.team.name,
        status: p.team.status,
      },
      session: { expires_at: p.expiresAt },
    };
  }
  return {
    role: p.role,
    staff: { id: p.staff.id, name: p.staff.name },
    session: { expires_at: p.expiresAt },
  };
}

/**
 * Cookie -> principal. Authorisation always starts here: the role and the team come from the session row, never from
 * the request body, path or headers (SEC-03). Every dead, expired, revoked or unknown token is the same 401.
 */
export async function resolvePrincipal(
  db: Db,
  request: Request,
  pepper: string,
): Promise<Principal> {
  const token = readSessionToken(request.headers.get("cookie"));
  if (!token) throw new ApiError("UNAUTHENTICATED", "Not signed in.");
  const raw = await db.rpc("resolve_session", { p_token_hash: hashSessionToken(token, pepper) });
  if (typeof raw === "object" && raw !== null && (raw as { ok?: unknown }).ok === false) {
    throw new ApiError("UNAUTHENTICATED", "Not signed in.");
  }
  return parsePrincipal(raw);
}
