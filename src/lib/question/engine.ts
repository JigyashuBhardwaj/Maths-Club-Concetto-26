/**
 * DEMO ENGINE — a pure, client-side stand-in for the server rules, so the question page can be
 * reviewed before the backend exists. It is NOT authoritative and is replaced by the server
 * functions (`start_question`, `buy_time`, `buy_hint`, `submit_answer`, `approve_submission`, …).
 *
 * It mirrors the locked rules: Q1 goes ACTIVE when entered, later questions go ACTIVE when the
 * previous one is approved, the question timer pauses while PENDING_APPROVAL and resumes on
 * disapproval, Tier 2 needs Tier 1, time and hints can only be bought while ACTIVE, and a question
 * that reaches 0 is TIMED_OUT and blocks the theme.
 *
 * Every function is pure and returns the same object it was given when nothing changed.
 */
import { MOCK_COINS_LEFT, MOCK_TIME_LEFT_SECONDS } from "@/lib/home/mock";
import type { ThemeId } from "@/lib/home/themes";

import {
  BUY_TIME_OPTIONS,
  HINT_COSTS,
  QUESTION_SECONDS,
  QUESTIONS_PER_THEME,
  REWARD_COINS,
} from "./constants";

export type QuestionStatus = "AVAILABLE" | "ACTIVE" | "PENDING_APPROVAL" | "APPROVED" | "TIMED_OUT";
/** LOCKED is derived (the previous question is not approved), never stored. */
export type ViewStatus = QuestionStatus | "LOCKED";

export interface QuestionProgress {
  status: QuestionStatus;
  /** Epoch ms when the timer hits zero; only while ACTIVE. */
  deadline: number | null;
  /** Frozen remaining time while PENDING_APPROVAL / APPROVED / TIMED_OUT. */
  remainingMs: number | null;
  /** The draft in the answer box. */
  answer: string;
  /** What was sent to the admin (kept after approval as the team's own answer). */
  submittedAnswer: string | null;
  /** Hint 1 and Hint 2 owned. */
  hints: [boolean, boolean];
}

export interface DemoState {
  version: 1;
  coins: number;
  unlocked: ThemeId[];
  /** Epoch ms when the team's (ultimate) timer ends. */
  ultimateDeadline: number;
  themes: Partial<Record<ThemeId, QuestionProgress[]>>;
}

export function initialState(now: number): DemoState {
  return {
    version: 1,
    coins: MOCK_COINS_LEFT,
    unlocked: [],
    ultimateDeadline: now + MOCK_TIME_LEFT_SECONDS * 1000,
    themes: {},
  };
}

function freshQuestion(): QuestionProgress {
  return {
    status: "AVAILABLE",
    deadline: null,
    remainingMs: null,
    answer: "",
    submittedAnswer: null,
    hints: [false, false],
  };
}

function freshTheme(): QuestionProgress[] {
  return Array.from({ length: QUESTIONS_PER_THEME }, freshQuestion);
}

const validN = (n: number) => Number.isInteger(n) && n >= 1 && n <= QUESTIONS_PER_THEME;

export function themeProgress(state: DemoState, theme: ThemeId): QuestionProgress[] {
  return state.themes[theme] ?? freshTheme();
}

export function isUnlocked(state: DemoState, theme: ThemeId): boolean {
  return state.unlocked.includes(theme);
}

export function viewStatus(state: DemoState, theme: ThemeId, n: number): ViewStatus {
  if (!validN(n)) return "LOCKED";
  const list = themeProgress(state, theme);
  if (n > 1 && list[n - 2]!.status !== "APPROVED") return "LOCKED";
  return list[n - 1]!.status;
}

/** Question to open from "Let's solve": the first one not yet approved (or the last). */
export function currentQuestionNumber(state: DemoState, theme: ThemeId): number {
  const list = themeProgress(state, theme);
  const idx = list.findIndex((q) => q.status !== "APPROVED");
  return idx === -1 ? QUESTIONS_PER_THEME : idx + 1;
}

export function remainingMs(q: QuestionProgress, now: number): number {
  if (q.status === "ACTIVE" && q.deadline !== null) return Math.max(0, q.deadline - now);
  return Math.max(0, q.remainingMs ?? 0);
}

export function ultimateRemainingSeconds(state: DemoState, now: number): number {
  return Math.max(0, Math.floor((state.ultimateDeadline - now) / 1000));
}

function patch(
  state: DemoState,
  theme: ThemeId,
  n: number,
  change: Partial<QuestionProgress>,
): DemoState {
  const list = [...themeProgress(state, theme)];
  list[n - 1] = { ...list[n - 1]!, ...change };
  return { ...state, themes: { ...state.themes, [theme]: list } };
}

/** An ACTIVE question whose deadline passed becomes TIMED_OUT. */
export function settle(state: DemoState, now: number): DemoState {
  let next = state;
  for (const theme of Object.keys(state.themes) as ThemeId[]) {
    themeProgress(next, theme).forEach((q, i) => {
      if (q.status === "ACTIVE" && q.deadline !== null && now >= q.deadline) {
        next = patch(next, theme, i + 1, { status: "TIMED_OUT", deadline: null, remainingMs: 0 });
      }
    });
  }
  return next;
}

export function unlockTheme(state: DemoState, theme: ThemeId): DemoState {
  // Demo: unlocking is free here — the real unlock deducts the theme's price on the server.
  if (isUnlocked(state, theme)) return state;
  return { ...state, unlocked: [...state.unlocked, theme] };
}

/** Q1 becomes ACTIVE (timer starts) the first time it is entered. Other questions: no-op. */
export function enterQuestion(state: DemoState, theme: ThemeId, n: number, now: number): DemoState {
  if (!isUnlocked(state, theme) || n !== 1) return state;
  if (themeProgress(state, theme)[0]!.status !== "AVAILABLE") return state;
  return patch(state, theme, 1, { status: "ACTIVE", deadline: now + QUESTION_SECONDS * 1000 });
}

function active(state: DemoState, theme: ThemeId, n: number, now: number): QuestionProgress | null {
  if (!isUnlocked(state, theme) || !validN(n) || viewStatus(state, theme, n) !== "ACTIVE")
    return null;
  const q = themeProgress(state, theme)[n - 1]!;
  return q.deadline !== null && q.deadline > now ? q : null;
}

export function setAnswer(
  state: DemoState,
  theme: ThemeId,
  n: number,
  text: string,
  now: number,
): DemoState {
  const q = active(state, theme, n, now);
  if (!q || q.answer === text) return state;
  return patch(state, theme, n, { answer: text });
}

export function clearAnswer(state: DemoState, theme: ThemeId, n: number, now: number): DemoState {
  return setAnswer(state, theme, n, "", now);
}

export function submitAnswer(state: DemoState, theme: ThemeId, n: number, now: number): DemoState {
  const q = active(state, theme, n, now);
  if (!q || q.answer.trim() === "") return state;
  return patch(state, theme, n, {
    status: "PENDING_APPROVAL",
    submittedAnswer: q.answer,
    remainingMs: q.deadline! - now,
    deadline: null,
  });
}

/** Simulated admin approval: reward once, next question ACTIVE with a fresh timer. */
export function approve(state: DemoState, theme: ThemeId, n: number, now: number): DemoState {
  if (
    !isUnlocked(state, theme) ||
    !validN(n) ||
    themeProgress(state, theme)[n - 1]!.status !== "PENDING_APPROVAL"
  )
    return state;
  let next = patch(state, theme, n, { status: "APPROVED" });
  next = { ...next, coins: next.coins + REWARD_COINS };
  if (n < QUESTIONS_PER_THEME) {
    next = patch(next, theme, n + 1, { status: "ACTIVE", deadline: now + QUESTION_SECONDS * 1000 });
  }
  return next;
}

/** Simulated admin rejection: back to ACTIVE, timer resumes, the typed answer is kept so the member can review their mistakes. */
export function disapprove(state: DemoState, theme: ThemeId, n: number, now: number): DemoState {
  if (!isUnlocked(state, theme) || !validN(n)) return state;
  const q = themeProgress(state, theme)[n - 1]!;
  if (q.status !== "PENDING_APPROVAL") return state;
  return patch(state, theme, n, {
    status: "ACTIVE",
    deadline: now + (q.remainingMs ?? 0),
    remainingMs: null,
    submittedAnswer: null,
  });
}

export function canBuyTime(
  state: DemoState,
  theme: ThemeId,
  n: number,
  minutes: number,
  now: number,
): boolean {
  const opt = BUY_TIME_OPTIONS.find((o) => o.minutes === minutes);
  return !!opt && active(state, theme, n, now) !== null && state.coins >= opt.cost;
}

export function buyTime(
  state: DemoState,
  theme: ThemeId,
  n: number,
  minutes: number,
  now: number,
): DemoState {
  if (!canBuyTime(state, theme, n, minutes, now)) return state;
  const opt = BUY_TIME_OPTIONS.find((o) => o.minutes === minutes)!;
  const q = themeProgress(state, theme)[n - 1]!;
  return {
    ...patch(state, theme, n, { deadline: q.deadline! + opt.minutes * 60_000 }),
    coins: state.coins - opt.cost,
  };
}

/** Tier 2 needs Tier 1; both need an ACTIVE question and enough coins; never paid twice. */
export function canBuyHint(
  state: DemoState,
  theme: ThemeId,
  n: number,
  tier: 1 | 2,
  now: number,
): boolean {
  const q = active(state, theme, n, now);
  if (!q || q.hints[tier - 1]) return false;
  if (tier === 2 && !q.hints[0]) return false;
  return state.coins >= HINT_COSTS[tier - 1]!;
}

export function buyHint(
  state: DemoState,
  theme: ThemeId,
  n: number,
  tier: 1 | 2,
  now: number,
): DemoState {
  if (!canBuyHint(state, theme, n, tier, now)) return state;
  const q = themeProgress(state, theme)[n - 1]!;
  const hints: [boolean, boolean] = tier === 1 ? [true, q.hints[1]] : [q.hints[0], true];
  return { ...patch(state, theme, n, { hints }), coins: state.coins - HINT_COSTS[tier - 1]! };
}
