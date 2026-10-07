import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ApiError } from "@/lib/api/errors";

import { decideAccess, type Area } from "./access";
import { SESSION_COOKIE_NAME } from "./cookies";
import { resolvePrincipalFromToken, type Principal } from "./principal";
import { authDeps } from "./routes";
import { isWellFormedToken } from "./session";

/**
 * The principal behind this request's session cookie, or `null` when there is no live session (no cookie, a malformed
 * one, or one the database says is unknown / revoked / expired / of a disabled account). It uses the same database
 * function as `GET /api/auth/me`, so a page and the API can never disagree about who is signed in.
 *
 * Anything that is NOT "unauthenticated" (the database is down, a malformed result) is rethrown: a failure to find
 * out who someone is must never be treated as an answer in either direction, and the error boundary shows a generic
 * message. `cache` keeps this to one database call per request however many layouts and pages ask.
 */
export const getPrincipal = cache(async (): Promise<Principal | null> => {
  const value = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const token = isWellFormedToken(value) ? value : null;
  if (!token) return null;
  try {
    return await resolvePrincipalFromToken(
      authDeps.db(),
      token,
      authDeps.env().SESSION_TOKEN_PEPPER,
    );
  } catch (err) {
    if (err instanceof ApiError && err.code === "UNAUTHENTICATED") return null;
    throw err;
  }
});

/**
 * Server-side route guard: call it from the layout AND the page of every protected area (a layout is not re-rendered
 * on client-side navigation, a page is). Redirects (never renders) unless the caller's role owns `area`.
 */
export async function requireArea(area: Area): Promise<Principal> {
  const principal = await getPrincipal();
  const decision = decideAccess(principal, area);
  if (!decision.allow) redirect(decision.redirectTo);
  return decision.principal;
}
