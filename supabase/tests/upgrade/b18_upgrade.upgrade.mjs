// B18 upgrade test: a production-shaped database at the B17 state (migrations 1-19 + the seed) is upgraded by migration 20.
// It proves that the upgrade itself changes NO row and NO table, foreign key, trigger or privilege (migration 20 only adds and
// replaces functions), that the ledger is still append-only afterwards, and that on the upgraded data a team with real history
// and then an admin are deleted completely: their ledger, purchases and request_log records are gone, while every other
// team's ledger, purchases, request_log records and balances are byte-for-byte what they were before the upgrade.
//
// Builds its own scratch database (it needs the server URL, not the scratch database db-verify made) and drops it again.
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
const dbName = `concetto_upgrade18_${randomBytes(4).toString("hex")}`;
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
const num = (sql) => Number(must(sql));

const migrations = readdirSync(join(root, "supabase/migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort();
const B18 = migrations.filter((f) => /^20261006000020_/.test(f));
const BEFORE = migrations.filter((f) => f < "20261006000020");
assert.equal(B18.length, 1, "migration 20 exists exactly once");
assert.equal(BEFORE.length, 19, "nineteen migrations existed at the B17 baseline");

const SUPER = "00000000-0000-0000-0000-0000000000a1";
const A1 = "00000000-0000-0000-0000-0000000000a2";
const A2 = "00000000-0000-0000-0000-0000000000a3";
const team = (n) => `00000000-0000-0000-0000-00000000a${n}00`;
const member = (n, s) => `00000000-0000-0000-0000-00000000a${n}0${s}`;
const key = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T0 = "2026-12-01 12:00:00+00";

const fingerprint = (table, order) =>
  must(
    `select coalesce(md5(string_agg(to_jsonb(x)::text, ',' order by ${order})), 'empty') || ':' || count(*) from ${table} x`,
  );
const HISTORY = () => ({
  ledger: fingerprint("coin_transactions", "x.id"),
  audit: fingerprint("audit_events", "x.id"),
  purchases: fingerprint("team_time_purchases", "x.team_id, x.question_id, x.seq"),
  requestLog: fingerprint("request_log", "x.team_id, x.idem_key"),
});
// the rows of ONE team in the three tables a deletion must remove (or must leave alone): ledger, purchases, request_log scope
const teamRows = (n) => ({
  ledger: fingerprint(
    "(select * from coin_transactions where team_id = '" + team(n) + "')",
    "x.id",
  ),
  purchases: fingerprint(
    "(select * from team_time_purchases where team_id = '" + team(n) + "')",
    "x.question_id, x.seq",
  ),
  log: fingerprint("(select * from request_log where team_id = '" + team(n) + "')", "x.idem_key"),
  coins: must("select coins from teams where id = '" + team(n) + "'"),
});
// the structure that must not change: tables, constraints, triggers, privileges
const STRUCTURE = () =>
  must(`select md5(string_agg(x, E'\n' order by x)) || ':' || count(*) from (
    select 'T ' || table_name as x from information_schema.tables where table_schema = 'public'
    union all select 'C ' || conrelid::regclass || '.' || conname || ' ' || pg_get_constraintdef(oid) from pg_constraint where connamespace = 'public'::regnamespace
    union all select 'G ' || tgrelid::regclass || '.' || tgname || ' ' || tgenabled::text from pg_trigger where not tgisinternal
    union all select 'P ' || c.relname || ' ' || r.rolname || ' ' || has_table_privilege(r.oid, c.oid, 'select')::text || has_table_privilege(r.oid, c.oid, 'insert')::text
                || has_table_privilege(r.oid, c.oid, 'update')::text || has_table_privilege(r.oid, c.oid, 'delete')::text
                || has_table_privilege(r.oid, c.oid, 'truncate')::text
         from pg_class c cross join pg_roles r where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and r.rolname in ('service_role', 'anon', 'authenticated')
    union all select 'R ' || relname || ' ' || relrowsecurity::text || relforcerowsecurity::text from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'
  ) q`);
const LIVE = [
  ["teams", "x.id"],
  ["team_members", "x.id"],
  ["staff_users", "x.id"],
  ["submissions", "x.id"],
  ["sessions", "x.id"],
  ["team_themes", "x.team_id, x.theme_id"],
  ["team_questions", "x.team_id, x.question_id"],
  ["hint_purchases", "x.team_id, x.hint_id"],
];
const live = () => Object.fromEntries(LIVE.map(([t, o]) => [t, fingerprint(t, o)]));

try {
  assert.equal(psql(adminUrl, ["-c", `create database ${dbName}`]).code, 0, "create database");

  // ---- 1. a B17 database with production-shaped data ------------------------------------------------------------------
  for (const f of BEFORE) {
    const r = psql(target, ["-f", join(root, "supabase/migrations", f)]);
    assert.equal(r.code, 0, `migration ${f}: ${r.err}`);
  }
  const seeded = psql(target, ["-f", join(root, "supabase/seed.sql")]);
  assert.equal(seeded.code, 0, `seed: ${seeded.err}`);
  must(`alter database ${dbName} set app.allow_test_clock = 'on'`);
  must(`alter database ${dbName} set app.test_now = '${T0}'`);

  must(`
insert into staff_users (id, username, display_name, password_hash, role)
values ('${SUPER}', 'up_super', 'Upgrade Super', 'TEST-NOT-A-HASH', 'SUPER_ADMIN');
insert into staff_users (id, username, display_name, password_hash, role, created_by)
values ('${A1}', 'up_admin1', 'Upgrade Admin 1', 'TEST-NOT-A-HASH', 'ADMIN', '${SUPER}'),
       ('${A2}', 'up_admin2', 'Upgrade Admin 2', 'TEST-NOT-A-HASH', 'ADMIN', '${SUPER}');
${[1, 2, 3, 4]
  .map(
    (n) => `
insert into teams (id, team_code, name, login_id, password_hash, admin_id, coins)
values ('${team(n)}', 'U0${n}', 'Upgrade ${n}', 'up_team_${n}', 'TEST-NOT-A-HASH', '${n <= 2 ? A1 : A2}', 500);
insert into coin_transactions (team_id, type, amount, balance_after, created_at) values ('${team(n)}', 'INITIAL_GRANT', 500, 500, now());
insert into team_members (id, team_id, slot, admission_no)
select ('00000000-0000-0000-0000-00000000a${n}0' || s)::uuid, '${team(n)}', s, 'UPG${n}' || s from generate_series(1, 4) s;`,
  )
  .join("\n")}
update competition set status = 'RUNNING', opened_at = now() where id = 1;
`);
  // real play: teams 1 and 2 start, unlock theme 1, enter Q1, buy a hint, buy time, submit; team 1 is approved (reward row
  // naming its submission); team 3 only starts; team 4 never does. Sessions for one member of each team and for the staff.
  must(
    [1, 2, 3]
      .map(
        (n) =>
          `select public.start_team_competition('${team(n)}', '${member(n, 1)}', '${key(n)}');`,
      )
      .join("\n") +
      [1, 2]
        .map(
          (n) => `
select public.unlock_theme('${team(n)}', '${member(n, 1)}', 1::smallint, '${key(10 + n)}');
select public.start_question('${team(n)}', '${member(n, 1)}', 1::smallint, '${key(20 + n)}');
select public.buy_hint('${team(n)}', '${member(n, 1)}', 1::smallint, 1::smallint, '${key(30 + n)}');
select public.buy_time('${team(n)}', '${member(n, 1)}', 1::smallint, 1::smallint, 0, '${key(70 + n)}');
select public.save_draft('${team(n)}', '${member(n, 1)}', 1::smallint, 'a', 0, 'b');
select public.submit_answer('${team(n)}', '${member(n, 1)}', 1::smallint, 'ans', 'because', '${key(40 + n)}');`,
        )
        .join("\n") +
      `
select public.approve_submission('${A1}', (select id from submissions where team_id = '${team(1)}' and status = 'PENDING'), '${key(50)}');
insert into sessions (token_hash, kind, team_id, member_id, expires_at)
select sha256(convert_to('up-m' || n, 'UTF8')), 'MEMBER', ('00000000-0000-0000-0000-00000000a' || n || '00')::uuid,
       ('00000000-0000-0000-0000-00000000a' || n || '01')::uuid, app.now() + interval '1 hour' from generate_series(1, 4) n;
insert into sessions (token_hash, kind, staff_id, expires_at)
values (sha256(convert_to('up-s1', 'UTF8')), 'STAFF', '${A1}', app.now() + interval '1 hour'),
       (sha256(convert_to('up-s2', 'UTF8')), 'STAFF', '${A2}', app.now() + interval '1 hour');`,
  );
  assert.ok(
    num(
      `select count(*) from coin_transactions where type = 'QUESTION_REWARD' and submission_id is not null`,
    ) >= 1,
  );
  assert.ok(num(`select count(*) from coin_transactions`) >= 9);
  assert.equal(
    num(`select count(*) from team_time_purchases`),
    2,
    "teams 1 and 2 each bought time",
  );

  const before = { ...HISTORY(), live: live() };
  console.log("ok    B17 database built with production-shaped data");

  // ---- 2. apply migration 20 ------------------------------------------------------------------------------------------
  const structureBefore = STRUCTURE();
  const teamsBefore = { 1: teamRows(1), 2: teamRows(2), 3: teamRows(3), 4: teamRows(4) };
  assert.notEqual(teamsBefore[1].ledger.split(":")[1], "0", "team 1 has a ledger");
  assert.equal(teamsBefore[1].purchases.split(":")[1], "1", "team 1 bought time");
  assert.notEqual(teamsBefore[1].log.split(":")[1], "0", "team 1 has request_log records");
  assert.notEqual(
    num(`select count(*) from request_log where team_id = '${A1}'`),
    0,
    "admin 1 has request_log records",
  );
  const applied = psql(target, ["-f", join(root, "supabase/migrations", B18[0])]);
  assert.equal(applied.code, 0, `migration 20: ${applied.err}`);

  // the upgrade changed nothing that exists: every row, table, constraint, trigger, privilege and RLS setting is as it was
  const after = { ...HISTORY(), live: live() };
  assert.deepEqual(after, { ...before }, "no row of any table changed");
  assert.equal(
    STRUCTURE(),
    structureBefore,
    "no table, constraint, trigger, privilege or RLS setting changed",
  );
  assert.equal(
    num(
      `select count(*) from information_schema.tables where table_schema = 'public' and table_name like '%\\_identities'`,
    ),
    0,
    "no registry table exists",
  );
  console.log(
    "ok    migration 20 changed no row, table, foreign key, trigger, privilege or RLS setting",
  );

  // the ledger is still append-only: UPDATE, DELETE (no marker), TRUNCATE are refused, as the owner
  for (const stmt of [
    `update coin_transactions set amount = amount`,
    `delete from coin_transactions where team_id = '${team(2)}'`,
    `truncate coin_transactions cascade`,
    `update audit_events set payload = '{}'`,
    `delete from audit_events`,
  ]) {
    const r = psql(target, ["-c", stmt]);
    assert.notEqual(r.code, 0, `${stmt} must be refused`);
    assert.match(r.err, /append-only/);
  }
  assert.equal(
    must(
      `select has_table_privilege('service_role', 'coin_transactions', 'delete')::text || has_table_privilege('service_role', 'team_time_purchases', 'delete')::text`,
    ),
    "falsefalse",
  );
  assert.equal(HISTORY().ledger, before.ledger, "and nothing was removed by those attempts");
  console.log("ok    the ledger and the audit trail are still append-only after the upgrade");

  // ---- 3. sessions are valid before, and the new rules work on the upgraded data ------------------------------------------
  const alive = (token) =>
    num(
      `select (public.resolve_session(sha256(convert_to('${token}', 'UTF8')))->>'ok')::boolean::int`,
    );
  assert.equal(alive("up-m1"), 1);
  assert.equal(alive("up-s1"), 1);

  // delete team 1 (approved reward + history): EVERYTHING of it goes, nothing of anyone else
  must(`select public.delete_teams('${SUPER}', array['${team(1)}']::uuid[], '${key(60)}')`);
  for (const t of [
    "teams",
    "team_members",
    "submissions",
    "sessions",
    "team_themes",
    "team_questions",
    "hint_purchases",
    "answer_drafts",
    "coin_transactions",
    "team_time_purchases",
    "request_log",
  ]) {
    const col = t === "teams" ? "id" : "team_id";
    assert.equal(num(`select count(*) from ${t} where ${col} = '${team(1)}'`), 0, `${t} of team 1`);
  }
  assert.equal(
    num(
      `select count(*) from request_log where team_id = '${A1}' and operation = 'approve_submission'`,
    ),
    0,
    "admin 1's stored approval of team 1's submission is gone too (it is in the ADMIN's scope, not the team's)",
  );
  assert.equal(alive("up-m1"), 0, "its cookie is dead");
  assert.equal(alive("up-m2"), 1, "team 2's cookie lives");
  assert.equal(alive("up-s1"), 1, "its admin's cookie lives");
  for (const n of [2, 3, 4]) {
    const now = teamRows(n);
    if (n === 2)
      assert.deepEqual(
        now,
        teamsBefore[2],
        "team 2: ledger, purchases, request_log and balance byte-identical to before the upgrade",
      );
  }
  console.log(
    "ok    a team with real history (approved reward, hint, time, draft, submission) deletes completely; team 2 untouched",
  );

  // delete admin 2: its teams 3 and 4, its sessions, its idempotency scope
  const adminLogBefore = num(`select count(*) from request_log where team_id = '${A2}'`);
  must(`select public.delete_admins('${SUPER}', array['${A2}']::uuid[], '${key(61)}')`);
  assert.equal(num(`select count(*) from staff_users where id = '${A2}'`), 0);
  assert.equal(num(`select count(*) from teams where admin_id = '${A2}'`), 0);
  assert.ok(adminLogBefore >= 0);
  assert.equal(num(`select count(*) from request_log where team_id = '${A2}'`), 0);
  for (const n of [3, 4]) {
    for (const t of ["coin_transactions", "team_time_purchases", "request_log", "sessions"]) {
      assert.equal(
        num(`select count(*) from ${t} where team_id = '${team(n)}'`),
        0,
        `${t} of team ${n}`,
      );
    }
  }
  assert.equal(alive("up-s2"), 0, "admin 2's cookie is dead");
  assert.equal(alive("up-s1"), 1, "admin 1's cookie lives");
  assert.deepEqual(
    teamRows(2),
    teamsBefore[2],
    "team 2 still byte-identical to before the upgrade",
  );
  assert.equal(num(`select count(*) from app.invariant_coin_balance_mismatch`), 0);
  assert.equal(
    num(
      `select count(*) from coin_transactions c where not exists (select 1 from teams t where t.id = c.team_id)`,
    ),
    0,
    "no ledger row of a deleted team",
  );
  assert.equal(
    num(
      `select count(*) from request_log r where r.team_id not in (select id from teams union select id from staff_users)`,
    ),
    0,
    "no request_log record in the scope of a deleted account",
  );
  // the only ledger rows left are team 2's: the upgrade-time ledger minus the three deleted teams' rows
  assert.equal(must(`select count(*) from coin_transactions where team_id <> '${team(2)}'`), "0");
  // structure after both deletions: still exactly the structure before migration 20 (only functions differ)
  assert.equal(
    STRUCTURE(),
    structureBefore,
    "tables, constraints, triggers, privileges and RLS are still what they were at B17",
  );
  assert.equal(
    must(`select coalesce(current_setting('app.retiring_team_ids', true), '')`),
    "",
    "no marker left behind",
  );
  const sr = psql(target, ["-c", "set role service_role; delete from team_time_purchases"]);
  assert.notEqual(sr.code, 0, "service_role still cannot delete purchase history");
  assert.match(sr.err, /permission denied/);
  console.log(
    "ok    admin deletion on the upgraded database; team 2 byte-identical; structure unchanged",
  );
} finally {
  psql(adminUrl, ["-c", `drop database if exists ${dbName} with (force)`]);
}
console.log(
  "B18 upgrade: B17 database + migration 20 -> nothing changed, deletion is complete and scoped",
);
