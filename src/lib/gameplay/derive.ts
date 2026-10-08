/**
 * Pure helpers that turn the authoritative snapshot into what the screen shows (Patch B13). Nothing here decides a
 * game rule: the database owns every state, deadline and balance. These functions only (a) align the browser clock
 * with the server clock and (b) count down toward deadlines the server already sent, so a hidden/throttled tab is
 * always right the moment it wakes (countdowns are recomputed from absolute deadlines, never accumulated).
 */
import type { TeamState } from "@/lib/contracts/runtime";

export type ThemeView = TeamState["themes"][number];
export type QuestionSummary = ThemeView["questions"][number];
export type QuestionState = QuestionSummary["state"];

/** Milliseconds to ADD to the browser clock to get the server clock (measured at the moment a snapshot arrived). */
export function clockOffset(serverNow: number, clientNow: number): number {
  return serverNow - clientNow;
}

/** The estimated server time at the browser time `clientNow`. */
export function serverTime(clientNow: number, offsetMs: number): number {
  return clientNow + offsetMs;
}

/** True while clocks run: the competition is RUNNING and the team is RUNNING (a pause freezes every timer). */
export function clocksRunning(state: TeamState): boolean {
  return state.competition.status === "RUNNING" && state.team.status === "RUNNING";
}

/** Whole seconds left on the TEAM timer. Ticks only while clocks run; otherwise the server's frozen value. */
export function teamRemainingSeconds(state: TeamState, nowServerMs: number): number {
  if (!clocksRunning(state) || state.team.ends_at === null) return state.team.remaining_seconds;
  return Math.min(
    state.team.duration_seconds,
    Math.max(0, Math.floor((state.team.ends_at - nowServerMs) / 1000)),
  );
}

/** Milliseconds left on an ACTIVE question; for a frozen (PENDING_APPROVAL) question the frozen value. */
export function questionRemainingMs(
  q: Pick<QuestionSummary, "state" | "deadline" | "remaining_seconds">,
  state: TeamState,
  nowServerMs: number,
): number {
  if (q.state === "ACTIVE" && q.deadline !== undefined) {
    if (!clocksRunning(state)) return (q.remaining_seconds ?? 0) * 1000;
    return Math.max(0, q.deadline - nowServerMs);
  }
  if (q.state === "PENDING_APPROVAL") return (q.remaining_seconds ?? 0) * 1000;
  return 0;
}

/** An ACTIVE question whose deadline has passed is shown TIMED_OUT at once; the server confirms on the next read. */
export function effectiveState(
  q: Pick<QuestionSummary, "state" | "deadline">,
  state: TeamState,
  nowServerMs: number,
): QuestionState {
  if (
    q.state === "ACTIVE" &&
    q.deadline !== undefined &&
    clocksRunning(state) &&
    nowServerMs >= q.deadline
  ) {
    return "TIMED_OUT";
  }
  return q.state;
}

/** Letter of a theme in a URL (`/participant/theme/B/2`) → the theme in the snapshot. */
export function findTheme(state: TeamState, code: string): ThemeView | undefined {
  return state.themes.find((t) => t.code === code);
}

/** The question the team should work on in a theme: the first one that is not yet APPROVED (or the last one). */
export function currentOrdinal(theme: ThemeView): number {
  const open = theme.questions.find((q) => q.state !== "APPROVED");
  return open?.ordinal ?? theme.questions.at(-1)?.ordinal ?? 1;
}

export const isUnlocked = (theme: ThemeView): boolean => theme.status !== "LOCKED";

/** Which of two snapshots is newer: the database clock decides (equal clocks → the higher version). */
export function isNewer(candidate: TeamState, current: TeamState | null): boolean {
  if (!current) return true;
  if (candidate.server_now !== current.server_now) return candidate.server_now > current.server_now;
  return candidate.state_version >= current.state_version;
}
