// Upgrade test for B17 (migration 19, the official content) on a production-shaped database.
//
// Production was seeded with the placeholder content (supabase/seed.sql) and has been played on since. This script builds a scratch
// database at the B16 state (migrations 1-18 + the placeholder seed), plays the situations that matter, applies migration 19 and
// asserts that:
//
//   - every theme name/description, question text/reward and hint text equals the canonical JSON character for character;
//   - NOTHING about any team changed: the md5 of teams, members, themes/questions unlocked, drafts, submissions, the coin
//     ledger, hint purchases, the request log and every audit row that existed is identical (the only new row anywhere is
//     one CONTENT_IMPORTED audit event);
//   - a reward already paid keeps its old amount; an answer that was waiting is paid the NEW reward of its question, once;
//     a retry does not pay again; a late approval on a team already frozen pays the reward and does not move the frozen
//     score; a penalised team stays at 0;
//   - a second run changes nothing, and an unexpected shape (a missing hint row) aborts the migration with nothing changed.
//
// scripts/db-verify.mjs runs it with VERIFY_ADMIN_URL (a server it may create databases on). It creates and drops its own
// scratch database and never touches anything else.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const adminUrl = process.env.VERIFY_ADMIN_URL;
if (!adminUrl) {
  console.error("upgrade test: VERIFY_ADMIN_URL is not set (run it through `npm run db:verify`).");
  process.exit(2);
}
const root = resolve(import.meta.dirname, "../../..");
const dbName = `concetto_upgrade17_${randomBytes(4).toString("hex")}`;
const target = (() => {
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
})();

const psql = (url, args, input) => {
  const r = spawnSync("psql", [url, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8",
    input,
  });
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};
const must = (sql) => {
  const r = psql(target, ["-f", "-"], sql);
  assert.equal(r.code, 0, `psql failed: ${r.err}\n${sql.slice(0, 400)}`);
  return r.out;
};
const rows = (sql) => JSON.parse(must(sql) || "null");

const migrations = readdirSync(join(root, "supabase/migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort();
const B17 = migrations.filter((f) => /^20261006000019_/.test(f));
const BEFORE = migrations.filter((f) => !B17.includes(f));
assert.equal(B17.length, 1, "the B17 migration");
assert.equal(BEFORE.length, 18, "eighteen migrations existed at the B16 baseline");
const content = JSON.parse(
  readFileSync(join(root, "content/concetto26/official-content.json"), "utf8"),
);

const SUPER = "00000000-0000-0000-0000-0000000000a1";
const ADMIN = "00000000-0000-0000-0000-0000000000a2";
const team = (n) => `00000000-0000-0000-0000-00000000a${n}00`;
const member = (n, s) => `00000000-0000-0000-0000-00000000a${n}0${s}`;
const key = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const clock = (ts) => must(`alter database ${dbName} set app.test_now = '${ts}'`);
const T0 = "2026-12-01 12:00:00+00";
const pending = (n, q) =>
  `(select id from submissions where team_id = '${team(n)}' and question_id = ${q} and status = 'PENDING')`;

const TABLES = [
  ["teams", "id"],
  ["team_members", "id"],
  ["team_themes", "team_id, theme_id"],
  ["team_questions", "team_id, question_id"],
  ["answer_drafts", "team_id, question_id"],
  ["submissions", "id"],
  ["coin_transactions", "id"],
  ["hint_purchases", "team_id, hint_id"],
  ["request_log", "team_id, idem_key"],
  ["audit_events", "id"],
];
const fingerprint = () =>
  Object.fromEntries(
    TABLES.map(([t, order]) => [
      t,
      must(
        `select coalesce(md5(string_agg(to_jsonb(x)::text, ',' order by ${order
          .split(", ")
          .map((c) => `x.${c}`)
          .join(", ")})), 'empty') || ':' || count(*) from ${t} x`,
      ),
    ]),
  );

try {
  assert.equal(psql(adminUrl, ["-c", `create database ${dbName}`]).code, 0, "create database");

  // ---- 1. the B16 database with the placeholder content ---------------------------------------------------------------
  for (const f of BEFORE) {
    const r = psql(target, ["-f", join(root, "supabase/migrations", f)]);
    assert.equal(r.code, 0, `migration ${f}: ${r.err}`);
  }
  const seeded = psql(target, ["-f", join(root, "supabase/seed.sql")]);
  assert.equal(seeded.code, 0, `seed: ${seeded.err}`);
  must(`alter database ${dbName} set app.allow_test_clock = 'on'`);
  clock(T0);

  // ---- 2. production-shaped data -------------------------------------------------------------------------------------
  //   V1 RUNNING, A.1 bought hint 1 and WAITING for review          V2 RUNNING, A.1 APPROVED under the old reward (50), A.2 active
  //   V3 FINAL_SUBMITTED with A.1 still waiting                     V4 penalised (official score 0) after an approved A.1
  //   V5 never started
  must(`
insert into staff_users (id, username, display_name, password_hash, role)
values ('${SUPER}', 'up_super', 'Upgrade Super', 'TEST-NOT-A-HASH', 'SUPER_ADMIN');
insert into staff_users (id, username, display_name, password_hash, role, created_by)
values ('${ADMIN}', 'up_admin', 'Upgrade Admin', 'TEST-NOT-A-HASH', 'ADMIN', '${SUPER}');
${[1, 2, 3, 4, 5]
  .map(
    (n) => `
insert into teams (id, team_code, name, login_id, password_hash, admin_id, coins)
values ('${team(n)}', 'V0${n}', 'Upgrade ${n}', 'up_team_${n}', 'TEST-NOT-A-HASH', '${ADMIN}', 500);
insert into coin_transactions (team_id, type, amount, balance_after, created_at) values ('${team(n)}', 'INITIAL_GRANT', 500, 500, now());
insert into team_members (id, team_id, slot, admission_no)
select ('00000000-0000-0000-0000-00000000a${n}0' || s)::uuid, '${team(n)}', s, 'UP${n}' || s from generate_series(1, 4) s;`,
  )
  .join("\n")}
update competition set status = 'RUNNING', opened_at = now() where id = 1;
${[1, 2, 3, 4].map((n) => `select public.start_team_competition('${team(n)}', '${member(n, 1)}', '${key(900 + n)}');`).join("\n")}
${[1, 2, 3, 4]
  .map(
    (n) => `
select public.unlock_theme('${team(n)}', '${member(n, 1)}', 1::smallint, '${key(n * 100 + 1)}');
select public.start_question('${team(n)}', '${member(n, 1)}', 1::smallint, '${key(n * 100 + 2)}');`,
  )
  .join("\n")}
select public.buy_hint('${team(1)}', '${member(1, 1)}', 1::smallint, 1::smallint, '${key(111)}');
${[1, 2, 3, 4]
  .map(
    (n) =>
      `select public.submit_answer('${team(n)}', '${member(n, 1)}', 1::smallint, 'ans', 'because', '${key(n * 100 + 3)}');`,
  )
  .join("\n")}
-- V2 and V4 get A.1 approved NOW, under the placeholder reward of 50
select public.approve_submission('${ADMIN}', ${pending(2, 1)}, '${key(204)}');
select public.approve_submission('${ADMIN}', ${pending(4, 1)}, '${key(404)}');
select public.final_submit('${team(3)}', '${member(3, 1)}', true, '${key(399)}');
select public.penalize_team('${ADMIN}', '${team(4)}', '${key(499)}');
`);
  assert.deepEqual(
    rows(`select jsonb_object_agg(team_code, status) from teams`),
    {
      V01: "RUNNING",
      V02: "RUNNING",
      V03: "FINAL_SUBMITTED",
      V04: "ENDED",
      V05: "NOT_STARTED",
    },
    "the situations exist",
  );
  assert.equal(
    must(
      `select count(*) from questions where body_md like '[DEV PLACEHOLDER]%' and reward_coins = 50`,
    ),
    "50",
    "production still holds the placeholder content",
  );
  const paidBefore = rows(
    `select jsonb_object_agg(team_code, jsonb_build_object('coins', coins, 'score', (select official_score from app.team_scores(app.now(), t.id)))) from teams t`,
  );
  assert.equal(paidBefore.V02.coins, 450, "V2 was paid the old 50");
  assert.equal(paidBefore.V04.score, 0, "V4 is penalised: official score 0");
  const fp = fingerprint();
  const finalV3 = must(`select final_score from teams where id = '${team(3)}'`);
  assert.notEqual(finalV3, "", "V3 is frozen");

  // ---- 3. apply migration 19 -------------------------------------------------------------------------------------------
  const applied = psql(target, ["-f", join(root, "supabase/migrations", B17[0])]);
  assert.equal(applied.code, 0, `migration ${B17[0]}: ${applied.err}`);
  assert.match(applied.err, /10 themes, 50 questions, 100 hints updated/);

  // ---- 4. the content is the JSON, character for character -----------------------------------------------------------
  const db = rows(`select jsonb_build_object(
      'themes', (select jsonb_agg(jsonb_build_object('code', code, 'name', name, 'description', description) order by id) from themes),
      'questions', (select jsonb_agg(jsonb_build_object('id', id, 'body', body_md, 'reward', reward_coins) order by id) from questions),
      'hints', (select jsonb_agg(jsonb_build_object('id', id, 'qid', question_id, 'tier', tier, 'body', body_md) order by id) from hints))`);
  assert.equal(db.themes.length, 10);
  content.themes.forEach((t, i) => {
    assert.deepEqual(
      db.themes[i],
      { code: t.id, name: t.name, description: t.description },
      `theme ${t.id}`,
    );
  });
  assert.equal(db.questions.length, 50);
  assert.equal(db.hints.length, 100);
  content.questions.forEach((q, i) => {
    const row = db.questions[i];
    assert.equal(row.id, i + 1, `${q.id} is question ${i + 1}`);
    assert.equal(row.body, q.question, `${q.id} text`);
    assert.equal(row.reward, q.reward, `${q.id} reward`);
    const [h1, h2] = [db.hints[2 * i], db.hints[2 * i + 1]];
    assert.deepEqual([h1.qid, h1.tier, h1.body], [i + 1, 1, q.hint1], `${q.id} hint 1`);
    assert.deepEqual([h2.qid, h2.tier, h2.body], [i + 1, 2, q.hint2], `${q.id} hint 2`);
  });

  // ---- 5. nothing about any team changed --------------------------------------------------------------------------------
  const fp2 = fingerprint();
  for (const [t] of TABLES) {
    if (t === "audit_events") continue;
    assert.equal(fp2[t], fp[t], `${t} is untouched`);
  }
  assert.equal(
    must(`select count(*) from audit_events where event_type = 'CONTENT_IMPORTED'`),
    "1",
    "exactly one audit event, and it is the last row",
  );
  assert.equal(
    must(`select event_type from audit_events order by id desc limit 1`),
    "CONTENT_IMPORTED",
  );
  // every earlier audit row is byte-identical (the table is append-only; compare the prefix)
  assert.equal(
    must(
      `select coalesce(md5(string_agg(to_jsonb(x)::text, ',' order by id)), 'empty') || ':' || count(*) from audit_events x where event_type <> 'CONTENT_IMPORTED'`,
    ),
    fp.audit_events,
    "the audit rows that existed are unchanged",
  );
  assert.equal(
    must(`select count(*) from questions where time_limit_seconds <> 240 or difficulty is null`),
    "0",
  );
  assert.equal(
    must(`select count(*) from hints where cost <> case tier when 1 then 20 else 40 end`),
    "0",
    "hint prices",
  );
  assert.equal(must(`select count(*) from themes where unlock_cost <> 100`), "0", "unlock prices");
  const after = rows(
    `select jsonb_object_agg(team_code, jsonb_build_object('coins', coins, 'score', (select official_score from app.team_scores(app.now(), t.id)))) from teams t`,
  );
  assert.deepEqual(after, paidBefore, "every balance and every score is exactly as before");
  const board = rows(`select public.get_leaderboard('${SUPER}')`);
  assert.equal(board.rows.at(-1).team_id, "V05", "the unstarted team is still last");

  // ---- 6. rewards from now on are the official ones, once ----------------------------------------------------------
  clock("2026-12-01 12:01:00+00");
  const old = rows(
    `select jsonb_agg(jsonb_build_object('t', team_id, 'q', question_id, 'paid', reward_awarded) order by team_id) from submissions where status = 'APPROVED'`,
  );
  assert.deepEqual(
    old.map((r) => r.paid),
    [50, 50],
    "answers approved before the migration keep the 50 they were paid",
  );
  // V1: the waiting A.1 is approved after the migration -> A.1's reward is 100
  const j1 = rows(`select public.approve_submission('${ADMIN}', ${pending(1, 1)}, '${key(1001)}')`);
  assert.equal(j1.reward_awarded, 100, "A.1 pays its official reward");
  assert.equal(
    must(`select coins from teams where id = '${team(1)}'`),
    String(paidBefore.V01.coins + 100),
  );
  const j1b = rows(
    `select public.approve_submission('${ADMIN}', (select id from submissions where team_id = '${team(1)}' and question_id = 1), '${key(1001)}')`,
  );
  assert.equal(j1b.replayed, true, "same key: replayed");
  assert.equal(
    must(`select coins from teams where id = '${team(1)}'`),
    String(paidBefore.V01.coins + 100),
    "not paid twice",
  );
  assert.equal(
    must(
      `select count(*) from coin_transactions where team_id = '${team(1)}' and type = 'QUESTION_REWARD'`,
    ),
    "1",
  );
  // V3: frozen at Final Submit; the late approval pays 100 and the frozen score does not move
  const frozenScore = must(`select official_score from app.team_scores(app.now(), '${team(3)}')`);
  clock("2026-12-01 18:00:00+00");
  const j3 = rows(`select public.approve_submission('${ADMIN}', ${pending(3, 1)}, '${key(3001)}')`);
  assert.equal(j3.reward_awarded, 100);
  assert.equal(
    must(`select coins from teams where id = '${team(3)}'`),
    String(paidBefore.V03.coins + 100),
  );
  assert.equal(
    must(`select official_score from app.team_scores(app.now(), '${team(3)}')`),
    frozenScore,
    "frozen score unchanged by the late reward",
  );
  assert.equal(must(`select final_score from teams where id = '${team(3)}'`), finalV3);
  assert.equal(
    must(`select official_score from app.team_scores(app.now(), '${team(4)}')`),
    "0",
    "the penalty still holds",
  );

  // ---- 7. a second run changes nothing ----------------------------------------------------------------------------------
  const fpBefore2 = fingerprint();
  const again = psql(target, ["-f", join(root, "supabase/migrations", B17[0])]);
  assert.equal(again.code, 0, again.err);
  assert.match(again.err, /0 themes, 0 questions, 0 hints updated/);
  assert.deepEqual(fingerprint(), fpBefore2, "idempotent: no row and no audit event added");

  // ---- 8. an unexpected shape aborts with nothing changed ------------------------------------------------------------------
  const guardFile = join(root, `supabase/tests/upgrade/.b17-guard-${randomBytes(4).toString("hex")}.sql`);
  let guarded;
  try {
    writeFileSync(
      guardFile,
      `begin; delete from hints where id = 100;\n${readFileSync(join(root, "supabase/migrations", B17[0]), "utf8")}\n`,
      "utf8",
    );
    guarded = psql(target, ["-f", guardFile]);
  } finally {
    try {
      unlinkSync(guardFile);
    } catch {}
  }
  assert.notEqual(guarded.code, 0, "the migration refuses a database that is not 10 / 50 / 100");
  assert.match(guarded.err, /expected 10 themes, 50 questions and 100 hints, found 10, 50 and 99/);
  assert.deepEqual(fingerprint(), fpBefore2, "nothing changed");
  assert.equal(
    must(`select count(*) from hints`),
    "100",
    "the aborted transaction left the hint in place",
  );
  console.log(
    "B17 upgrade: content equals the JSON, no team state changed, rewards are per question and paid once, idempotent",
  );
} finally {
  psql(adminUrl, ["-c", `drop database if exists ${dbName} with (force)`]);
}
