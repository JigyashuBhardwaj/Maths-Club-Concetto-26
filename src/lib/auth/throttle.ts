/**
 * Login throttling is enforced in the database (`auth_throttle`, supabase/migrations/…_auth_functions.sql): 8 failures
 * per account per 10 minutes, then an exponential lock of 30 s, 60 s, 120 s, 240 s and at most 300 s. It is keyed per
 * account ('team:<login id>' / 'staff:<username>'), never by IP, because a campus network shares one address.
 * A success clears the account's counter. This module only holds the documented numbers for tests and docs.
 */
export const THROTTLE_MAX_FAILURES = 8;
export const THROTTLE_WINDOW_SECONDS = 10 * 60;
export const THROTTLE_FIRST_LOCK_SECONDS = 30;
export const THROTTLE_MAX_LOCK_SECONDS = 300;

/** The lock a given number of failures in one window leads to, in seconds (0 below the limit). */
export function lockSecondsForFailures(failures: number): number {
  if (failures < THROTTLE_MAX_FAILURES) return 0;
  const doublings = Math.min(failures - THROTTLE_MAX_FAILURES, 10);
  return Math.min(THROTTLE_MAX_LOCK_SECONDS, THROTTLE_FIRST_LOCK_SECONDS * 2 ** doublings);
}
