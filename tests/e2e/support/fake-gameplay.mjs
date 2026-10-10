// The gameplay functions of migration 14 for the in-memory backend (fake-postgrest.mjs), used ONLY by the Playwright
// suite: unlock_theme, start_question, get_question_for_team, save_draft, submit_answer, approve_submission,
// disapprove_submission, start_team_competition and get_team_state, the B14 reads admin_matrix and admin_team_theme
// (migration 15), and the B15 operations buy_hint, buy_time, final_submit, finalize_team_if_due and expire_due_teams
// (migrations 16 and 17).
//
// It mirrors the SQL rule for rule (the same gates in the same order, the same error codes and details, the same result
// shapes, the same idempotency scopes) so the browser tests exercise the real Next.js routes and the real UI against
// the same behaviour. The SQL itself is proven by supabase/tests/100_gameplay.test.sql and
// supabase/tests/concurrency/team_play.concurrency.mjs. The browser specs themselves run against this mirror only (see
// docs/GAMEPLAY.md), so a rule changed in the SQL must be changed here too. Deviations kept deliberately small: the competition status is per team (the test
// control endpoint sets it, the SQL has one global status); a rejected request never mutates, so "settle" runs only
// after the gates pass, which is what a rolled-back transaction guarantees in the SQL.
//
// The content below is invented for the tests. `referenceAnswer` exists ONLY so a test can prove it never reaches a
// participant: no function here ever returns it.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DURATION_S = 14_400; // what a team starting now is given (competition.ultimate_seconds)
// B15 fixtures: invented prices and packs. The application reads every one of them from the server; a spec that
// asserts a number takes it from here.
export const HINT_COST = { 1: 20, 2: 40 };
export const TIME_PACKS = [
  { n: 1, seconds: 120, cost: 20, max: null },
  { n: 2, seconds: 240, cost: 40, max: null },
  { n: 3, seconds: 480, cost: 80, max: 2 },
];
const THEME_CODES = "ABCDEFGHIJ";
const DIFFICULTY = [
  "EASY",
  "EASY",
  "EASY",
  "MEDIUM",
  "MEDIUM",
  "MEDIUM",
  "MEDIUM",
  "HARD",
  "HARD",
  "HARD",
];
const UNLOCK_COST = 100;
const TIME_LIMIT_S = 240;
export const SECRET_PREFIX = "E2E-SECRET-ANSWER";

// The fake serves the OFFICIAL competition content (names, descriptions, questions, hints and per-question rewards) from
// the one source of truth, so the browser tests exercise exactly what a team will read. Mechanics (prices, timers) stay
// the fake's own.
const OFFICIAL = JSON.parse(
  readFileSync(join(process.cwd(), "content/concetto26/official-content.json"), "utf8"),
);
const officialTheme = (code) => OFFICIAL.themes.find((t) => t.id === code);
const officialQuestion = (code, ordinal) =>
  OFFICIAL.questions.find((q) => q.id === `${code}.${ordinal}`);

export const THEMES = [...THEME_CODES].map((code, i) => ({
  id: i + 1,
  code,
  name: officialTheme(code).name,
  description: officialTheme(code).description,
  topics: ["algebra", "geometry"],
  difficulty: DIFFICULTY[i],
  unlock_cost: UNLOCK_COST,
}));
export const QUESTIONS = THEMES.flatMap((t) =>
  [1, 2, 3, 4, 5].map((ordinal) => ({
    id: (t.id - 1) * 5 + ordinal,
    themeId: t.id,
    ordinal,
    body: officialQuestion(t.code, ordinal).question,
    hints: [officialQuestion(t.code, ordinal).hint1, officialQuestion(t.code, ordinal).hint2],
    reward: officialQuestion(t.code, ordinal).reward,
    timeLimit: TIME_LIMIT_S,
    referenceAnswer: `${SECRET_PREFIX}-${t.code}${ordinal}`,
  })),
);

/** @param {{ sessions: Map<string, any>, teams: Map<string, any>, staffById: (id: string) => any, now: () => number, AppError: typeof Error,
 *            idemLookup: Function, idemStore: Function, audit: any[] }} deps */
export function createGameplay({
  teams,
  staffById,
  now: baseNow,
  AppError,
  idemLookup,
  idemStore,
  audit,
  sessions,
}) {
  /** The engine clock: real time plus whatever the test control moved it forward (deadlines are absolute). */
  let skew = 0;
  const now = () => baseNow() + skew;
  const fail = (code, details) => new AppError(code, details);
  const teamList = () => [...teams.values()];
  const teamById = (id) => teamList().find((t) => t.id === id);
  const game = (t) =>
    (t.game ??= {
      coins: 500,
      version: 0,
      startedAt: null,
      endsAt: null,
      timerSeconds: null, // the per-team allowance snapshot (teams.timer_seconds)
      endedAt: null,
      finalSubmittedAt: null,
      final: null, // B16: the gameplay score frozen at the terminal moment (teams.final_*)
      hints: new Set(), // "questionId:tier" the team owns
      ledger: [], // { type, amount, qid } of the spends this module made
      pausedAt: null,
      themes: new Map(), // themeId -> { by, at, paid }
      questions: new Map(), // questionId -> { state, deadline, remaining, activatedAt, approvedAt, timedOutAt }
      drafts: new Map(), // questionId -> { answer, explanation, version, by, at }
      submissions: [], // { id, qid, memberId, answer, explanation, status, at, reviewedAt, note, reward, reviewer }
    });
  const bump = (g) => {
    g.version += 1;
  };

  // ---- clocks (the SQL's app.team_clock / app.question_clock) ---------------------------------------------------
  const teamClock = (t, n) => {
    const g = game(t);
    let ref = n;
    if (g.endedAt !== null) ref = Math.min(ref, g.endedAt);
    if (t.competition === "PAUSED" && g.pausedAt !== null) ref = Math.min(ref, g.pausedAt);
    return ref;
  };
  const questionClock = (t, n) => {
    const g = game(t);
    const ref = teamClock(t, n);
    return g.endsAt === null ? ref : Math.min(ref, g.endsAt);
  };
  const effState = (t, q, n) =>
    q.state === "ACTIVE" && q.deadline <= questionClock(t, n) ? "TIMED_OUT" : q.state;

  /** ACTIVE questions past their deadline become TIMED_OUT (called only after the gates pass). */
  function settle(t, n) {
    const g = game(t);
    let changed = 0;
    for (const [qid, q] of g.questions) {
      if (q.state === "ACTIVE" && q.deadline <= questionClock(t, n)) {
        q.state = "TIMED_OUT";
        q.timedOutAt = q.deadline;
        q.deadline = null;
        changed += 1;
        audit.push({ type: "QUESTION_TIMED_OUT", teamId: t.id, entityId: String(qid) });
      }
    }
    if (changed) bump(g);
    return changed;
  }

  function assertMember(teamId, memberId) {
    const t = teamById(teamId);
    const m = t?.members.find((x) => x.id === memberId);
    if (!t || !m) throw fail("FORBIDDEN");
    return { t, m };
  }
  function assertPlayable(t, n) {
    const g = game(t);
    if (t.competition === "SETUP" || t.competition === "ENDED")
      throw fail("COMPETITION_NOT_RUNNING");
    if (t.competition === "PAUSED") throw fail("COMPETITION_PAUSED");
    if (t.status === "NOT_STARTED") throw fail("TEAM_NOT_STARTED");
    if (t.status === "FINAL_SUBMITTED") throw fail("ALREADY_SUBMITTED");
    if (t.status !== "RUNNING" || n >= g.endsAt) throw fail("TEAM_ENDED");
  }

  // ---- read models ---------------------------------------------------------------------------------------------
  function teamState(t, m, n) {
    const g = game(t);
    const ref = teamClock(t, n);
    const qref = questionClock(t, n);
    const duration = g.timerSeconds ?? DURATION_S;
    const remaining =
      g.endsAt === null ? duration : Math.max(0, Math.floor((g.endsAt - ref) / 1000));
    const expired = t.status === "RUNNING" && g.endsAt !== null && ref >= g.endsAt;
    return {
      server_now: n,
      state_version: g.version,
      competition: { status: t.competition },
      me: { member_id: m.id, slot: m.slot, team_id: t.id, team_code: t.code, team_name: t.name },
      team: {
        status: t.status,
        coins: g.coins,
        started_at: g.startedAt,
        ends_at: g.endsAt,
        ended_at: g.endedAt,
        final_submitted_at: g.finalSubmittedAt,
        duration_seconds: duration,
        remaining_seconds: remaining,
        expired,
        frozen: ["FINAL_SUBMITTED", "ENDED", "DISQUALIFIED"].includes(t.status) || expired,
      },
      themes: THEMES.map((th) => {
        const unlocked = g.themes.has(th.id);
        const qs = QUESTIONS.filter((q) => q.themeId === th.id)
          .filter((q) => g.questions.has(q.id))
          .map((q) => {
            const row = g.questions.get(q.id);
            const state = effState(t, row, n);
            return {
              id: q.id,
              ordinal: q.ordinal,
              state,
              ...(state === "LOCKED"
                ? {}
                : { reward_coins: q.reward, time_limit_seconds: q.timeLimit }),
              ...(row.state === "ACTIVE" && state === "ACTIVE"
                ? {
                    deadline: row.deadline,
                    remaining_seconds: Math.max(0, Math.floor((row.deadline - qref) / 1000)),
                  }
                : state === "PENDING_APPROVAL"
                  ? { remaining_seconds: row.remaining }
                  : {}),
            };
          });
        const timedOut = qs.some((q) => q.state === "TIMED_OUT");
        const completed = qs.length === 5 && qs.every((q) => q.state === "APPROVED");
        return {
          id: th.id,
          code: th.code,
          name: th.name,
          description: th.description,
          topics: th.topics,
          difficulty: th.difficulty,
          unlock_cost: th.unlock_cost,
          status: !unlocked
            ? "LOCKED"
            : timedOut
              ? "FAILED"
              : completed
                ? "COMPLETED"
                : "IN_PROGRESS",
          questions: qs,
        };
      }),
    };
  }

  const hintBody = (qq, tier) => qq.hints[tier - 1];
  const optionId = (qid, n) => (qid - 1) * 3 + n;

  const slotOf = (t, memberId) => t.members.find((x) => x.id === memberId)?.slot ?? null;

  function questionJson(t, qid, n) {
    const g = game(t);
    const qq = QUESTIONS.find((q) => q.id === qid);
    if (!qq) throw fail("NOT_FOUND");
    const row = g.questions.get(qid);
    if (!row) throw fail(g.themes.has(qq.themeId) ? "NOT_FOUND" : "THEME_LOCKED");
    const state = effState(t, row, n);
    if (state === "LOCKED") throw fail("QUESTION_NOT_ACTIVE");
    const out = {
      id: qq.id,
      theme_id: qq.themeId,
      theme_code: THEMES[qq.themeId - 1].code,
      ordinal: qq.ordinal,
      state,
      reward_coins: qq.reward,
      time_limit_seconds: qq.timeLimit,
    };
    const canSpend = t.competition === "RUNNING" && t.status === "RUNNING" && n < g.endsAt;
    const owns = (tier) => g.hints.has(`${qq.id}:${tier}`);
    out.hints = [1, 2].map((tier) => ({
      tier,
      cost: HINT_COST[tier],
      owned: owns(tier),
      purchasable:
        canSpend &&
        ["ACTIVE", "PENDING_APPROVAL", "APPROVED"].includes(state) &&
        !owns(tier) &&
        (tier === 1 || owns(1)),
      ...(owns(tier) ? { body_md: hintBody(qq, tier) } : {}),
    }));
    out.buy_time = {
      purchase_count: row.timeCount ?? 0,
      extra_seconds: row.extra ?? 0,
      can_buy: canSpend && state === "ACTIVE",
      options:
        state === "ACTIVE"
          ? TIME_PACKS.map((p) => {
              const used = row.bought?.get(p.n) ?? 0;
              return {
                id: optionId(qq.id, p.n),
                seconds: p.seconds,
                cost: p.cost,
                max_purchases: p.max,
                purchased: used,
                remaining_purchases: p.max === null ? null : Math.max(p.max - used, 0),
              };
            })
          : [],
    };
    if (state === "AVAILABLE") return out; // metadata only: the body is withheld until the team enters
    out.body_md = qq.body;
    if (state === "ACTIVE") {
      out.deadline = row.deadline;
      out.remaining_seconds = Math.max(0, Math.floor((row.deadline - questionClock(t, n)) / 1000));
    } else if (state === "PENDING_APPROVAL") out.remaining_seconds = row.remaining;
    const d = g.drafts.get(qid);
    out.draft = {
      answer: d?.answer ?? "",
      explanation: d?.explanation ?? "",
      version: d?.version ?? 0,
      updated_by_slot: d ? slotOf(t, d.by) : null,
      updated_at: d?.at ?? null,
    };
    const live = g.submissions
      .filter((s) => s.qid === qid && (s.status === "PENDING" || s.status === "APPROVED"))
      .sort((a, b) => b.at - a.at)[0];
    if (live) {
      out.submission = {
        id: live.id,
        status: live.status,
        answer: live.answer,
        explanation: live.explanation,
        submitted_by_slot: slotOf(t, live.memberId),
        submitted_at: live.at,
        reviewed_at: live.reviewedAt,
        review_note: live.note,
        reward_awarded: live.reward,
      };
    }
    if (state === "ACTIVE") {
      const rej = g.submissions
        .filter((s) => s.qid === qid && s.status === "REJECTED")
        .sort((a, b) => b.reviewedAt - a.reviewedAt)[0];
      if (rej) out.last_rejection = { note: rej.note, reviewed_at: rej.reviewedAt };
    }
    return out;
  }

  // ---- B16 scoring (the SQL's app.team_scores / app.freeze_final_score; keep the two in step) --------------------------
  const SCORE = { theme: 500, question: 100, minute: 5 };
  const TERMINAL = ["FINAL_SUBMITTED", "ENDED", "DISQUALIFIED"];
  /** score = completed x 500 + solved x 100 + coins - minutes x 5; minutes = round((allowance - remaining) / 60), half up. */
  function scoreParts(t, n) {
    const g = game(t);
    if (g.final) return { ...g.final, frozen: true };
    let solved = 0;
    let completed = 0;
    for (const th of THEMES) {
      const approved = QUESTIONS.filter(
        (q) => q.themeId === th.id && g.questions.get(q.id)?.state === "APPROVED",
      ).length;
      solved += approved;
      if (approved === 5) completed += 1;
    }
    let minutes = 0;
    if (g.startedAt !== null) {
      const allowance = g.timerSeconds ?? DURATION_S;
      const remaining = Math.max(0, Math.min(allowance, (g.endsAt - teamClock(t, n)) / 1000));
      minutes = Math.floor((allowance - remaining) / 60 + 0.5);
    }
    const score =
      completed * SCORE.theme + solved * SCORE.question + g.coins - minutes * SCORE.minute;
    return { completed, solved, minutes, score, frozen: false };
  }
  /** Writes the gameplay score once, for a terminal team (the SQL's freeze_final_score). */
  function freeze(t, n) {
    const g = game(t);
    if (g.final || !TERMINAL.includes(t.status)) return;
    const { completed, solved, minutes, score } = scoreParts(t, n);
    g.final = { completed, solved, minutes, score };
  }
  const officialScore = (t, n) => (t.ufmPenalizedAt ? 0 : scoreParts(t, n).score);
  /** app.leaderboard_rows: started teams first, then score desc, minutes asc, Team ID asc (code point). */
  function leaderboardRows(n) {
    return teamList()
      .map((t) => ({ t, score: officialScore(t, n), minutes: scoreParts(t, n).minutes }))
      .sort(
        (x, y) =>
          Number(x.t.status === "NOT_STARTED") - Number(y.t.status === "NOT_STARTED") ||
          y.score - x.score ||
          x.minutes - y.minutes ||
          (x.t.code < y.t.code ? -1 : x.t.code > y.t.code ? 1 : 0),
      )
      .map((x, i) => ({ rank: i + 1, team_id: x.t.code, score: x.score, id: x.t.id }));
  }

  /** finalize_team_if_due / expire_due_teams: RUNNING -> ENDED at the team's own end, only while the competition runs. */
  function finalizeIfDue(t, n) {
    const g = game(t);
    if (t.competition !== "RUNNING" || t.status !== "RUNNING" || g.endsAt === null || n < g.endsAt)
      return false;
    for (const q of g.questions.values()) {
      if (q.state === "ACTIVE" && q.deadline <= g.endsAt) {
        q.state = "TIMED_OUT";
        q.timedOutAt = q.deadline;
        q.deadline = null;
      }
    }
    t.status = "ENDED";
    g.endedAt = g.endsAt;
    freeze(t, n);
    bump(g);
    audit.push({ type: "TEAM_ENDED", teamId: t.id });
    return true;
  }

  const fp = (...parts) => parts.join("|");
  const needKey = (k) => {
    if (typeof k !== "string" || k === "")
      throw fail("VALIDATION_FAILED", { fields: ["idempotencyKey"] });
  };

  const fns = {
    start_team_competition(a) {
      const { t, m } = assertMember(a.p_team_id, a.p_member_id);
      needKey(a.p_idem_key);
      const f = fp("member", m.id);
      const replay = idemLookup(t.id, a.p_idem_key, "start_team_competition", f);
      if (replay) return { ...replay, replayed: true };
      const n = now();
      if (t.competition === "SETUP" || t.competition === "ENDED")
        throw fail("COMPETITION_NOT_RUNNING");
      if (t.competition === "PAUSED") throw fail("COMPETITION_PAUSED");
      const g = game(t);
      let started = false;
      if (t.status === "NOT_STARTED") {
        t.status = "RUNNING";
        g.startedAt = n;
        g.timerSeconds = DURATION_S;
        g.endsAt = n + DURATION_S * 1000;
        bump(g);
        started = true;
        audit.push({ type: "TEAM_STARTED", teamId: t.id, memberId: m.id });
      }
      const res = { replayed: false, started_now: started, state: teamState(t, m, n) };
      idemStore(t.id, a.p_idem_key, "start_team_competition", f, res);
      return res;
    },

    get_team_state(a) {
      const { t, m } = assertMember(a.p_team_id, a.p_member_id);
      return teamState(t, m, now());
    },

    unlock_theme(a) {
      const { t, m } = assertMember(a.p_team_id, a.p_member_id);
      needKey(a.p_idem_key);
      const f = fp("theme", a.p_theme_id, "member", m.id);
      const replay = idemLookup(t.id, a.p_idem_key, "unlock_theme", f);
      if (replay) return { ...replay, replayed: true };
      const n = now();
      assertPlayable(t, n);
      const g = game(t);
      const th = THEMES.find((x) => x.id === Number(a.p_theme_id));
      if (!th) throw fail("NOT_FOUND");
      if (g.themes.has(th.id)) throw fail("THEME_ALREADY_UNLOCKED");
      if (g.coins < th.unlock_cost)
        throw fail("INSUFFICIENT_COINS", { have: g.coins, need: th.unlock_cost });
      settle(t, n);
      g.coins -= th.unlock_cost;
      g.themes.set(th.id, { by: m.id, at: n, paid: th.unlock_cost });
      for (const q of QUESTIONS.filter((x) => x.themeId === th.id)) {
        g.questions.set(q.id, {
          state: q.ordinal === 1 ? "AVAILABLE" : "LOCKED",
          deadline: null,
          remaining: null,
          activatedAt: null,
          approvedAt: null,
          timedOutAt: null,
          timeCount: 0,
          extra: 0,
          bought: new Map(), // pack number -> purchases
        });
      }
      bump(g);
      audit.push({ type: "THEME_UNLOCKED", teamId: t.id, entityId: String(th.id) });
      const res = { replayed: false, theme_id: th.id, state: teamState(t, m, n) };
      idemStore(t.id, a.p_idem_key, "unlock_theme", f, res);
      return res;
    },

    start_question(a) {
      const { t, m } = assertMember(a.p_team_id, a.p_member_id);
      needKey(a.p_idem_key);
      const f = fp("question", a.p_question_id, "member", m.id);
      const replay = idemLookup(t.id, a.p_idem_key, "start_question", f);
      if (replay) return { ...replay, replayed: true };
      const n = now();
      assertPlayable(t, n);
      settle(t, n);
      const g = game(t);
      const qq = QUESTIONS.find((x) => x.id === Number(a.p_question_id));
      if (!qq) throw fail("NOT_FOUND");
      const row = g.questions.get(qq.id);
      if (!row) throw fail("THEME_LOCKED");
      let started = false;
      if (row.state === "AVAILABLE") {
        row.state = "ACTIVE";
        row.activatedAt = n;
        row.deadline = n + qq.timeLimit * 1000;
        bump(g);
        started = true;
        audit.push({ type: "QUESTION_STARTED", teamId: t.id, entityId: String(qq.id) });
      } else if (row.state === "LOCKED" || row.state === "TIMED_OUT") {
        throw fail("QUESTION_NOT_AVAILABLE");
      }
      const res = { replayed: false, started_now: started, question: questionJson(t, qq.id, n) };
      idemStore(t.id, a.p_idem_key, "start_question", f, res);
      return res;
    },

    get_question_for_team(a) {
      const { t } = assertMember(a.p_team_id, a.p_member_id);
      const n = now();
      return {
        server_now: n,
        state_version: game(t).version,
        question: questionJson(t, Number(a.p_question_id), n),
      };
    },

    save_draft(a) {
      const { t, m } = assertMember(a.p_team_id, a.p_member_id);
      const fields = [];
      const answer = a.p_answer;
      const explanation = a.p_explanation ?? "";
      if (typeof answer !== "string" || [...answer].length > 10000) fields.push("answer");
      if (typeof explanation !== "string" || [...explanation].length > 10000)
        fields.push("explanation");
      if (!Number.isInteger(a.p_expected_version) || a.p_expected_version < 0)
        fields.push("expectedVersion");
      if (fields.length) throw fail("VALIDATION_FAILED", { fields });
      const n = now();
      assertPlayable(t, n);
      const g = game(t);
      const qq = QUESTIONS.find((x) => x.id === Number(a.p_question_id));
      if (!qq) throw fail("NOT_FOUND");
      const row = g.questions.get(qq.id);
      if (!row) throw fail("THEME_LOCKED");
      const state = effState(t, row, n);
      if (state === "TIMED_OUT") throw fail("QUESTION_TIMED_OUT");
      if (state !== "ACTIVE") throw fail("QUESTION_NOT_ACTIVE");
      settle(t, n);
      const d = g.drafts.get(qq.id);
      if (!d) {
        if (a.p_expected_version !== 0) throw fail("STALE_DRAFT", { version: 0 });
        g.drafts.set(qq.id, { answer, explanation, version: 1, by: m.id, at: n });
      } else if (d.version !== a.p_expected_version) {
        if (d.answer === answer && d.explanation === explanation) {
          return { version: d.version, updated_by_slot: slotOf(t, d.by), updated_at: d.at };
        }
        throw fail("STALE_DRAFT", { version: d.version });
      } else {
        Object.assign(d, { answer, explanation, version: d.version + 1, by: m.id, at: n });
      }
      const out = g.drafts.get(qq.id);
      return { version: out.version, updated_by_slot: slotOf(t, out.by), updated_at: out.at };
    },

    submit_answer(a) {
      const { t, m } = assertMember(a.p_team_id, a.p_member_id);
      needKey(a.p_idem_key);
      const fields = [];
      if (
        typeof a.p_answer !== "string" ||
        a.p_answer.trim() === "" ||
        [...a.p_answer].length > 10000
      )
        fields.push("answer");
      if (typeof a.p_explanation !== "string" || [...a.p_explanation].length > 10000)
        fields.push("explanation");
      if (fields.length) throw fail("VALIDATION_FAILED", { fields });
      const f = fp(
        "question",
        a.p_question_id,
        "member",
        m.id,
        "text",
        a.p_answer,
        a.p_explanation,
      );
      const replay = idemLookup(t.id, a.p_idem_key, "submit_answer", f);
      if (replay) return { ...replay, replayed: true };
      const n = now();
      assertPlayable(t, n);
      settle(t, n);
      const g = game(t);
      const qq = QUESTIONS.find((x) => x.id === Number(a.p_question_id));
      if (!qq) throw fail("NOT_FOUND");
      const row = g.questions.get(qq.id);
      if (!row) throw fail("THEME_LOCKED");
      if (row.state === "PENDING_APPROVAL") throw fail("SUBMISSION_PENDING");
      if (row.state === "TIMED_OUT") throw fail("QUESTION_TIMED_OUT");
      if (row.state !== "ACTIVE") throw fail("QUESTION_NOT_ACTIVE");
      const id = randomUUID();
      g.submissions.push({
        id,
        qid: qq.id,
        memberId: m.id,
        answer: a.p_answer,
        explanation: a.p_explanation,
        status: "PENDING",
        at: n,
        reviewedAt: null,
        note: null,
        reward: null,
        reviewer: null,
      });
      row.remaining = Math.max(0, Math.floor((row.deadline - n) / 1000));
      row.state = "PENDING_APPROVAL";
      row.deadline = null;
      const d = g.drafts.get(qq.id);
      g.drafts.set(qq.id, {
        answer: a.p_answer,
        explanation: a.p_explanation,
        version: (d?.version ?? 0) + 1,
        by: m.id,
        at: n,
      });
      bump(g);
      audit.push({ type: "ANSWER_SUBMITTED", teamId: t.id, entityId: id });
      const res = { replayed: false, question: questionJson(t, qq.id, n) };
      idemStore(t.id, a.p_idem_key, "submit_answer", f, res);
      return res;
    },

    buy_hint(a) {
      const { t, m } = assertMember(a.p_team_id, a.p_member_id);
      needKey(a.p_idem_key);
      if (!Number.isInteger(a.p_question_id) || ![1, 2].includes(a.p_tier))
        throw fail("VALIDATION_FAILED", { fields: ["tier"] });
      const f = fp("question", a.p_question_id, "tier", a.p_tier, "member", m.id);
      const replay = idemLookup(t.id, a.p_idem_key, "buy_hint", f);
      if (replay) return { ...replay, replayed: true };
      const n = now();
      assertPlayable(t, n);
      const g = game(t);
      const qq = QUESTIONS.find((x) => x.id === a.p_question_id);
      if (!qq) throw fail("NOT_FOUND");
      const row = g.questions.get(qq.id);
      if (!row) throw fail("THEME_LOCKED");
      const st = effState(t, row, n);
      if (st === "TIMED_OUT") throw fail("QUESTION_TIMED_OUT");
      if (!["ACTIVE", "PENDING_APPROVAL", "APPROVED"].includes(st))
        throw fail("QUESTION_NOT_ACTIVE");
      const key = `${qq.id}:${a.p_tier}`;
      const owned = g.hints.has(key);
      if (!owned) {
        if (a.p_tier === 2 && !g.hints.has(`${qq.id}:1`)) throw fail("HINT_TIER1_REQUIRED");
        const cost = HINT_COST[a.p_tier];
        if (g.coins < cost) throw fail("INSUFFICIENT_COINS", { have: g.coins, need: cost });
        settle(t, n);
        g.coins -= cost;
        g.hints.add(key);
        g.ledger.push({ type: "HINT_PURCHASE", amount: -cost, qid: qq.id });
        bump(g);
        audit.push({ type: "HINT_PURCHASED", teamId: t.id, entityId: key });
      } else settle(t, n);
      const res = {
        replayed: false,
        already_owned: owned,
        tier: a.p_tier,
        hint: { tier: a.p_tier, body_md: hintBody(qq, a.p_tier) },
        question: questionJson(t, qq.id, n),
        state: teamState(t, m, n),
      };
      idemStore(t.id, a.p_idem_key, "buy_hint", f, res);
      return res;
    },

    buy_time(a) {
      const { t, m } = assertMember(a.p_team_id, a.p_member_id);
      needKey(a.p_idem_key);
      if (
        !Number.isInteger(a.p_question_id) ||
        !Number.isInteger(a.p_option_id) ||
        !Number.isInteger(a.p_expected_count) ||
        a.p_expected_count < 0
      )
        throw fail("VALIDATION_FAILED", { fields: ["optionId", "expectedPurchaseCount"] });
      const f = fp(
        "question",
        a.p_question_id,
        "option",
        a.p_option_id,
        "expected",
        a.p_expected_count,
        "member",
        m.id,
      );
      const replay = idemLookup(t.id, a.p_idem_key, "buy_time", f);
      if (replay) return { ...replay, replayed: true };
      const n = now();
      assertPlayable(t, n);
      const g = game(t);
      const qq = QUESTIONS.find((x) => x.id === a.p_question_id);
      if (!qq) throw fail("NOT_FOUND");
      const row = g.questions.get(qq.id);
      if (!row) throw fail("THEME_LOCKED");
      const st = effState(t, row, n);
      if (st === "TIMED_OUT") throw fail("QUESTION_TIMED_OUT");
      if (st !== "ACTIVE") throw fail("QUESTION_NOT_ACTIVE");
      if (row.timeCount !== a.p_expected_count)
        throw fail("STALE_PURCHASE_COUNT", { count: row.timeCount });
      const pack = TIME_PACKS.find((p) => optionId(qq.id, p.n) === a.p_option_id);
      if (!pack) throw fail("NOT_FOUND");
      const used = row.bought.get(pack.n) ?? 0;
      if (pack.max !== null && used >= pack.max) throw fail("TIME_PURCHASE_LIMIT");
      if (g.coins < pack.cost) throw fail("INSUFFICIENT_COINS", { have: g.coins, need: pack.cost });
      settle(t, n);
      g.coins -= pack.cost;
      g.ledger.push({ type: "TIME_PURCHASE", amount: -pack.cost, qid: qq.id });
      row.deadline += pack.seconds * 1000; // the question's deadline only: g.endsAt is never written
      row.extra += pack.seconds;
      row.timeCount += 1;
      row.bought.set(pack.n, used + 1);
      bump(g);
      audit.push({ type: "TIME_PURCHASED", teamId: t.id, entityId: String(qq.id) });
      const res = {
        replayed: false,
        purchase: {
          seq: row.timeCount,
          option_id: a.p_option_id,
          seconds: pack.seconds,
          cost: pack.cost,
        },
        question: questionJson(t, qq.id, n),
        state: teamState(t, m, n),
      };
      idemStore(t.id, a.p_idem_key, "buy_time", f, res);
      return res;
    },

    final_submit(a) {
      const { t, m } = assertMember(a.p_team_id, a.p_member_id);
      needKey(a.p_idem_key);
      if (a.p_confirm !== true) throw fail("VALIDATION_FAILED", { fields: ["confirm"] });
      const f = fp("member", m.id);
      const replay = idemLookup(t.id, a.p_idem_key, "final_submit", f);
      if (replay) return { ...replay, replayed: true };
      const n = now();
      assertPlayable(t, n);
      settle(t, n);
      const g = game(t);
      t.status = "FINAL_SUBMITTED";
      g.endedAt = n;
      g.finalSubmittedAt = n;
      freeze(t, n);
      bump(g);
      audit.push({ type: "TEAM_FINAL_SUBMITTED", teamId: t.id, memberId: m.id });
      const res = { replayed: false, state: teamState(t, m, n) };
      idemStore(t.id, a.p_idem_key, "final_submit", f, res);
      return res;
    },

    finalize_team_if_due(a) {
      const t = teamById(a.p_team_id);
      if (!t) throw fail("NOT_FOUND");
      return finalizeIfDue(t, now())
        ? { finalized: true, status: "ENDED" }
        : { finalized: false, status: t.status };
    },

    expire_due_teams(a) {
      const limit = a.p_limit ?? 200;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw fail("VALIDATION_FAILED", { fields: ["limit"] });
      const n = now();
      const due = teamList()
        .filter((t) => t.status === "RUNNING" && game(t).endsAt !== null && game(t).endsAt <= n)
        .sort((x, y) => game(x).endsAt - game(y).endsAt)
        .slice(0, limit);
      return due.filter((t) => finalizeIfDue(t, n)).length;
    },

    approve_submission(a) {
      return review(a, "approve");
    },
    disapprove_submission(a) {
      return review(a, "disapprove");
    },
  };

  // ---- B16: leaderboard and UFM penalty (migration 18) ------------------------------------------------------------
  fns.get_leaderboard = (a) => {
    const staff = staffById(a.p_staff_id);
    if (!staff || !staff.active || !["ADMIN", "SUPER_ADMIN"].includes(staff.role))
      throw fail("FORBIDDEN");
    const n = now();
    return {
      server_now: n,
      rows: leaderboardRows(n).map(({ rank, team_id, score }) => ({ rank, team_id, score })),
    };
  };
  fns.get_team_leaderboard = (a) => {
    const { t } = assertMember(a.p_team_id, a.p_member_id);
    const n = now();
    const rows = leaderboardRows(n);
    const mine = rows.find((r) => r.id === t.id);
    return {
      server_now: n,
      rows: rows.map(({ rank, team_id, score }) => ({ rank, team_id, score })),
      me: mine ? { rank: mine.rank, team_id: mine.team_id, score: mine.score } : null,
    };
  };
  fns.penalize_team = (a) => {
    const t = requireOwnerAdmin(a.p_staff_id, a.p_team_id);
    needKey(a.p_idem_key);
    const f = fp("team", t.id);
    const replay = idemLookup(a.p_staff_id, a.p_idem_key, "penalize_team", f);
    if (replay) return { ...replay, replayed: true };
    const g = game(t);
    const n = now();
    let changed = false;
    if (!t.ufmPenalizedAt) {
      if (t.status === "NOT_STARTED") throw fail("TEAM_NOT_STARTED");
      const previous = t.status;
      if (t.status === "RUNNING") {
        // app.expire_team at the team clock (the pause instant while paused), then the score is frozen
        const end = Math.min(g.endsAt, teamClock(t, n));
        for (const q of g.questions.values()) {
          if (q.state === "ACTIVE" && q.deadline <= end) {
            q.state = "TIMED_OUT";
            q.timedOutAt = q.deadline;
            q.deadline = null;
          }
        }
        t.status = "ENDED";
        g.endedAt = end;
        freeze(t, n);
        audit.push({ type: "TEAM_ENDED", teamId: t.id });
      }
      t.ufmPenalizedAt = n;
      bump(g);
      audit.push({
        type: "UFM_PENALIZED",
        teamId: t.id,
        staffId: a.p_staff_id,
        previous,
        gameplayScore: scoreParts(t, n).score,
      });
      changed = true;
    }
    const res = {
      replayed: false,
      changed,
      team: {
        id: t.id,
        team_code: t.code,
        status: t.status,
        official_score: 0,
        penalized_at: t.ufmPenalizedAt,
      },
    };
    idemStore(a.p_staff_id, a.p_idem_key, "penalize_team", f, res);
    return res;
  };

  // ---- Admin "My Teams" matrix (migration 15) -------------------------------------------------------------------
  const PRESENCE_TIMEOUT_S = 75;
  const requireOwnerAdmin = (staffId, teamId) => {
    const staff = staffById(staffId);
    if (!staff || !staff.active || staff.role !== "ADMIN") throw fail("FORBIDDEN");
    const t = teamById(teamId);
    if (!t || t.adminId !== staff.id) throw fail("NOT_FOUND");
    return t;
  };
  /** member_presence: a live, unexpired session seen within the timeout (the SQL view, on the unskewed wall clock). */
  const isOnline = (member) => {
    const n = baseNow();
    for (const s of sessions.values()) {
      if (s.kind !== "MEMBER" || s.member.id !== member.id || s.revoked) continue;
      if (s.expiresAt > n && s.lastSeen > n - PRESENCE_TIMEOUT_S * 1000) return true;
    }
    return false;
  };

  /** admin_matrix: one row per team the ADMIN owns; RED = something pending, GREEN = five approved. */
  fns.admin_matrix = (a) => {
    const staff = staffById(a.p_staff_id);
    if (!staff || !staff.active || staff.role !== "ADMIN") throw fail("FORBIDDEN");
    const rows = teamList()
      .filter((t) => t.adminId === staff.id)
      .sort((x, y) => x.createdAt - y.createdAt || (x.code < y.code ? -1 : 1))
      .map((t) => {
        const g = game(t);
        return {
          id: t.id,
          team_code: t.code,
          name: t.name,
          status: t.status,
          final_submitted: t.status === "FINAL_SUBMITTED",
          ufm_penalized: Boolean(t.ufmPenalizedAt),
          members: [...t.members]
            .sort((x, y) => x.slot - y.slot)
            .map((m) => ({ slot: m.slot, presence: isOnline(m) ? "ONLINE" : "OFFLINE" })),
          themes: THEMES.map((th) => {
            const qs = QUESTIONS.filter((q) => q.themeId === th.id).map((q) =>
              g.questions.get(q.id),
            );
            const approved = qs.filter((q) => q?.state === "APPROVED").length;
            const pending = qs.filter((q) => q?.state === "PENDING_APPROVAL").length;
            return {
              code: th.code,
              state: pending > 0 ? "RED" : approved === 5 ? "GREEN" : "NORMAL",
              approved,
              pending,
            };
          }),
        };
      });
    return { server_now: baseNow(), presence_timeout_seconds: PRESENCE_TIMEOUT_S, teams: rows };
  };

  /** admin_team_theme: the five questions of one theme cell, with the pending submission of a RED one (no key). */
  fns.admin_team_theme = (a) => {
    const t = requireOwnerAdmin(a.p_staff_id, a.p_team_id);
    const th = THEMES.find(
      (x) =>
        x.code ===
        String(a.p_theme_code ?? "")
          .trim()
          .toUpperCase(),
    );
    if (!th) throw fail("NOT_FOUND");
    const g = game(t);
    return {
      server_now: baseNow(),
      team: { id: t.id, team_code: t.code, name: t.name },
      theme: { code: th.code, name: th.name },
      questions: QUESTIONS.filter((q) => q.themeId === th.id).map((q) => {
        const row = g.questions.get(q.id);
        const state = row?.state ?? "LOCKED";
        const sub =
          state === "PENDING_APPROVAL"
            ? g.submissions.find((s) => s.qid === q.id && s.status === "PENDING")
            : null;
        return {
          id: q.id,
          ordinal: q.ordinal,
          label: `${th.code}.${q.ordinal}`,
          color: state === "APPROVED" ? "GREEN" : state === "PENDING_APPROVAL" ? "RED" : "WHITE",
          state,
          submission: sub
            ? {
                id: sub.id,
                body_md: q.body,
                answer: sub.answer,
                explanation: sub.explanation,
                submitted_by_slot: slotOf(t, sub.memberId),
                submitted_at: sub.at,
                reward_coins: q.reward,
              }
            : null,
        };
      }),
    };
  };

  /** approve_submission / disapprove_submission: the minimum controlled review path. */
  function review(a, action) {
    const staff = staffById(a.p_staff_id);
    if (!staff || !staff.active) throw fail("FORBIDDEN");
    needKey(a.p_idem_key);
    let owner;
    let sub;
    for (const t of teamList()) {
      const hit = game(t).submissions.find((s) => s.id === a.p_submission_id);
      if (hit) {
        owner = t;
        sub = hit;
      }
    }
    if (!sub) throw fail("NOT_FOUND");
    if (staff.role !== "SUPER_ADMIN" && owner.adminId !== staff.id) throw fail("NOT_FOUND");
    const note = action === "disapprove" ? (a.p_note ?? null) : null;
    if (action === "disapprove" && note !== null && [...String(note)].length > 500)
      throw fail("VALIDATION_FAILED", { fields: ["note"] });
    const op = `${action}_submission`;
    const f = fp("submission", sub.id, "note", note ?? "");
    const replay = idemLookup(staff.id, a.p_idem_key, op, f);
    if (replay) return { ...replay, replayed: true };
    const n = now();
    if (owner.competition === "PAUSED") throw fail("COMPETITION_PAUSED");
    if (owner.competition !== "RUNNING") throw fail("COMPETITION_NOT_RUNNING");
    if (sub.status !== "PENDING") throw fail("SUBMISSION_NOT_PENDING");
    // B16: an approval that finds an expired, not yet persisted team ends it at its end first (which freezes the score)
    if (action === "approve") finalizeIfDue(owner, n);
    const g = game(owner);
    const row = g.questions.get(sub.qid);
    const qq = QUESTIONS.find((x) => x.id === sub.qid);
    sub.reviewedAt = n;
    sub.reviewer = staff.id;
    let res;
    if (action === "approve") {
      sub.status = "APPROVED";
      sub.reward = qq.reward;
      row.state = "APPROVED";
      row.approvedAt = n;
      row.remaining = null;
      g.coins += qq.reward;
      const live = owner.status === "RUNNING" && n < g.endsAt;
      const next = QUESTIONS.find((x) => x.themeId === qq.themeId && x.ordinal === qq.ordinal + 1);
      let activated = false;
      const nextRow = next && g.questions.get(next.id);
      if (live && nextRow && nextRow.state === "LOCKED") {
        nextRow.state = "ACTIVE";
        nextRow.activatedAt = n;
        nextRow.deadline = n + next.timeLimit * 1000;
        activated = true;
      }
      audit.push({ type: "SUBMISSION_APPROVED", teamId: owner.id, entityId: sub.id });
      res = {
        replayed: false,
        submission: { id: sub.id, status: "APPROVED" },
        reward_awarded: qq.reward,
        next_question_activated: activated,
      };
    } else {
      sub.status = "REJECTED";
      sub.note = note;
      row.state = "ACTIVE";
      // the question clock (not "now"): a frozen team's returned question must not show more time than it had
      row.deadline = questionClock(owner, n) + row.remaining * 1000;
      row.remaining = null;
      audit.push({ type: "SUBMISSION_REJECTED", teamId: owner.id, entityId: sub.id });
      res = { replayed: false, submission: { id: sub.id, status: "REJECTED" } };
    }
    bump(g);
    idemStore(staff.id, a.p_idem_key, op, f, res);
    return res;
  }

  /** Test-only controls that belong to the gameplay model. */
  const controls = {
    /** Moves the engine's clock forward (deadlines are absolute, so questions and the team timer run out). */
    clock({ advanceMs }) {
      skew += Number(advanceMs);
      return { skewMs: skew };
    },
    /** Pause / resume the team's competition status with the SQL's shifting rules. */
    setCompetition({ loginId, status }) {
      const t = teams.get(String(loginId).toLowerCase());
      if (!t) throw new AppError("unknown team");
      const g = game(t);
      const n = now();
      if (status === "PAUSED" && t.competition !== "PAUSED") g.pausedAt = n;
      if (status === "RUNNING" && t.competition === "PAUSED" && g.pausedAt !== null) {
        const shift = n - g.pausedAt;
        for (const q of g.questions.values()) {
          if (q.state === "ACTIVE") {
            if (q.deadline <= g.pausedAt) {
              q.state = "TIMED_OUT";
              q.timedOutAt = q.deadline;
              q.deadline = null;
            } else q.deadline += shift;
          }
        }
        if (g.endsAt !== null) g.endsAt += shift;
        g.pausedAt = null;
        bump(g);
      }
      t.competition = status;
      return { ok: true };
    },
    /**
     * Test-only: lets `ms` of time pass for ONE team without moving the shared clock (which would also age every other
     * team of the parallel specs): its start and end move that much into the past, and so do its running question deadlines unless `questions` is false.
     */
    ageTeam({ loginId, ms, questions = true }) {
      const t = teams.get(String(loginId).toLowerCase());
      if (!t) throw new AppError("unknown team");
      const g = game(t);
      if (g.startedAt === null) throw new AppError("team not started");
      g.startedAt -= Number(ms);
      g.endsAt -= Number(ms);
      if (questions) {
        for (const q of g.questions.values()) {
          if (q.state === "ACTIVE") q.deadline -= Number(ms);
        }
      }
      return { endsAt: g.endsAt };
    },
    /** Test-only: sets a team's coin balance (the score is derived from it; there is no stored score any more). */
    setCoins({ loginId, coins }) {
      const t = teams.get(String(loginId).toLowerCase());
      if (!t) throw new AppError("unknown team");
      game(t).coins = Number(coins);
      return { ok: true };
    },
    /** Test-only: gives a started team the allowance a pre-B15 team was given (seconds), keeping `started_at`. */
    legacyTimer({ loginId, seconds }) {
      const t = teams.get(String(loginId).toLowerCase());
      if (!t) throw new AppError("unknown team");
      const g = game(t);
      if (g.startedAt === null) throw new AppError("team not started");
      g.timerSeconds = Number(seconds);
      g.endsAt = g.startedAt + Number(seconds) * 1000;
      bump(g);
      return { endsAt: g.endsAt };
    },
    /** What the database holds for one team (so a test can prove "exactly once"): never reaches the app. */
    inspect({ loginId }) {
      const t = teams.get(String(loginId).toLowerCase());
      if (!t) throw new AppError("unknown team");
      const g = game(t);
      return {
        coins: g.coins,
        version: g.version,
        status: t.status,
        startedAt: g.startedAt,
        endsAt: g.endsAt,
        endedAt: g.endedAt,
        finalSubmittedAt: g.finalSubmittedAt,
        timerSeconds: g.timerSeconds,
        final: g.final,
        penalizedAt: t.ufmPenalizedAt ?? null,
        score: officialScore(t, now()),
        hints: [...g.hints],
        ledger: g.ledger,
        themes: [...g.themes.keys()],
        questions: Object.fromEntries(
          [...g.questions].map(([id, q]) => [
            id,
            {
              state: q.state,
              deadline: q.deadline,
              remaining: q.remaining,
              timeCount: q.timeCount ?? 0,
              extra: q.extra ?? 0,
            },
          ]),
        ),
        submissions: g.submissions.map((s) => ({
          id: s.id,
          qid: s.qid,
          status: s.status,
          reward: s.reward,
        })),
        audit: audit.filter((e) => e.teamId === t.id).map((e) => e.type),
      };
    },
  };

  return { functions: fns, controls, clockNow: now };
}
