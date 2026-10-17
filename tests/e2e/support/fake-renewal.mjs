// "Renew the Competition" (migration 21) for the in-memory backend: get_renewal_content, renew_competition and
// get_competition_rules, used ONLY by the Playwright suite and its unit test (tests/unit/fake-renewal.test.ts).
//
// It mirrors supabase/migrations/20261006000021_renew_competition.sql step for step: the same locks' ORDER OF CHECKS (caller
// authorisation, idempotency, validation with field paths, the content token, readiness on live rows, deletion through the
// existing delete_admins, content, lifecycle), the same error codes and the same result shapes. The SQL itself is proven on a real
// PostgreSQL by supabase/tests/200_renew_competition.test.sql, concurrency/zz_renew.concurrency.mjs and
// upgrade/b21_upgrade.upgrade.mjs; a rule changed there must be changed here. A rejected request never mutates anything,
// which is what the SQL's single transaction guarantees (everything is checked before the first change).
import { createHash } from "node:crypto";

const LIMITS = { name: 200, description: 1000, question: 8000, hint: 4000, rule: 2000 };
const STRAY_CONTROL = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const textBad = (v, max) =>
  typeof v !== "string" || !/\S/u.test(v) || [...v].length > max || STRAY_CONTROL.test(v);
const keysAre = (v, keys) =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(",") === [...keys].sort().join(",");

/** app.renewal_content_problems: field paths, never values. */
export function contentProblems(c) {
  if (!keysAre(c, ["themes", "rules"])) return ["content"];
  const p = [];
  if (!Array.isArray(c.themes) || c.themes.length !== 10) p.push("themes");
  else {
    c.themes.forEach((t, i) => {
      const code = String.fromCharCode(65 + i);
      if (!keysAre(t, ["id", "name", "description", "questions"]))
        return void p.push(`themes.${code}`);
      if (t.id !== code) p.push(`themes.${code}.id`);
      if (textBad(t.name, LIMITS.name)) p.push(`themes.${code}.name`);
      if (textBad(t.description, LIMITS.description)) p.push(`themes.${code}.description`);
      if (!Array.isArray(t.questions) || t.questions.length !== 5)
        p.push(`themes.${code}.questions`);
      else {
        t.questions.forEach((q, j) => {
          const id = `${code}.${j + 1}`;
          if (!keysAre(q, ["id", "question", "hint1", "hint2", "reward"]))
            return void p.push(`questions.${id}`);
          if (q.id !== id) p.push(`questions.${id}.id`);
          if (textBad(q.question, LIMITS.question)) p.push(`questions.${id}.question`);
          if (textBad(q.hint1, LIMITS.hint)) p.push(`questions.${id}.hint1`);
          if (textBad(q.hint2, LIMITS.hint)) p.push(`questions.${id}.hint2`);
          if (typeof q.reward !== "number" || !/^[1-9][0-9]{0,5}$/.test(String(q.reward)))
            p.push(`questions.${id}.reward`);
        });
      }
    });
  }
  if (!Array.isArray(c.rules) || c.rules.length < 1 || c.rules.length > 50) p.push("rules");
  else c.rules.forEach((r, i) => textBad(r, LIMITS.rule) && p.push(`rules.${i + 1}`));
  return p;
}

/**
 * @param {{ teams: Map<string, any>, staff: Map<string, any>, staffById: (id: string) => any,
 *           AppError: typeof Error, idemLookup: Function, idemStore: Function, audit: any[],
 *           deleteAdmins: (a: any) => any, gameplay: any }} deps
 */
export function createRenewal({
  teams,
  staff,
  staffById,
  AppError,
  idemLookup,
  idemStore,
  audit,
  deleteAdmins,
  gameplay,
}) {
  const { THEMES, QUESTIONS } = gameplay.content;
  /** competition.rules: null until the first renewal (the application then shows the built-in official rules). */
  let rules = null;
  /** competition.status (the stand-in's participant logins keep their per-team status; this is the Super Admin's view). */
  const competition = { status: "RUNNING", stateVersion: 1 };

  const superCaller = (id) => {
    const u = staffById(id);
    if (!u || u.role !== "SUPER_ADMIN" || !u.active) throw new AppError("FORBIDDEN");
    return u;
  };

  /** app.renewal_content_json */
  const contentJson = () => ({
    themes: THEMES.map((t) => ({
      id: t.code,
      name: t.name,
      description: t.description,
      questions: QUESTIONS.filter((q) => q.themeId === t.id).map((q) => ({
        id: `${t.code}.${q.ordinal}`,
        question: q.body,
        hint1: q.hints[0],
        hint2: q.hints[1],
        reward: q.reward,
      })),
    })),
    rules: rules ? [...rules] : null,
  });
  /** app.renewal_content_token: changes whenever any editable text, reward or the rules change. */
  const token = () => createHash("sha256").update(JSON.stringify(contentJson())).digest("hex");

  /** app.renewal_readiness */
  function readiness() {
    const blockers = [...teams.values()]
      .map((t) => ({ team_code: t.code, name: t.name, reason: gameplay.renewalBlock(t) }))
      .filter((b) => b.reason !== null)
      .sort((x, y) => (x.team_code < y.team_code ? -1 : x.team_code > y.team_code ? 1 : 0));
    return {
      ready: blockers.length === 0,
      blocked_count: blockers.length,
      blockers: blockers.slice(0, 50),
      admins: [...staff.values()].filter((u) => u.role === "ADMIN").length,
      teams: teams.size,
      pending_submissions: gameplay.pendingSubmissions(),
      competition_status: competition.status,
    };
  }

  const functions = {
    get_renewal_content(a) {
      superCaller(a.p_staff_id);
      return { content: contentJson(), token: token(), readiness: readiness() };
    },
    get_competition_rules() {
      return { rules: rules ? [...rules] : null };
    },
    renew_competition(a) {
      const caller = superCaller(a.p_staff_id);
      const content = a.p_content;
      const fingerprint = `renew:${createHash("sha256")
        .update(`${JSON.stringify(content ?? null)}|${a.p_expected_token ?? ""}`)
        .digest("hex")}`;
      const replay = idemLookup(caller.id, a.p_idem_key, "renew_competition", fingerprint);
      if (replay) return { ...replay, replayed: true };

      const problems = contentProblems(content);
      if (typeof a.p_expected_token !== "string" || !/^[0-9a-f]{64}$/.test(a.p_expected_token)) {
        problems.push("expectedToken");
      }
      if (problems.length)
        throw new AppError("VALIDATION_FAILED", { fields: problems.slice(0, 20) });
      const before = token();
      if (before !== a.p_expected_token) throw new AppError("CONTENT_CHANGED");

      const ready = readiness();
      if (!ready.ready) throw new AppError("RENEWAL_BLOCKED", ready);
      const pendingDiscarded = ready.pending_submissions;

      // The admins this Super Admin created. Anything left over (an admin someone else created) makes the SQL roll back with
      // RENEWAL_INCOMPLETE; here that is decided BEFORE anything is deleted, which is the same outcome.
      const admins = [...staff.values()].filter((u) => u.role === "ADMIN");
      const mine = admins
        .filter((u) => u.createdBy === caller.id)
        .sort((x, y) => (x.id < y.id ? -1 : 1));
      if (admins.length !== mine.length) throw new AppError("RENEWAL_INCOMPLETE");
      let nAdmins = 0;
      let nTeams = 0;
      for (let i = 0; i < mine.length; i += 100) {
        // Atomic: delete_admins refuses (DELETE_BLOCKED) before changing anything, and the chunks are checked first.
        const ids = mine.slice(i, i + 100).map((u) => u.id);
        const r = deleteAdmins({
          p_staff_id: caller.id,
          p_admin_ids: ids,
          p_idem_key: `${a.p_idem_key}:renew-delete:${i}`,
        });
        nAdmins += r.deleted.admins;
        nTeams += r.deleted.teams;
      }
      if (teams.size > 0) throw new AppError("RENEWAL_INCOMPLETE");

      let nThemes = 0;
      let nQuestions = 0;
      let nHints = 0;
      content.themes.forEach((ct, i) => {
        const t = THEMES[i];
        if (t.name !== ct.name || t.description !== ct.description) nThemes += 1;
        t.name = ct.name;
        t.description = ct.description;
        ct.questions.forEach((cq, j) => {
          const q = QUESTIONS.find((x) => x.themeId === t.id && x.ordinal === j + 1);
          if (q.body !== cq.question || q.reward !== cq.reward) nQuestions += 1;
          if (q.hints[0] !== cq.hint1) nHints += 1;
          if (q.hints[1] !== cq.hint2) nHints += 1;
          q.body = cq.question;
          q.reward = cq.reward;
          q.hints = [cq.hint1, cq.hint2];
        });
      });
      rules = [...content.rules];

      const from = competition.status;
      competition.status = "SETUP";
      competition.stateVersion += 1;
      audit.push({ type: "COMPETITION_RENEWED", staffId: caller.id });
      const response = {
        replayed: false,
        deleted: { admins: nAdmins, teams: nTeams },
        discarded: { pending_submissions: pendingDiscarded },
        changed: { themes: nThemes, questions: nQuestions, hints: nHints },
        competition: { from, to: "SETUP" },
        token: token(),
      };
      idemStore(caller.id, a.p_idem_key, "renew_competition", fingerprint, response);
      return response;
    },
  };

  const controls = {
    /** What the stand-in holds, so a test can prove what a rejected request left untouched. */
    renewalState() {
      return { competition: { ...competition }, rules, token: token() };
    },
    /** Test-only: another Super Admin's edit (changes the content, hence the token, behind the editor's back). */
    editThemeName({ code, name }) {
      const t = THEMES.find((x) => x.code === code);
      if (!t) throw new AppError("unknown theme");
      t.name = String(name);
      return { token: token() };
    },
  };
  return { functions, controls };
}
