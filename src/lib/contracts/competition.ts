/**
 * CONTRACT PLACEHOLDERS (types and fixed constants only) for later patches. NOTHING here is implemented:
 * no state machine, timers, scoring or persistence exists in this patch.
 * The values mirror the locked product decisions so later backend and UI work agree.
 */

/**
 * Ultimate Team Timer (locked): 2 hours = 7,200 s = 120 min. Server/database-authoritative; starts when the first
 * member actually enters the competition (not at login). Scoring minutes = 120 − floor(remaining_seconds / 60),
 * clamped to 0–120. The database enforces the same value (`competition_ultimate_locked_7200`).
 */
export const TEAM_TIMER_SECONDS = 7_200;
export const TEAM_TIMER_MINUTES = TEAM_TIMER_SECONDS / 60;

/** Every team starts with 500 Maths Coins (team-wide; the ledger is authoritative). */
export const INITIAL_COINS = 500;

/** UFM floor: a reset-adjusted score never goes below −1200; a disqualified team is pinned at −1201. */
export const UFM_RESET_FLOOR_SCORE = -1200;

/**
 * UFM outcomes. Reset: the official score becomes 0 at that moment, the team keeps playing and later
 * points count from 0 (a baseline, not a permanent override). Disqualify: score −1201, team frozen.
 */
export const UFM_RESET_SCORE = 0;
export const UFM_DISQUALIFY_SCORE = -1201;

/**
 * Competition shape (locked): 10 themes A–J × 5 questions = 50 questions, plus one Final Submit
 * ticket = 11 tickets. Themes K and L do not exist. Everything else (UI, routes, tests, later the
 * seed script and database checks) derives from these constants.
 */
export const THEME_IDS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export const QUESTIONS_PER_THEME = 5;
export const THEME_COUNT = THEME_IDS.length;
export const TOTAL_QUESTIONS = THEME_COUNT * QUESTIONS_PER_THEME;
/** One ticket per theme plus the Final Submit ticket (always last). */
export const TOTAL_TICKETS = THEME_COUNT + 1;

export type QuestionState =
  "LOCKED" | "AVAILABLE" | "ACTIVE" | "PENDING_APPROVAL" | "APPROVED" | "TIMED_OUT";

/** Review state of a submission (the question itself goes through `PENDING_APPROVAL`). */
export type SubmissionState = "PENDING" | "APPROVED" | "REJECTED";

export type TeamStatus = "NOT_STARTED" | "RUNNING" | "FINAL_SUBMITTED" | "ENDED" | "DISQUALIFIED";
