import type { ApiResult } from "./client";

/**
 * What a person sees when a sign-in attempt fails. The wording is fixed here: nothing the server sends (beyond a
 * numeric retry delay) is ever rendered, so a database message, a stack or an account detail cannot reach the page.
 * A wrong team, password or admission number, an inactive staff account and an unknown username are all the same
 * answer on purpose (the API does not reveal which part was wrong).
 */
export const INVALID_CREDENTIALS_TEXT =
  "Those details don't match an account. Check them and try again.";

type Failure = Extract<ApiResult<unknown>, { ok: false }>;

export function loginFailureMessage(failure: Failure, role: "participant" | "staff"): string {
  switch (failure.code) {
    case "UNAUTHENTICATED":
      return INVALID_CREDENTIALS_TEXT;
    case "RATE_LIMITED": {
      const wait = failure.details?.retry_after_seconds;
      return typeof wait === "number" && Number.isFinite(wait) && wait > 0
        ? `Too many attempts. Please wait ${Math.ceil(wait)} seconds and try again.`
        : "Too many attempts. Please wait a little and try again.";
    }
    case "COMPETITION_NOT_RUNNING":
      return role === "participant"
        ? "The competition isn't open for sign-in right now. Please wait for the organisers' signal."
        : "The competition isn't open right now.";
    case "VALIDATION_FAILED":
      return "Please check the details you entered and try again.";
    case "FORBIDDEN":
      return "This request was blocked. Reload the page and try again.";
    case "NETWORK_ERROR":
      return "Couldn't reach the server. Check your connection and try again.";
    default:
      return "Sign-in is temporarily unavailable. Please try again in a moment.";
  }
}
