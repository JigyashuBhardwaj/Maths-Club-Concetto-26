import { createHmac, randomBytes } from "node:crypto";

/** Session lifetime: a hard expiry of 12 hours (docs/SECURITY.md SEC-05). The database sets `expires_at` from it. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url, no padding

/** A cryptographically random 32-byte token, base64url encoded (43 characters). Only ever sent in the cookie. */
export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function isWellFormedToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

/**
 * What is stored: HMAC-SHA256 of the token keyed with SESSION_TOKEN_PEPPER, as a PostgREST `bytea` literal
 * (`\x` + 64 hex digits). The token itself is never stored; without the pepper a database leak cannot be used to
 * brute-force or forge a cookie.
 */
export function hashSessionToken(token: string, pepper: string): string {
  return `\\x${createHmac("sha256", pepper).update(token, "utf8").digest("hex")}`;
}
