/**
 * Password rules shared with the database (supabase/migrations/…_auth_functions.sql). Hashing and verification happen
 * in PostgreSQL (pgcrypto bcrypt, cost 12) so a login is one atomic call; TypeScript never sees or stores a hash.
 *
 * bcrypt only reads the first 72 BYTES of a password. The database refuses to hash anything longer and never matches a
 * longer input, so the limit is enforced rather than silently truncating.
 */
export const BCRYPT_COST = 12;
export const MAX_PASSWORD_BYTES = 72;
/** Staff passwords (docs/API_SPEC.md §8). Team passwords created by admins use a lower floor in a later patch. */
export const STAFF_PASSWORD_MIN_LENGTH = 10;

export function passwordByteLength(password: string): number {
  return new TextEncoder().encode(password).length;
}

export function isPasswordWithinLimit(password: string): boolean {
  const bytes = passwordByteLength(password);
  return bytes >= 1 && bytes <= MAX_PASSWORD_BYTES;
}

/** Returns a reason when a new staff password is not acceptable, otherwise `null`. */
export function validateStaffPassword(password: string): string | null {
  if (password.length < STAFF_PASSWORD_MIN_LENGTH) {
    return `Use at least ${STAFF_PASSWORD_MIN_LENGTH} characters.`;
  }
  if (passwordByteLength(password) > MAX_PASSWORD_BYTES) {
    return `Use at most ${MAX_PASSWORD_BYTES} bytes (bcrypt limit).`;
  }
  return null;
}
