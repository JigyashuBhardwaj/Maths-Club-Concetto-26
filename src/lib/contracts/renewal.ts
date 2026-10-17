import { z } from "zod";

import { QUESTIONS_PER_THEME, THEME_IDS } from "./competition";
import { competitionStatusSchema } from "./runtime";

/**
 * Request and result shapes of "Renew the Competition" (migration 21): the Super Admin edits the fixed competition content
 * (10 themes A–J × 5 questions × 2 hints, their rewards, and the rules) and applies it, which in ONE database transaction
 * publishes the content, removes the previous Admins and their Teams and re-opens the lifecycle.
 *
 * The STRUCTURE is not editable: the request schema is strict (no unknown key anywhere, so no id, price, timer or setting can ride
 * along), has exactly 10 themes in order A–J with exactly 5 questions each in order X.1–X.5, and exactly two hints per question
 * (`hint1`, `hint2`). Only texts, rewards and the list of rules are free. The database validates the same rules again
 * (`app.renewal_content_problems`), so this file is a convenience and an early, friendly check, never the authority.
 */

/** Longest accepted texts (characters, i.e. code points). Mirrored in the database; the whole request stays below 4 MiB. */
export const RENEWAL_LIMITS = {
  themeName: 200,
  themeDescription: 1000,
  question: 8000,
  hint: 4000,
  rule: 2000,
  maxRules: 50,
  maxReward: 999_999,
} as const;

/** The request body limit of `POST /api/super/renew` (the worst legal document is ~3.6 MB of UTF-8). */
export const MAX_RENEWAL_BODY_BYTES = 4 * 1024 * 1024;

const codePoints = (s: string): number => [...s].length;
/** Something other than whitespace is in it. */
const visible = (s: string): boolean => /\S/u.test(s);
/**
 * A C0 control character other than TAB, LF and CR (or DEL) cannot be part of a competition text, and neither can an unpaired
 * UTF-16 surrogate: it is not valid Unicode text and PostgreSQL's jsonb refuses it (22P05), which would otherwise surface as a
 * server error instead of a field error. (`for…of` yields a lone surrogate as its own "character" and a valid pair as one.)
 */
function hasStrayControl(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (
      (c <= 0x08 && c >= 0) ||
      c === 0x0b ||
      c === 0x0c ||
      (c >= 0x0e && c <= 0x1f) ||
      c === 0x7f ||
      (c >= 0xd800 && c <= 0xdfff)
    )
      return true;
  }
  return false;
}

/** Why a text is not acceptable, or null. Used by the schema and by the editor, so both say the same thing. */
export function textProblem(value: string, max: number): string | null {
  if (!visible(value)) return "Required.";
  if (codePoints(value) > max) return `At most ${max} characters.`;
  if (hasStrayControl(value)) return "Contains a character that is not allowed.";
  return null;
}

const REWARD_TEXT = /^[1-9][0-9]{0,5}$/;
/** Why a typed reward is not acceptable, or null. */
export function rewardProblem(value: string): string | null {
  return REWARD_TEXT.test(value.trim()) ? null : "A whole number from 1 to 999999.";
}

const text = (max: number) =>
  z.string().superRefine((v, ctx) => {
    const p = textProblem(v, max);
    if (p) ctx.addIssue({ code: "custom", message: p });
  });

const reward = z.number().int().min(1).max(RENEWAL_LIMITS.maxReward);

/** The id of question `n` of theme `code`, e.g. `A.1`. */
export const questionKey = (code: string, n: number): string => `${code}.${n}`;

const questionSchema = z.strictObject({
  id: z.string(),
  question: text(RENEWAL_LIMITS.question),
  hint1: text(RENEWAL_LIMITS.hint),
  hint2: text(RENEWAL_LIMITS.hint),
  reward,
});

const themeSchema = z.strictObject({
  id: z.string(),
  name: text(RENEWAL_LIMITS.themeName),
  description: text(RENEWAL_LIMITS.themeDescription),
  questions: z.array(questionSchema).length(QUESTIONS_PER_THEME),
});

/** The editable content, exactly as it is sent to the server. */
export const renewalContentSchema = z
  .strictObject({
    themes: z.array(themeSchema).length(THEME_IDS.length),
    rules: z.array(text(RENEWAL_LIMITS.rule)).min(1).max(RENEWAL_LIMITS.maxRules),
  })
  .superRefine((c, ctx) => {
    c.themes.forEach((t, i) => {
      const code = THEME_IDS[i];
      if (t.id !== code)
        ctx.addIssue({ code: "custom", path: ["themes", i, "id"], message: "Fixed." });
      t.questions.forEach((q, j) => {
        if (q.id !== questionKey(code!, j + 1))
          ctx.addIssue({
            code: "custom",
            path: ["themes", i, "questions", j, "id"],
            message: "Fixed.",
          });
      });
    });
  });
export type RenewalContent = z.infer<typeof renewalContentSchema>;
export type RenewalTheme = RenewalContent["themes"][number];
export type RenewalQuestion = RenewalTheme["questions"][number];

/** `POST /api/super/renew` */
export const renewRequestSchema = z.strictObject({
  content: renewalContentSchema,
  /** The token of the content the editor loaded (see `get_renewal_content`): a renewal built on stale content is refused. */
  expectedToken: z.string().regex(/^[0-9a-f]{64}$/),
});
export type RenewRequest = z.infer<typeof renewRequestSchema>;

// ---- what the editor receives ------------------------------------------------------------------------------------------------

const BLOCK_REASONS = ["ACTIVE_QUESTION", "TEAM_TIMER_RUNNING"] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

/** Can the competition be renewed right now? (`app.renewal_readiness`) */
export const renewalReadinessSchema = z.object({
  ready: z.boolean(),
  blocked_count: z.number().int().nonnegative(),
  blockers: z.array(
    z.object({
      team_code: z.string(),
      name: z.string(),
      reason: z.enum(BLOCK_REASONS),
    }),
  ),
  admins: z.number().int().nonnegative(),
  teams: z.number().int().nonnegative(),
  pending_submissions: z.number().int().nonnegative(),
  competition_status: competitionStatusSchema,
});
export type RenewalReadiness = z.infer<typeof renewalReadinessSchema>;

const snapshotQuestion = z.object({
  id: z.string(),
  question: z.string(),
  hint1: z.string(),
  hint2: z.string(),
  reward: z.number().int().nonnegative(),
});
const snapshotTheme = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  questions: z.array(snapshotQuestion).length(QUESTIONS_PER_THEME),
});

/** The database's answer: `rules` is null until the first renewal (the built-in official rules are then in force). */
export const renewalReadDbSchema = z.object({
  content: z.object({
    themes: z.array(snapshotTheme).length(THEME_IDS.length),
    rules: z.array(z.string()).nullable(),
  }),
  token: z.string().regex(/^[0-9a-f]{64}$/),
  readiness: renewalReadinessSchema,
});

/** `GET /api/super/renew`: the content as the editor shows it (rules resolved), its concurrency token, and the readiness. */
export const renewalReadSchema = z.object({
  content: z.object({
    themes: z.array(snapshotTheme).length(THEME_IDS.length),
    rules: z.array(z.string()),
  }),
  token: z.string().regex(/^[0-9a-f]{64}$/),
  readiness: renewalReadinessSchema,
});
export type RenewalRead = z.infer<typeof renewalReadSchema>;
export type RenewalSnapshotContent = RenewalRead["content"];

/** `renew_competition` result. */
export const renewResultSchema = z.object({
  replayed: z.boolean(),
  deleted: z.object({
    admins: z.number().int().nonnegative(),
    teams: z.number().int().nonnegative(),
  }),
  /** Submissions that were still awaiting approval and went with their teams (counted in the same transaction). */
  discarded: z.object({ pending_submissions: z.number().int().nonnegative() }),
  changed: z.object({
    themes: z.number().int().nonnegative(),
    questions: z.number().int().nonnegative(),
    hints: z.number().int().nonnegative(),
  }),
  competition: z.object({ from: competitionStatusSchema, to: competitionStatusSchema }),
  token: z.string().regex(/^[0-9a-f]{64}$/),
});
export type RenewResult = z.infer<typeof renewResultSchema>;

// ---- the editor's draft ------------------------------------------------------------------------------------------------------

/** What the editor holds: like the content, but a reward is the text being typed. */
export interface DraftQuestion {
  id: string;
  question: string;
  hint1: string;
  hint2: string;
  reward: string;
}
export interface DraftTheme {
  id: string;
  name: string;
  description: string;
  questions: DraftQuestion[];
}
export interface Draft {
  themes: DraftTheme[];
  rules: string[];
}

/** Field paths used for error messages: `themes.A.name`, `questions.A.1.reward`, `rules.3`, `rules`. Same names as the database. */
export type Problems = Record<string, string>;

/** Every problem of a draft, by field path. Empty = the draft can be sent. (The server and the database check it again.) */
export function draftProblems(d: Draft): Problems {
  const out: Problems = {};
  d.themes.forEach((t, i) => {
    const code = THEME_IDS[i]!;
    const n = textProblem(t.name, RENEWAL_LIMITS.themeName);
    if (n) out[`themes.${code}.name`] = n;
    const desc = textProblem(t.description, RENEWAL_LIMITS.themeDescription);
    if (desc) out[`themes.${code}.description`] = desc;
    t.questions.forEach((q, j) => {
      const id = questionKey(code, j + 1);
      const a = textProblem(q.question, RENEWAL_LIMITS.question);
      if (a) out[`questions.${id}.question`] = a;
      const h1 = textProblem(q.hint1, RENEWAL_LIMITS.hint);
      if (h1) out[`questions.${id}.hint1`] = h1;
      const h2 = textProblem(q.hint2, RENEWAL_LIMITS.hint);
      if (h2) out[`questions.${id}.hint2`] = h2;
      const r = rewardProblem(q.reward);
      if (r) out[`questions.${id}.reward`] = r;
    });
  });
  if (d.rules.length < 1) out["rules"] = "Add at least one rule.";
  else if (d.rules.length > RENEWAL_LIMITS.maxRules)
    out["rules"] = `At most ${RENEWAL_LIMITS.maxRules} rules.`;
  d.rules.forEach((r, i) => {
    const p = textProblem(r, RENEWAL_LIMITS.rule);
    if (p) out[`rules.${i + 1}`] = p;
  });
  return out;
}

/** The draft as the content the server takes (rewards parsed). Call only when `draftProblems` is empty. */
export function draftToContent(d: Draft): RenewalContent {
  return {
    themes: d.themes.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      questions: t.questions.map((q) => ({
        id: q.id,
        question: q.question,
        hint1: q.hint1,
        hint2: q.hint2,
        reward: Number(q.reward.trim()),
      })),
    })),
    rules: [...d.rules],
  };
}

/** The loaded content as a draft (rewards become the text a person edits). */
export function contentToDraft(c: RenewalSnapshotContent): Draft {
  return {
    themes: c.themes.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      questions: t.questions.map((q) => ({
        id: q.id,
        question: q.question,
        hint1: q.hint1,
        hint2: q.hint2,
        reward: String(q.reward),
      })),
    })),
    rules: [...c.rules],
  };
}

/** Plain-language names of the reasons a team stops a renewal. */
export const BLOCK_REASON_TEXT: Record<BlockReason, string> = {
  ACTIVE_QUESTION: "is solving a question right now",
  TEAM_TIMER_RUNNING: "still has its competition timer running and has not submitted",
};
