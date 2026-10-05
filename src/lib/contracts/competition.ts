/**
 * TYPES ONLY — contract placeholders for later patches. NOTHING here is implemented:
 * no state machine, timers, scoring or persistence exists in this patch.
 * The values mirror the locked product decisions so later backend and UI work agree.
 */

/** Ultimate team timer, in seconds. Server-authoritative; starts at competition entry, not login. */
export const TEAM_TIMER_SECONDS = 14_400;

/**
 * UFM outcomes. Reset: the official score becomes 0 at that moment, the team keeps playing and later
 * points count from 0 (a baseline, not a permanent override). Disqualify: score −1201, team frozen.
 */
export const UFM_RESET_SCORE = 0;
export const UFM_DISQUALIFY_SCORE = -1201;

export type QuestionState =
  "LOCKED" | "AVAILABLE" | "ACTIVE" | "PENDING_APPROVAL" | "APPROVED" | "TIMED_OUT";

/** Review state of a submission (the question itself goes through `PENDING_APPROVAL`). */
export type SubmissionState = "PENDING" | "APPROVED" | "REJECTED";

export type TeamStatus = "NOT_STARTED" | "RUNNING" | "FINAL_SUBMITTED" | "ENDED" | "DISQUALIFIED";
