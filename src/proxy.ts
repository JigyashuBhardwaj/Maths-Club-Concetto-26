import { NextResponse, type NextRequest } from "next/server";

import { areaForPath } from "@/lib/auth/access";
import { readSessionToken } from "@/lib/auth/cookies";
import { loginPath } from "@/lib/roles";

/**
 * First line of route protection for /participant, /admin and /superadmin: a request without a well-formed session
 * cookie never reaches a page, and protected responses are never cached by the browser or a shared cache (so the
 * back button after sign-out cannot replay a page).
 *
 * This is deliberately only a pre-filter. It does not (and cannot cheaply) ask the database whether the cookie is
 * live; that authoritative check, and the role-versus-area decision, happen in the pages themselves through
 * `requireArea` in `src/lib/auth/guard.ts`. A forged but well-formed cookie passes here and is rejected there.
 */
export function proxy(request: NextRequest): NextResponse {
  const area = areaForPath(request.nextUrl.pathname);
  if (!area) return NextResponse.next(); // not a protected path (the matcher normally keeps these out entirely)
  if (!readSessionToken(request.headers.get("cookie"))) {
    const url = request.nextUrl.clone();
    url.pathname = loginPath(area);
    url.search = "";
    const redirect = NextResponse.redirect(url);
    redirect.headers.set("Cache-Control", "no-store");
    return redirect;
  }
  const response = NextResponse.next();
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const config = { matcher: ["/participant/:path*", "/admin/:path*", "/superadmin/:path*"] };
