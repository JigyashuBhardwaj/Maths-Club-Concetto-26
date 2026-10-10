// Upgrade test for B16 (migration 18) on a production-shaped database.
//
// The ordinary db:verify run applies every migration to an empty database, which cannot show what the scoring migration does
// to teams that are ALREADY terminal (their final_* columns were never written before B16). This script builds a scratch
// database at the B15 state (migrations 1-17 + seed), plays the situation production will be in, applies migration 18 and
// asserts that:
//
//   - teams that were already FINAL_SUBMITTED / ENDED get their score frozen from the data as it stands, on the same basis as a
//     new terminal team (minutes = elapsed time of THEIR allowance, so a 2 h legacy team is not charged 240 minutes);
//   - a team that is still RUNNING and one that never started are not written (their score stays derived);
//   - nothing else about any team changed (status, coins, ledger, started_at / ends_at / ended_at);
//   - one SCORES_BACKFILLED audit row records how many teams were frozen;
//   - the leaderboard then ranks started teams first (score, minutes, Team ID) and the unstarted team last.
//
// scripts/db-verify.mjs runs it with VERIFY_ADMIN_URL (a server it may create databases on). It creates and drops its own
// scratch database and never touches anything else.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const adminUrl = process.env.VERIFY_ADMIN_URL;
if (!adminUrl) {
  console.error("upgrade test: VERIFY_ADMIN_URL is not set (run it through `npm run db:verify`).");
  process.exit(2);
}
const root = resolve(import.meta.dirname, "../../..");
const dbName = `concetto_upgrade16_${randomBytes(4).toString("hex")}`;
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
const B16 = migrations.filter((f) => /^20261006000018_/.test(f));
const B15 = migrations.filter((f) => !B16.includes(f) && f < "20261006000018"); // later migrations (B17+) are not part of this baseline
assert.equal(B16.length, 1, "the B16 migration");
assert.equal(B15.length, 17, "seventeen migrations existed at the B15 baseline");

const SUPER = "00000000-0000-0000-0000-0000000000a1";
const ADMIN = "00000000-0000-0000-0000-0000000000a2";
const team = (n) => `00000000-0000-0000-0000-00000000a${n}00`;
const member = (n, s) => `00000000-0000-0000-0000-00000000a${n}0${s}`;
const key = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const play = (n, k) => `
select public.unlock_theme('${team(n)}', '${member(n, 1)}', 1::smallint, '${key(k + 1)}');
select public.start_question('${team(n)}', '${member(n, 1)}', 1::smallint, '${key(k + 2)}');
select public.submit_answer('${team(n)}', '${member(n, 1)}', 1::smallint, 'ans', 'because', '${key(k + 3)}');
select public.approve_submission('${ADMIN}', (select id from submissions where team_id = '${team(n)}' and question_id = 1 and status = 'PENDING'), '${key(k + 4)}');`;

try {
  assert.equal(psql(adminUrl, ["-c", `create database ${dbName}`]).code, 0, "create database");

  // ---- 1. the B15 database -------------------------------------------------------------------------------------------
  for (const f of B15) {
    const r = psql(target, ["-f", join(root, "supabase/migrations", f)]);
    assert.equal(r.code, 0, `migration ${f}: ${r.err}`);
  }
  const seeded = psql(target, ["-f", join(root, "supabase/seed.sql")]);
  assert.equal(seeded.code, 0, `seed: ${seeded.err}`);

  // ---- 2. production-shaped data -------------------------------------------------------------------------------------
  //   U1 RUNNING, one approved question          U2 FINAL_SUBMITTED 90 min in, one approved question
  //   U3 ENDED by its timer (4 h)                U4 a legacy 2 h team ended by its timer
  //   U5 never started
  must(`
insert into staff_users (id, username, display_name, password_hash, role)
values ('${SUPER}', 'up_super', 'Upgrade Super', 'TEST-NOT-A-HASH', 'SUPER_ADMIN');
insert into staff_users (id, username, display_name, password_hash, role, created_by)
values ('${ADMIN}', 'up_admin', 'Upgrade Admin', 'TEST-NOT-A-HASH', 'ADMIN', '${SUPER}');
${[1, 2, 3, 4, 5]
  .map(
    (n) => `
insert into teams (id, team_code, name, login_id, password_hash, admin_id, coins)
values ('${team(n)}', 'U0${n}', 'Upgrade ${n}', 'up_team_${n}', 'TEST-NOT-A-HASH', '${ADMIN}', 500);
insert into coin_transactions (team_id, type, amount, balance_after, created_at) values ('${team(n)}', 'INITIAL_GRANT', 500, 500, now());
insert into team_members (id, team_id, slot, admission_no)
select ('00000000-0000-0000-0000-00000000a${n}0' || s)::uuid, '${team(n)}', s, 'UP${n}' || s from generate_series(1, 4) s;`,
  )
  .join("\n")}
update competition set status = 'RUNNING', opened_at = now() where id = 1;
${[1, 2, 3, 4].map((n) => `select public.start_team_competition('${team(n)}', '${member(n, 1)}', '${key(900 + n)}');`).join("\n")}
-- U2 started 90 minutes ago (4 h allowance)
update teams set started_at = now() - interval '90 minutes', ends_at = now() - interval '90 minutes' + interval '4 hours' where id = '${team(2)}';
${play(1, 100)}
${play(2, 200)}
select public.final_submit('${team(2)}', '${member(2, 1)}', true, '${key(299)}');
-- U3: started 5 h ago on a 4 h allowance -> past its end; the real sweeper function ends it at ends_at
update teams set started_at = now() - interval '5 hours', ends_at = now() - interval '1 hour' where id = '${team(3)}';
select public.finalize_team_if_due('${team(3)}');
-- U4: a legacy 2 h team started 3 h ago
update teams set timer_seconds = 7200, started_at = now() - interval '3 hours', ends_at = now() - interval '1 hour' where id = '${team(4)}';
select public.finalize_team_if_due('${team(4)}');
`);
  assert.deepEqual(rows(`select jsonb_object_agg(team_code, status) from teams`), {
    U01: "RUNNING",
    U02: "FINAL_SUBMITTED",
    U03: "ENDED",
    U04: "ENDED",
    U05: "NOT_STARTED",
  });
  assert.equal(
    must(`select count(*) from teams where final_score is not null`),
    "0",
    "B15 never wrote final_*",
  );

  const snapshot = () =>
    rows(
      `select jsonb_object_agg(team_code, to_jsonb(t) - 'final_score' - 'final_completed_themes' - 'final_solved_questions' - 'final_minutes_taken' - 'updated_at' - 'ufm_penalized_at' - 'ufm_penalized_by') from teams t`,
    );
  const before = snapshot();
  const ledgerBefore = must(
    `select md5(string_agg(id::text || ':' || team_id::text || ':' || type || ':' || amount || ':' || balance_after, ',' order by id)) from coin_transactions`,
  );

  // ---- 3. apply migration 18 ------------------------------------------------------------------------------------------
  const applied = psql(target, ["-f", join(root, "supabase/migrations", B16[0])]);
  assert.equal(applied.code, 0, `migration ${B16[0]}: ${applied.err}`);

  // ---- 4. what it did ------------------------------------------------------------------------------------------------
  const t =
    rows(`select jsonb_object_agg(team_code, jsonb_build_object('score', final_score, 'themes', final_completed_themes,
                    'solved', final_solved_questions, 'minutes', final_minutes_taken, 'coins', coins)) from teams`);
  assert.deepEqual(
    t.U01,
    { score: null, themes: null, solved: null, minutes: null, coins: 450 },
    "RUNNING: not written",
  );
  assert.deepEqual(
    t.U05,
    { score: null, themes: null, solved: null, minutes: null, coins: 500 },
    "NOT_STARTED: not written",
  );
  // U2: 500 - 100 unlock + 50 reward = 450 coins; 1 solved; 90 minutes -> 100 + 450 - 450 = 100
  assert.deepEqual(
    t.U02,
    { score: 100, themes: 0, solved: 1, minutes: 90, coins: 450 },
    "FINAL_SUBMITTED frozen at 90 minutes",
  );
  // U3: 4 h team ended at its end: 240 minutes; 500 coins -> 500 - 1200
  assert.deepEqual(
    t.U03,
    { score: -700, themes: 0, solved: 0, minutes: 240, coins: 500 },
    "ENDED (4 h) frozen at 240 minutes",
  );
  // U4: a 2 h legacy team: 120 minutes, not 240 -> 500 - 600
  assert.deepEqual(
    t.U04,
    { score: -100, themes: 0, solved: 0, minutes: 120, coins: 500 },
    "ENDED (2 h legacy) frozen at 120 minutes",
  );

  assert.deepEqual(snapshot(), before, "nothing else about any team changed");
  assert.equal(
    must(
      `select md5(string_agg(id::text || ':' || team_id::text || ':' || type || ':' || amount || ':' || balance_after, ',' order by id)) from coin_transactions`,
    ),
    ledgerBefore,
    "the ledger is untouched",
  );
  assert.equal(
    must(
      `select (payload->>'teams')::int from audit_events where event_type = 'SCORES_BACKFILLED'`,
    ),
    "3",
  );

  // the live team's derived score at this moment: 1 solved, 450 coins, a few seconds in -> 0 minutes
  const live = must(`select official_score from app.team_scores(now(), '${team(1)}')`);
  assert.equal(live, "550", "RUNNING team: derived (100 + 450, 0 minutes)");
  const staff = rows(`select public.get_leaderboard('${SUPER}')`);
  assert.deepEqual(
    staff.rows.map((r) => [r.rank, r.team_id, r.score]),
    [
      [1, "U01", 550],
      [2, "U02", 100],
      [3, "U04", -100],
      [4, "U03", -700],
      [5, "U05", 500],
    ],
    "started teams by score, the unstarted team last",
  );
  const p = rows(`select public.get_team_leaderboard('${team(3)}', '${member(3, 1)}')`);
  assert.deepEqual(p.me, { rank: 4, team_id: "U03", score: -700 });
  console.log(
    "ok    B16 upgrade: terminal teams frozen on the right basis, RUNNING / NOT_STARTED untouched, board ordered",
  );
} finally {
  psql(adminUrl, ["-c", `drop database if exists ${dbName} with (force)`]);
}
