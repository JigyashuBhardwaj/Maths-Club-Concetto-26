// Multi-connection tests for migration 21 ("Renew the Competition"). Named zz_* so it sorts LAST: it renews (= deletes every Admin and
// Team of) the scratch database, which the other concurrency scripts must not see half-way. Like them it uses several `psql` processes
// against the scratch database that scripts/db-verify.mjs created (VERIFY_DB_URL) and commits its own rows. Each writing session holds
// its locks for ~1 s (`pg_sleep` inside the transaction), so the others genuinely queue on them.
//
//   A. a double click / retry storm: two concurrent renewals with ONE key           -> one renewal, one replay, one audit row
//   B. a second browser tab: two concurrent renewals, DIFFERENT keys and content    -> one wins, the other is CONTENT_CHANGED
//   C. renewal races the Admin's own create_team, and the Super Admin's create_admin
//                                                                                    -> no orphan team; the new admin survives
//   D. renewal races a reviewer's approval (both orders)
//                                                                                    -> approval first: the team is solving again, so the renewal
//                                                                                       is BLOCKED and nothing is deleted; renewal first: the approval
//                                                                                       is refused (its admin and team are gone)
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const url = process.env.VERIFY_DB_URL;
if (!url) {
  console.error("concurrency test: VERIFY_DB_URL is not set (run it through `npm run db:verify`).");
  process.exit(2);
}

const key = (n) => `00000000-0000-4000-8000-${String(8000 + n).padStart(12, "0")}`;
const uid = (prefix, n) => `00000000-0000-0000-0000-${prefix}${String(n).padStart(8, "0")}`;
const admin = (n) => uid("00ea", n);
const team = (n) => uid("00eb", n);
const member = (n, s) => uid("00ec", n * 10 + s);

function psql(sql) {
  return new Promise((resolve) => {
    const p = spawn("psql", [url, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
    p.stdin.end(sql);
  });
}
const must = async (sql) => {
  const r = await psql(sql);
  assert.equal(r.code, 0, `psql failed: ${r.stderr}`);
  return r.stdout;
};
const json = (r) => {
  assert.equal(r.code, 0, `session failed: ${r.stderr}`);
  const line = r.stdout.split("\n").find((l) => l.startsWith("{"));
  assert.ok(line, `no JSON result in: ${r.stdout}`);
  return JSON.parse(line);
};
const held = (call, hold = 1) =>
  psql(`begin;\nselect ${call};\nselect pg_sleep(${hold});\ncommit;`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const count = async (sql) => Number(await must(sql));

// Exactly one Super Admin can exist: reuse the one another script created in this scratch database, else create it.
await must(`
insert into staff_users (id, username, display_name, password_hash, role)
select '00000000-0000-0000-0000-0000000ea999', 'renew_conc_super', 'Renew Concurrency Super', 'TEST-NOT-A-HASH', 'SUPER_ADMIN'
 where not exists (select 1 from staff_users where role = 'SUPER_ADMIN');
`);
const SUPER = await must(`select id from staff_users where role = 'SUPER_ADMIN'`);

/** renew_competition with the CURRENT content (read in the same statement) and the given rules. */
const renewCall = (k, rules) =>
  `public.renew_competition('${SUPER}', jsonb_set((public.get_renewal_content('${SUPER}') -> 'content'), '{rules}', '${JSON.stringify(rules)}'::jsonb), ` +
  `(public.get_renewal_content('${SUPER}') ->> 'token'), '${key(k)}')`;

const admins = () => count(`select count(*) from staff_users where role = 'ADMIN'`);
const teams = () => count(`select count(*) from teams`);
const renewals = () =>
  count(`select count(*) from audit_events where event_type = 'COMPETITION_RENEWED'`);

const addAdminWithTeam = (a, t) => `
insert into staff_users (id, username, display_name, password_hash, role, created_by)
values ('${admin(a)}', 'renew_conc_admin${a}', 'Renew Admin ${a}', 'TEST-NOT-A-HASH', 'ADMIN', '${SUPER}');
${
  t === null
    ? ""
    : `
insert into teams (id, team_code, name, login_id, password_hash, admin_id, coins)
values ('${team(t)}', 'RC${t}', 'Renew Team ${t}', 'renew_conc_team_${t}', 'TEST-NOT-A-HASH', '${admin(a)}', (select initial_coins from competition where id = 1));
insert into team_members (id, team_id, slot, admission_no)
select ('00000000-0000-0000-0000-00ec' || lpad((${t} * 10 + s)::text, 8, '0'))::uuid, '${team(t)}'::uuid, s, 'RCONC${t}_' || s from generate_series(1, 4) s;
insert into coin_transactions (team_id, type, amount, balance_after, created_at)
select '${team(t)}'::uuid, 'INITIAL_GRANT', c.initial_coins, c.initial_coins, now() from competition c where c.id = 1;`
}`;

// ---- P0: bring the scratch database to a known state: every leftover team ended, then one renewal clears everything -------------------
{
  await must(`select public.set_competition_status('${SUPER}', 'end', '${key(1)}')`).catch(
    () => {},
  );
  const r = json({
    ...(await psql(`select ${renewCall(2, ["initial rule"])}`)),
  });
  assert.equal(r.replayed, false);
  assert.equal(await admins(), 0, "P0: no admin left");
  assert.equal(await teams(), 0, "P0: no team left");
  assert.equal(
    await must(`select status from competition where id = 1`),
    "SETUP",
    "P0: lifecycle reset",
  );
  console.log("ok    P0. leftover state renewed away: no admin, no team, competition SETUP");
}

// ---- A: one key, two concurrent calls ------------------------------------------------------------------------------------------------
{
  await must(addAdminWithTeam(1, 1) + addAdminWithTeam(2, 2));
  const before = await renewals();
  const rs = (await Promise.all([1, 2].map(() => held(renewCall(10, ["rule A"]))))).map(json);
  assert.equal(rs.filter((j) => !j.replayed).length, 1, "exactly one real renewal");
  assert.equal(rs.filter((j) => j.replayed).length, 1, "the other one is a replay");
  assert.equal(rs.find((j) => !j.replayed).deleted.admins, 2);
  assert.equal(rs.find((j) => !j.replayed).deleted.teams, 2);
  assert.equal((await renewals()) - before, 1, "one audit row, not two");
  assert.equal(await admins(), 0);
  assert.equal(await teams(), 0);
  console.log("ok    A. one key, two concurrent calls: one renewal, one replay, one audit row");
}

// ---- B: two tabs, different keys and different content, same snapshot -------------------------------------------------------------------
{
  await must(addAdminWithTeam(3, 3));
  const rs = await Promise.all([
    held(renewCall(11, ["rule from tab 1"])),
    held(renewCall(12, ["rule from tab 2"])),
  ]);
  const ok = rs.filter((r) => r.code === 0);
  const bad = rs.filter((r) => r.code !== 0);
  assert.equal(ok.length, 1, "one wins");
  assert.equal(bad.length, 1, "one loses");
  assert.match(bad[0].stderr, /CONTENT_CHANGED/, "the loser is told the content moved on");
  assert.equal(await admins(), 0);
  const rules = await must(`select rules ->> 0 from competition where id = 1`);
  assert.match(rules, /rule from tab [12]/);
  console.log("ok    B. two tabs: one wins, the other gets CONTENT_CHANGED and changes nothing");
}

// ---- C: the renewal races the admin's create_team and the Super Admin's create_admin --------------------------------------------------
{
  await must(addAdminWithTeam(4, null));
  const create = () =>
    held(
      `public.create_team('${admin(4)}', 'RCC1', 'Raced Team', 'renew_conc_RCC1', 'conc-team-password', ` +
        `array['RCC11','RCC12','RCC13','RCC14'], '${key(20)}')`,
      0.1,
    );
  const makeAdmin = () =>
    held(
      `public.create_admin('${SUPER}', 'renew_conc_new_admin', 'conc-admin-password', '${key(21)}')`,
      0.1,
    );
  const renew = held(renewCall(13, ["rule C"]), 1.2);
  await sleep(400);
  const [c, m, r] = await Promise.all([create(), makeAdmin(), renew]);
  assert.equal(r.code, 0, `the renewal succeeds: ${r.stderr}`);
  assert.equal(c.code === 0 ? "created" : "refused", "refused", "create_team after the renewal");
  assert.match(c.stderr, /FORBIDDEN/, "the admin was deleted, so create_team is FORBIDDEN");
  assert.equal(m.code, 0, `create_admin queued behind the renewal and then succeeded: ${m.stderr}`);
  assert.equal(await teams(), 0, "no orphan team");
  assert.equal(await admins(), 1, "only the admin created AFTER the renewal exists");
  assert.equal(
    await count(`select count(*) from staff_users where username = 'renew_conc_new_admin'`),
    1,
  );
  console.log("ok    C. renewal vs create_team / create_admin: no orphan, the new admin survives");
  await must(`delete from staff_users where username = 'renew_conc_new_admin'`);
}

// ---- D: the renewal races a reviewer's approval ------------------------------------------------------------------------------------------
{
  await must(addAdminWithTeam(5, 5));
  await must(`select public.set_competition_status('${SUPER}', 'open', '${key(30)}')`);
  const play = async (q, k) => {
    await must(
      `select public.submit_answer('${team(5)}', '${member(5, 1)}', ${q}::smallint, 'ans', 'because', '${key(k)}')`,
    );
  };
  await must(`select public.start_team_competition('${team(5)}', '${member(5, 1)}', '${key(31)}')`);
  await must(
    `select public.unlock_theme('${team(5)}', '${member(5, 1)}', 1::smallint, '${key(32)}')`,
  );
  await must(
    `select public.start_question('${team(5)}', '${member(5, 1)}', 1::smallint, '${key(33)}')`,
  );
  await play(1, 34);
  const sub = () =>
    must(`select id from submissions where team_id = '${team(5)}' and status = 'PENDING' limit 1`);

  // D1: the approval takes the lock first; Q2 becomes ACTIVE; the renewal then sees a solving team and is blocked
  const first = held(`public.approve_submission('${admin(5)}', '${await sub()}', '${key(35)}')`, 1);
  await sleep(300);
  const second = held(renewCall(14, ["rule D1"]), 0.1);
  const [a1, r1] = await Promise.all([first, second]);
  assert.equal(a1.code, 0, `the approval completes: ${a1.stderr}`);
  assert.notEqual(r1.code, 0, "the renewal is refused");
  assert.match(r1.stderr, /RENEWAL_BLOCKED/, "refused because the team is solving again");
  assert.equal(await teams(), 1, "nothing was deleted");
  assert.equal(await admins(), 1);
  assert.equal(
    await must(`select status from competition where id = 1`),
    "RUNNING",
    "the lifecycle was not touched",
  );
  assert.notEqual(
    await must(`select rules ->> 0 from competition where id = 1`),
    "rule D1",
    "the content was not published",
  );

  // D2: the team submits Q2 again (pending); now the renewal takes the lock first, the approval is refused afterwards
  await play(2, 36);
  const pending = await sub();
  const renew = held(renewCall(15, ["rule D2"]), 1);
  await sleep(300);
  const approve = held(`public.approve_submission('${admin(5)}', '${pending}', '${key(37)}')`, 0.1);
  const [r2, a2] = await Promise.all([renew, approve]);
  assert.equal(r2.code, 0, `the renewal succeeds: ${r2.stderr}`);
  assert.notEqual(a2.code, 0, "the approval is refused: its admin and team are gone");
  assert.match(a2.stderr, /FORBIDDEN|NOT_FOUND/);
  assert.equal(await teams(), 0);
  assert.equal(await admins(), 0);
  assert.equal(
    await count(`select count(*) from submissions`),
    0,
    "its submissions went with the team",
  );
  assert.equal(
    await count(`select count(*) from coin_transactions where team_id = '${team(5)}'`),
    0,
  );
  assert.equal(await must(`select status from competition where id = 1`), "SETUP");
  assert.equal(await must(`select rules ->> 0 from competition where id = 1`), "rule D2");
  console.log(
    "ok    D. renewal vs approval: approval first -> blocked and untouched; renewal first -> approval refused",
  );
}

// ---- E: afterwards nothing dangles --------------------------------------------------------------------------------------------------------
{
  assert.equal(
    await count(
      `select count(*) from coin_transactions c where not exists (select 1 from teams t where t.id = c.team_id)`,
    ),
    0,
    "no ledger row of a team that no longer exists",
  );
  assert.equal(
    await count(
      `select count(*) from request_log r where r.team_id not in (select id from teams union select id from staff_users)`,
    ),
    0,
    "no request_log row in the scope of an account that no longer exists",
  );
  console.log("ok    E. nothing dangles after the renewals");
}
