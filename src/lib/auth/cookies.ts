import { SESSION_TTL_SECONDS, isWellFormedToken } from "./session";

/**
 * The `__Host-` prefix makes browsers require `Secure`, `Path=/` and no `Domain`, so the cookie cannot be set from a
 * sibling subdomain or over plain HTTP. Chromium and Firefox treat http://localhost as secure, so local development
 * works; other plain-HTTP origins (and Safari on localhost) need HTTPS. The attributes are never relaxed for development.
 */
export const SESSION_COOKIE_NAME = "__Host-session";

const ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Lax";

export function buildSessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}; Max-Age=${SESSION_TTL_SECONDS}; ${ATTRIBUTES}`;
}

export function buildClearedSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${ATTRIBUTES}`;
}

/** The session token from a `Cookie` header, or `null` when absent or malformed (a malformed value is never trusted). */
export function readSessionToken(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(eq + 1).trim();
    return isWellFormedToken(value) ? value : null;
  }
  return null;
}
