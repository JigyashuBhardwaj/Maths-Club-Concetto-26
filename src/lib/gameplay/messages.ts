/**
 * What the participant reads when a gameplay call fails. Fixed wording chosen by the error CODE only: nothing the
 * server or the database said is ever shown, so internal text cannot reach the screen.
 */
const TEXT: Record<string, string> = {
  NETWORK_ERROR: "Can't reach the server. Check your connection and try again.",
  BAD_RESPONSE: "Something went wrong on our side. Please try again.",
  SERVICE_UNAVAILABLE: "Something went wrong on our side. Please try again.",
  RATE_LIMITED: "Too many requests. Please wait a moment and try again.",
  COMPETITION_NOT_RUNNING: "The competition is not open right now.",
  COMPETITION_PAUSED: "The competition is paused. Please wait for the organisers.",
  TEAM_NOT_STARTED: "Your team has not entered the competition yet.",
  TEAM_ENDED: "Your team's time has ended.",
  ALREADY_SUBMITTED: "Your team has already made its final submission.",
  THEME_ALREADY_UNLOCKED: "A teammate has just unlocked this theme.",
  THEME_LOCKED: "This theme is not unlocked yet.",
  INSUFFICIENT_COINS: "You don't have enough coins to unlock this theme.",
  QUESTION_NOT_ACTIVE: "That isn't possible while the question is in its current state.",
  QUESTION_NOT_AVAILABLE: "This question can't be started right now.",
  QUESTION_TIMED_OUT: "Time is up for this question.",
  SUBMISSION_PENDING: "Your team's answer is already waiting for review.",
  STALE_DRAFT: "A teammate saved a newer draft.",
  VALIDATION_FAILED: "Check what you entered and try again.",
  FORBIDDEN: "You are not allowed to do that.",
  NOT_FOUND: "That doesn't exist.",
};

export function gameErrorText(code: string): string {
  return TEXT[code] ?? TEXT.BAD_RESPONSE!;
}

/** A failure that says nothing about whether the request reached the server: the same idempotency key may be retried. */
export function isRetryable(code: string): boolean {
  return code === "NETWORK_ERROR" || code === "BAD_RESPONSE" || code === "SERVICE_UNAVAILABLE";
}
