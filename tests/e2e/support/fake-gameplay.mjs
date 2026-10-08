// The gameplay functions of migration 14 for the in-memory backend (fake-postgrest.mjs), used ONLY by the Playwright
// suite: unlock_theme, start_question, get_question_for_team, save_draft, submit_answer, approve_submission,
// disapprove_submission, start_team_competition and get_team_state.
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

const DURATION_S = 7200;
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
const REWARD = 50;
export const SECRET_PREFIX = "E2E-SECRET-ANSWER";

export const THEMES = [...THEME_CODES].map((code, i) => ({
  id: i + 1,
  code,
  name: `E2E Theme ${code}`,
  description: `Description of E2E theme ${code}.`,
  topics: ["algebra", "geometry"],
  difficulty: DIFFICULTY[i],
  unlock_cost: UNLOCK_COST,
}));
export const QUESTIONS = THEMES.flatMap((t) =>
  [1, 2, 3, 4, 5].map((ordinal) => ({
    id: (t.id - 1) * 5 + ordinal,
    themeId: t.id,
    ordinal,
    body: `Body of question ${t.code}${ordinal}: find the value.`,
    reward: REWARD,
    timeLimit: TIME_LIMIT_S,
    referenceAnswer: `${SECRET_PREFIX}-${t.code}${ordinal}`,
  })),
);

/** @param {{ teams: Map<string, any>, staffById: (id: string) => any, now: () => number, AppError: typeof Error,
 *            idemLookup: Function, idemStore: Function, audit: any[] }} deps */
export function createGameplay({
  teams,
  staffById,
  now: baseNow,
  AppError,
  idemLookup,
  idemStore,
  audit,
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
    const remaining =
      g.endsAt === null ? DURATION_S : Math.max(0, Math.floor((g.endsAt - ref) / 1000));
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
        ended_at: null,
        final_submitted_at: null,
        duration_seconds: DURATION_S,
        remaining_seconds: remaining,
        expired: t.status === "RUNNING" && g.endsAt !== null && ref >= g.endsAt,
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

    approve_submission(a) {
      return review(a, "approve");
    },
    disapprove_submission(a) {
      return review(a, "disapprove");
    },
  };

  /** list_pending_submissions: the thin review queue (read only; no reference answer, no key). */
  fns.list_pending_submissions = (a) => {
    const staff = staffById(a.p_staff_id);
    if (!staff || !staff.active) throw fail("FORBIDDEN");
    const rows = [];
    for (const t of teamList()) {
      if (staff.role !== "SUPER_ADMIN" && t.adminId !== staff.id) continue;
      for (const s of game(t).submissions) {
        if (s.status !== "PENDING") continue;
        const qq = QUESTIONS.find((x) => x.id === s.qid);
        rows.push({
          id: s.id,
          team_code: t.code,
          team_name: t.name,
          theme_code: THEMES[qq.themeId - 1].code,
          ordinal: qq.ordinal,
          question_id: qq.id,
          body_md: qq.body,
          answer: s.answer,
          explanation: s.explanation,
          submitted_by_slot: slotOf(t, s.memberId),
          submitted_at: s.at,
        });
      }
    }
    rows.sort((x, y) => x.submitted_at - y.submitted_at || (x.id < y.id ? -1 : 1));
    return { server_now: now(), submissions: rows.slice(0, 100) };
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
      row.deadline = n + row.remaining * 1000;
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
        themes: [...g.themes.keys()],
        questions: Object.fromEntries(
          [...g.questions].map(([id, q]) => [
            id,
            { state: q.state, deadline: q.deadline, remaining: q.remaining },
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
