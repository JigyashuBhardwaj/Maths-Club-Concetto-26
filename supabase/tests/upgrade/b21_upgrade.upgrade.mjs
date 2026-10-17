// B20 upgrade test: a production-shaped database at the B18 state (migrations 1-20 + the seed, teams with real history) is upgraded by
// migration 21. It proves that the upgrade itself changes NO existing row (the only schema change is the new nullable
// competition.rules column, which stays NULL), that no table, constraint or trigger is added or altered apart from that column and
// its one CHECK, that the built-in rules therefore stay in force until the first renewal, and that on the upgraded data a renewal
// removes every admin and team, publishes the new content, resets the lifecycle and leaves a database a new competition can use.
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
const dbName = `concetto_upgrade21_${randomBytes(4).toString("hex")}`;
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
  return {
  code: r.status,
  out: (r.stdout ?? "").replace(/\r\n/g, "\n").trim(),
  err: (r.stderr ?? "").trim(),
};
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
const B21 = migrations.filter((f) => /^20261006000021_/.test(f));
const BEFORE = migrations.filter((f) => f < "20261006000021");
assert.equal(B21.length, 1, "migration 21 exists exactly once");
assert.equal(BEFORE.length, 20, "twenty migrations existed at the B18 baseline");

const SUPER = "00000000-0000-0000-0000-0000000000a1";
const A1 = "00000000-0000-0000-0000-0000000000a2";
const A2 = "00000000-0000-0000-0000-0000000000a3";
const team = (n) => `00000000-0000-0000-0000-00000000a${n}00`;
const member = (n, s) => `00000000-0000-0000-0000-00000000a${n}0${s}`;
const key = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T0 = "2026-12-01 12:00:00+00";

const TABLES = [
  ["teams", "x.id"],
  ["team_members", "x.id"],
  ["staff_users", "x.id"],
  ["submissions", "x.id"],
  ["sessions", "x.id"],
  ["team_themes", "x.team_id, x.theme_id"],
  ["team_questions", "x.team_id, x.question_id"],
  ["hint_purchases", "x.team_id, x.hint_id"],
  ["answer_drafts", "x.team_id, x.question_id"],
  ["team_time_purchases", "x.team_id, x.question_id, x.seq"],
  ["coin_transactions", "x.id"],
  ["audit_events", "x.id"],
  ["request_log", "x.team_id, x.idem_key"],
  ["themes", "x.id"],
  ["questions", "x.id"],
  ["hints", "x.id"],
  ["question_buy_time_options", "x.id"],
  ["question_keys", "x.question_id"],
];
const fingerprint = (table, order) =>
  must(
    `select coalesce(md5(string_agg(to_jsonb(x)::text, ',' order by ${order})), 'empty') || ':' || count(*) from ${table} x`,
  );
const allRows = () => Object.fromEntries(TABLES.map(([t, o]) => [t, fingerprint(t, o)]));
// the competition row, WITHOUT the column migration 21 adds
const competitionRow = () => must(`select (to_jsonb(c) - 'rules')::text from competition c`);
const STRUCTURE = () =>
  must(`select md5(string_agg(x, E'\n' order by x)) || ':' || count(*) from (
    select 'T ' || table_name as x from information_schema.tables where table_schema = 'public'
    union all select 'C ' || conrelid::regclass || '.' || conname || ' ' || pg_get_constraintdef(oid) from pg_constraint
               where connamespace = 'public'::regnamespace and conname <> 'competition_rules_shape'
    union all select 'G ' || tgrelid::regclass || '.' || tgname || ' ' || tgenabled::text from pg_trigger where not tgisinternal
    union all select 'K ' || table_name || '.' || column_name || ' ' || data_type from information_schema.columns
               where table_schema = 'public' and not (table_name = 'competition' and column_name = 'rules')
    union all select 'R ' || relname || ' ' || relrowsecurity::text || relforcerowsecurity::text from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'
  ) q`);

try {
  assert.equal(psql(adminUrl, ["-c", `create database ${dbName}`]).code, 0, "create database");

  // ---- 1. a B18 database with production-shaped data -----------------------------------------------------------------------
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
insert into teams (id, team_code, name, login_id, password_hash, admin_id, coins)
select ('00000000-0000-0000-0000-00000000a' || n || '00')::uuid, 'U0' || n, 'Upgrade Team ' || n, 'up_team_' || n, 'TEST-NOT-A-HASH',
       case when n = 1 then '${A1}'::uuid else '${A2}'::uuid end, 500 from generate_series(1, 2) n;
insert into team_members (id, team_id, slot, admission_no)
select ('00000000-0000-0000-0000-00000000a' || n || '0' || s)::uuid, ('00000000-0000-0000-0000-00000000a' || n || '00')::uuid, s, 'UP' || n || s
  from generate_series(1, 2) n cross join generate_series(1, 4) s;
insert into coin_transactions (team_id, type, amount, balance_after, created_at)
select ('00000000-0000-0000-0000-00000000a' || n || '00')::uuid, 'INITIAL_GRANT', 500, 500, now() from generate_series(1, 2) n;
select public.set_competition_status('${SUPER}', 'open', '${key(1)}');
select public.start_team_competition('${team(1)}', '${member(1, 1)}', '${key(2)}');
select public.start_team_competition('${team(2)}', '${member(2, 1)}', '${key(3)}');
select public.unlock_theme('${team(1)}', '${member(1, 1)}', 1::smallint, '${key(4)}');
select public.start_question('${team(1)}', '${member(1, 1)}', 1::smallint, '${key(5)}');
select public.submit_answer('${team(1)}', '${member(1, 1)}', 1::smallint, 'ans', 'because', '${key(6)}');
select public.set_competition_status('${SUPER}', 'end', '${key(7)}');
`);
  assert.equal(num(`select count(*) from teams where status = 'ENDED'`), 2, "both teams ended");
  assert.equal(num(`select count(*) from submissions where status = 'PENDING'`), 1);

  const rowsBefore = allRows();
  const compBefore = competitionRow();
  const structBefore = STRUCTURE();

  // ---- 2. migration 21 changes nothing that exists ---------------------------------------------------------------------------
  const applied = psql(target, ["-f", join(root, "supabase/migrations", B21[0])]);
  assert.equal(applied.code, 0, `migration 21: ${applied.err}`);
  assert.deepEqual(allRows(), rowsBefore, "no row of any table changed");
  assert.equal(
    competitionRow(),
    compBefore,
    "the competition row is unchanged apart from the new column",
  );
  assert.equal(STRUCTURE(), structBefore, "no table, constraint, trigger or other column changed");
  assert.equal(
    must(`select rules is null from competition`),
    "t",
    "rules is NULL: the built-in rules stay in force",
  );
  assert.equal(
    num(
      `select count(*) from information_schema.columns where table_name = 'competition' and column_name = 'rules'`,
    ),
    1,
  );
  assert.equal(must(`select (public.get_competition_rules() -> 'rules') = 'null'::jsonb`), "t");
  console.log(
    "ok    B18 database + migration 21 -> no row changed, one nullable column, rules NULL",
  );

  // ---- 3. a renewal on the upgraded data ------------------------------------------------------------------------------------
  const content = must(`select public.get_renewal_content('${SUPER}')`);
  const parsed = JSON.parse(content);
  assert.equal(parsed.readiness.ready, true, "ended teams do not block");
  assert.equal(parsed.readiness.pending_submissions, 1);
  const settingsBefore = must(
    `select md5(string_agg(x, ',' order by x)) from (select concat_ws(',', id, code, difficulty, unlock_cost, display_order) x from themes
       union all select concat_ws(',', id, difficulty, time_limit_seconds) from questions
       union all select concat_ws(',', id, cost) from hints) s`,
  );
  const edited = JSON.parse(JSON.stringify(parsed.content));
  edited.themes[0].name = "UPGRADED THEME A";
  edited.themes[3].questions[2].question = "Line 1\nLine 2 — ünï";
  edited.themes[3].questions[2].reward = 321;
  edited.rules = ["The only rule."];
  const out = must(
    `select public.renew_competition('${SUPER}', $c$${JSON.stringify(edited)}$c$::jsonb, '${parsed.token}', '${key(20)}')`,
  );
  const result = JSON.parse(out);
  assert.deepEqual(result.deleted, { admins: 2, teams: 2 });
  assert.equal(num(`select count(*) from staff_users`), 1, "only the Super Admin remains");
  assert.equal(num(`select count(*) from teams`), 0);
  for (const t of [
    "team_members",
    "team_themes",
    "team_questions",
    "submissions",
    "coin_transactions",
    "answer_drafts",
    "hint_purchases",
    "team_time_purchases",
    "sessions",
  ])
    assert.equal(num(`select count(*) from ${t}`), 0, `${t} is empty`);
  assert.equal(must(`select name from themes where id = 1`), "UPGRADED THEME A");
  assert.equal(must(`select body_md from questions where id = 18`), "Line 1\nLine 2 — ünï");
  assert.equal(num(`select reward_coins from questions where id = 18`), 321);
  assert.equal(must(`select rules ->> 0 from competition`), "The only rule.");
  assert.equal(must(`select status from competition`), "SETUP");
  assert.equal(
    must(
      `select md5(string_agg(x, ',' order by x)) from (select concat_ws(',', id, code, difficulty, unlock_cost, display_order) x from themes
       union all select concat_ws(',', id, difficulty, time_limit_seconds) from questions
       union all select concat_ws(',', id, cost) from hints) s`,
    ),
    settingsBefore,
    "ids, difficulty, prices and timers are unchanged",
  );
  assert.equal(
    num(`select count(*) from audit_events where event_type = 'COMPETITION_RENEWED'`),
    1,
  );
  assert.equal(
    num(`select count(*) from audit_events where event_type = 'TEAM_DELETED'`),
    2,
    "the audit trail kept the deletions",
  );
  // the next competition: provision and open with the existing workflow
  must(
    `select public.create_admin('${SUPER}', 'next_up_admin', 'next-admin-password', '${key(21)}')`,
  );
  must(
    `select public.create_team((select id from staff_users where username = 'next_up_admin'), 'NX1', 'Next', 'next_up_team', 'next-team-password', array['NU1','NU2','NU3','NU4'], '${key(22)}')`,
  );
  assert.equal(
    must(
      `select (public.set_competition_status('${SUPER}', 'open', '${key(23)}') -> 'competition' ->> 'status')`,
    ),
    "RUNNING",
  );
  console.log(
    "ok    renewal on the upgraded database: everything removed, content published, next competition provisioned and opened",
  );
  console.log(
    "B21 upgrade: B18 database + migration 21 -> nothing changed; a renewal then works end to end",
  );
} finally {
  psql(adminUrl, ["-c", `drop database if exists ${dbName} with (force)`]);
}
