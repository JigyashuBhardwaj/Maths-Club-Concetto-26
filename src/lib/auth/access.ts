import { getRole, loginPath, type RoleId } from "@/lib/roles";

/**
 * Route boundaries (B11). Pure functions only, so both the proxy and the server-side guard share one definition and
 * unit tests can cover every role/area pair without a framework.
 *
 * Each role owns exactly one area: PARTICIPANT -> /participant, ADMIN -> /admin, SUPER_ADMIN -> /superadmin.
 * There is deliberately no inheritance (a Super Admin does not browse /admin, an Admin never sees /superadmin).
 */
export type Area = RoleId;
export type PrincipalRole = "PARTICIPANT" | "ADMIN" | "SUPER_ADMIN";

const AREA_BY_ROLE: Record<PrincipalRole, Area> = {
  PARTICIPANT: "participant",
  ADMIN: "admin",
  SUPER_ADMIN: "superadmin",
};

export function areaOfRole(role: PrincipalRole): Area {
  return AREA_BY_ROLE[role];
}

/** Where a signed-in principal belongs: after login, and when it strays into another role's area. */
export function homeForRole(role: PrincipalRole): string {
  return getRole(areaOfRole(role)).home;
}

/** The protected area a request path belongs to, or `null` for public paths (`/`, `/login/*`, `/api/*`, assets). */
export function areaForPath(pathname: string): Area | null {
  for (const area of ["participant", "admin", "superadmin"] as const) {
    const base = getRole(area).home;
    if (pathname === base || pathname.startsWith(`${base}/`)) return area;
  }
  return null;
}

export type AccessDecision<P> =
  { allow: true; principal: P } | { allow: false; redirectTo: string };

/**
 * May `principal` (null = not signed in) see `area`? The answer for a denied request is always a redirect, never page
 * content: to the area's own sign-in page when nobody is signed in, to the caller's own home when someone is.
 */
export function decideAccess<P extends { role: PrincipalRole }>(
  principal: P | null,
  area: Area,
): AccessDecision<P> {
  if (!principal) return { allow: false, redirectTo: loginPath(area) };
  if (areaOfRole(principal.role) === area) return { allow: true, principal };
  return { allow: false, redirectTo: homeForRole(principal.role) };
}
