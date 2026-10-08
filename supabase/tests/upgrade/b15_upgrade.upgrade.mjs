// Upgrade test for B15 (migrations 16 and 17) on a production-shaped database.
//
// The ordinary db:verify run applies every migration to an empty database, which cannot show what the timer migration
// does to teams that ALREADY started under the old 2-hour rule. This script builds a scratch database at the B14 state
// (migrations 1-15 + seed), recreates the production situation reported by the pre-flight, applies migrations 16 and 17,
// and asserts that:
//
//   - the competition default moves to 4 h while every started team keeps its 2 h allowance, started_at and ends_at;
//   - teams that never started are untouched apart from a state_version bump, and later get the 4 h allowance;
//   - nothing is extended: teams already past ends_at are finalized to ENDED with ended_at = ends_at (no revival);
//   - coins, the ledger and the hint prices are unchanged by the migrations (re-pricing is a separate, human-run script).
//
// scripts/db-verify.mjs runs it with VERIFY_ADMIN_URL (a server it may create databases on). It creates and drops its
// own scratch database and never touches anything else.
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
const dbName = `concetto_upgrade_${randomBytes(4).toString("hex")}`;
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
const B15 = migrations.filter((f) => /^2026100600001[67]_/.test(f));
const B14 = migrations.filter((f) => !B15.includes(f));
assert.equal(B15.length, 2, "the two B15 migrations");
assert.equal(B14.length, 15, "fifteen migrations existed at the B14 baseline");

const SUPER = "00000000-0000-0000-0000-0000000000a1";
const ADMIN = "00000000-0000-0000-0000-0000000000a2";
const team = (n) => `00000000-0000-0000-0000-00000000a${n}00`;
const member = (n, s) => `00000000-0000-0000-0000-00000000a${n}0${s}`;
const key = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let failed = false;
try {
  assert.equal(psql(adminUrl, ["-c", `create database ${dbName}`]).code, 0, "create database");

  // ---- 1. the B14 database -------------------------------------------------------------------------------------------
  for (const f of B14) {
    const r = psql(target, ["-f", join(root, "supabase/migrations", f)]);
    assert.equal(r.code, 0, `migration ${f}: ${r.err}`);
  }
  const seeded = psql(target, ["-f", join(root, "supabase/seed.sql")]);
  assert.equal(seeded.code, 0, `seed: ${seeded.err}`);
  // production hint prices before the human-run re-pricing: 40 / 80 (the seed now ships 20 / 40)
  must(`update hints set cost = case tier when 1 then 40 else 80 end`);

  // ---- 2. production-shaped data: 4 teams not started + TEST_2 / TEST_3 running and already past their end ---------------
  must(`
insert into staff_users (id, username, display_name, password_hash, role)
values ('${SUPER}', 'up_super', 'Upgrade Super', 'TEST-NOT-A-HASH', 'SUPER_ADMIN');
insert into staff_users (id, username, display_name, password_hash, role, created_by)
values ('${ADMIN}', 'up_admin', 'Upgrade Admin', 'TEST-NOT-A-HASH', 'ADMIN', '${SUPER}');
${[1, 2, 3, 4, 5, 6]
  .map(
    (n) => `
insert into teams (id, team_code, name, login_id, password_hash, admin_id, coins)
values ('${team(n)}', 'U0${n}', 'Upgrade ${n}', 'up_team_${n}', 'TEST-NOT-A-HASH', '${ADMIN}', 500);
insert into coin_transactions (team_id, type, amount, balance_after, created_at) values ('${team(n)}', 'INITIAL_GRANT', 500, 500, now());
insert into team_members (id, team_id, slot, admission_no)
select ('00000000-0000-0000-0000-00000000a${n}0' || s)::uuid, '${team(n)}', s, 'UP${n}' || s from generate_series(1, 4) s;`,
  )
  .join("\n")}
-- TEST_2 spent 50 coins and TEST_3 spent 450 (ledger rows keep the chain valid)
insert into coin_transactions (team_id, type, amount, balance_after, staff_id, created_at) values ('${team(5)}', 'ADMIN_ADJUSTMENT', -50, 450, '${ADMIN}', now());
update teams set coins = 450 where id = '${team(5)}';
insert into coin_transactions (team_id, type, amount, balance_after, staff_id, created_at) values ('${team(6)}', 'ADMIN_ADJUSTMENT', -450, 50, '${ADMIN}', now());
update teams set coins = 50 where id = '${team(6)}';
update competition set status = 'RUNNING', opened_at = now() where id = 1;
`);
  // teams 5 and 6 start through the real (old) function, then their window is moved into the past
  for (const n of [5, 6]) {
    must(
      `select public.start_team_competition('${team(n)}', '${member(n, 1)}', '${key(100 + n)}')`,
    );
  }
  must(`
update teams set started_at = now() - interval '9 hours', ends_at = now() - interval '7 hours' where id = '${team(5)}';
update teams set started_at = now() - interval '5 hours', ends_at = now() - interval '3 hours' where id = '${team(6)}';
`);
  assert.equal(
    must(`select ultimate_seconds from competition where id = 1`),
    "7200",
    "the B14 database runs on 2 h",
  );

  const snapshot = () => rows(`select jsonb_object_agg(id, to_jsonb(t)) from teams t`);
  const before = snapshot();
  const competitionBefore = rows(`select to_jsonb(c) from competition c where id = 1`);
  const ledgerBefore = must(
    `select md5(string_agg(id::text || ':' || team_id::text || ':' || type || ':' || amount || ':' || balance_after, ',' order by id)) from coin_transactions`,
  );
  const hintsBefore = must(`select md5(string_agg(id || ':' || cost, ',' order by id)) from hints`);
  const auditBefore = Number(must(`select count(*) from audit_events`));

  // ---- 3. apply B15 --------------------------------------------------------------------------------------------------------
  for (const f of B15) {
    const r = psql(target, ["-f", join(root, "supabase/migrations", f)]);
    assert.equal(r.code, 0, `migration ${f}: ${r.err}`);
  }
  const after = snapshot();

  // ---- 4. assertions -------------------------------------------------------------------------------------------------------
  const competition = rows(`select to_jsonb(c) from competition c where id = 1`);
  assert.equal(competition.ultimate_seconds, 14400, "the competition default is now 4 h");
  assert.equal(competition.status, competitionBefore.status);
  console.log("ok    competition.ultimate_seconds 7200 -> 14400, status unchanged");

  const strip = (row, ...cols) =>
    Object.fromEntries(Object.entries(row).filter(([k]) => !cols.includes(k)));
  for (const n of [5, 6]) {
    const b = before[team(n)];
    const a = after[team(n)];
    assert.equal(a.timer_seconds, 7200, `team ${n} keeps its 2 h allowance`);
    assert.deepEqual(
      strip(a, "timer_seconds", "updated_at"),
      strip(b, "updated_at"),
      `team ${n}: no column other than timer_seconds changed`,
    );
    assert.equal(a.started_at, b.started_at);
    assert.equal(a.ends_at, b.ends_at);
    assert.equal(a.status, "RUNNING", "still RUNNING until a finalizer processes it");
  }
  console.log(
    "ok    started teams: timer_seconds = 7200, started_at / ends_at / coins / state_version untouched",
  );

  for (const n of [1, 2, 3, 4]) {
    const b = before[team(n)];
    const a = after[team(n)];
    assert.equal(a.timer_seconds, null);
    assert.equal(
      a.state_version,
      b.state_version + 1,
      "NOT_STARTED teams get one state_version bump",
    );
    assert.deepEqual(
      strip(a, "state_version", "updated_at", "timer_seconds"),
      strip(b, "state_version", "updated_at"),
    );
  }
  console.log(
    "ok    NOT_STARTED teams: only state_version +1 (clients refresh their start screen)",
  );

  assert.equal(
    must(
      `select md5(string_agg(id::text || ':' || team_id::text || ':' || type || ':' || amount || ':' || balance_after, ',' order by id)) from coin_transactions`,
    ),
    ledgerBefore,
    "the ledger is unchanged",
  );
  assert.equal(
    must(`select md5(string_agg(id || ':' || cost, ',' order by id)) from hints`),
    hintsBefore,
    "hint prices are NOT changed by the migrations",
  );
  assert.equal(
    must(`select count(*) from app.invariant_coin_balance_mismatch`),
    "0",
    "coins still equal the ledger",
  );
  assert.equal(
    Number(must(`select count(*) from audit_events`)),
    auditBefore + 1,
    "exactly one audit row was added (TIMER_CONFIG_CHANGED)",
  );
  assert.equal(
    must(`select count(*) from audit_events where event_type = 'TIMER_CONFIG_CHANGED'`),
    "1",
  );
  console.log("ok    ledger, coins and hint prices unchanged; one TIMER_CONFIG_CHANGED audit row");

  // the lazy path: a read never mutates, and reports the old teams as expired and frozen at 7200 s
  const readState = rows(`select public.get_team_state('${team(5)}', '${member(5, 1)}')`);
  assert.equal(readState.team.duration_seconds, 7200);
  assert.equal(readState.team.expired, true);
  assert.equal(readState.team.frozen, true);
  assert.equal(
    must(`select status from teams where id = '${team(5)}'`),
    "RUNNING",
    "get_team_state is read-only",
  );

  // finalization: ENDED with ended_at = ends_at (no extension, no revival), coins untouched
  const fin = rows(`select public.finalize_team_if_due('${team(5)}')`);
  assert.deepEqual([fin.finalized, fin.status], [true, "ENDED"]);
  const swept = must(`select public.expire_due_teams(50)`);
  assert.equal(swept, "1", "the sweeper finalizes the other overdue team (TEST_3)");
  assert.equal(must(`select public.expire_due_teams(50)`), "0", "and is idempotent");
  for (const n of [5, 6]) {
    const r = rows(`select to_jsonb(t) from teams t where id = '${team(n)}'`);
    assert.equal(r.status, "ENDED");
    assert.equal(r.ended_at, before[team(n)].ends_at, `team ${n}: ended_at = the original ends_at`);
    assert.equal(r.coins, before[team(n)].coins, `team ${n}: coins unchanged`);
    assert.equal(r.timer_seconds, 7200);
    assert.equal(
      rows(
        `select count(*) from audit_events where team_id = '${team(n)}' and event_type = 'TEAM_ENDED'`,
      ),
      1,
    );
  }
  assert.equal(must(`select count(*) from app.invariant_coin_balance_mismatch`), "0");
  console.log(
    "ok    TEST_2 / TEST_3 shape: finalized to ENDED with ended_at = ends_at, coins untouched, no extension",
  );

  // a team that starts now gets the new allowance
  const started = rows(
    `select public.start_team_competition('${team(1)}', '${member(1, 1)}', '${key(901)}')`,
  );
  assert.equal(started.state.team.duration_seconds, 14400);
  const t1 = rows(`select to_jsonb(t) from teams t where id = '${team(1)}'`);
  assert.equal(t1.timer_seconds, 14400);
  assert.equal(
    must(`select extract(epoch from ends_at - started_at)::int from teams where id = '${team(1)}'`),
    "14400",
  );
  console.log("ok    a newly started team gets 14400 s");

  // the human-run re-pricing script is a separate file; the shipped seed must agree with its target prices
  assert.equal(
    must(`select count(*) from hints where (tier = 1 and cost = 40) or (tier = 2 and cost = 80)`),
    "100",
    "production still holds the old prices until the separate script is run by a human",
  );
  console.log(
    "ok    hint prices still 40/80: re-pricing is deliberately not part of the migrations",
  );
} catch (e) {
  failed = true;
  console.error(`FAIL  upgrade test\n${e?.stack ?? e}`);
} finally {
  psql(adminUrl, ["-c", `drop database if exists ${dbName} with (force)`]);
}
if (failed) process.exit(1);
console.log("upgrade tests passed");
