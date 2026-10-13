// Multi-connection tests for B18 (named team_* so it sorts AFTER start_team, which creates the one Super Admin the others reuse): the Super Admin's permanent deletion of Admins and Teams under concurrent load.
// Plain-SQL tests cannot open parallel sessions, so this script uses several `psql` processes against the scratch database
// that scripts/db-verify.mjs created (VERIFY_DB_URL). It commits its own rows (the scratch database is dropped afterwards).
// Each writing session holds its locks for ~1 s (`pg_sleep` inside the transaction), so the others genuinely queue on them.
//
//   A. a double click / retry storm: two concurrent delete_teams with ONE key              -> one deletion, one replay
//   B. a second browser tab: two concurrent delete_teams, DIFFERENT keys, same team        -> one wins, the other is NOT_FOUND
//   C. overlapping selections [t3,t4] and [t4,t5]                                          -> exactly one whole selection is gone
//   D. delete_admins races the admin's own create_team                                     -> never an orphan: admin and teams both gone
//   E. delete_teams races a participant's purchase / a reviewer's approval on the same team, in both orders
//                                                                                           -> the request either completes and is then deleted
//                                                                                             with the team (ledger, purchase and request_log
//                                                                                             rows included), or is refused; nothing in between
//   F. overlapping admin selections [a1,a2] and [a2,a3]                                    -> exactly one whole selection is gone
//   G. afterwards: balance chain, no ledger / purchase / request_log row of an account that no longer exists
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const url = process.env.VERIFY_DB_URL;
if (!url) {
  console.error("concurrency test: VERIFY_DB_URL is not set (run it through `npm run db:verify`).");
  process.exit(2);
}

const nn = (n) => String(n).padStart(2, "0");
const team = (n) => `00000000-0000-0000-0000-0000000e${nn(n)}00`;
const member = (n, s) => `00000000-0000-0000-0000-0000000e${nn(n)}0${s}`;
const admin = (n) => `00000000-0000-0000-0000-0000000ea0${nn(n)}`;
const key = (n) => `00000000-0000-4000-8000-${String(7000 + n).padStart(12, "0")}`;

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
const arr = (ids) => `array[${ids.map((i) => `'${i}'`).join(", ")}]::uuid[]`;

// Exactly one Super Admin can exist: reuse the one another script created in this scratch database, else create it.
await must(`
insert into staff_users (id, username, display_name, password_hash, role)
select '00000000-0000-0000-0000-0000000ea900', 'del_conc_super', 'Deletion Concurrency Super', 'TEST-NOT-A-HASH', 'SUPER_ADMIN'
 where not exists (select 1 from staff_users where role = 'SUPER_ADMIN');
`);
const SUPER = await must(`select id from staff_users where role = 'SUPER_ADMIN'`);
const delTeams = (ids, k) => `public.delete_teams('${SUPER}', ${arr(ids)}, '${key(k)}')`;
const delAdmins = (ids, k) => `public.delete_admins('${SUPER}', ${arr(ids)}, '${key(k)}')`;

// ---- fixtures (committed): seven admins; teams (4 members, INITIAL_GRANT each) owned as below ----------------------------------
const TEAM_OWNER = {
  1: 1,
  2: 1,
  3: 1,
  4: 1,
  5: 1,
  8: 1,
  9: 1,
  11: 3,
  12: 4,
  13: 5,
  14: 1,
  15: 1,
  16: 2,
  17: 2,
};
const ownerSql = Object.entries(TEAM_OWNER)
  .map(([t, a]) => `(${t}, '${admin(a)}'::uuid)`)
  .join(", ");
const teamNumbers = Object.keys(TEAM_OWNER)
  .map((t) => `(${t})`)
  .join(", ");
await must(`
update competition set status = 'RUNNING', paused_at = null, ended_at = null, opened_at = coalesce(opened_at, now()) where id = 1;
insert into staff_users (id, username, display_name, password_hash, role, created_by)
select ('00000000-0000-0000-0000-0000000ea0' || lpad(n::text, 2, '0'))::uuid, 'dconc_admin' || n, 'Deletion Admin ' || n, 'TEST-NOT-A-HASH', 'ADMIN', '${SUPER}'
  from generate_series(1, 7) n;
insert into teams (id, team_code, name, login_id, password_hash, admin_id, coins)
select ('00000000-0000-0000-0000-0000000e' || lpad(t::text, 2, '0') || '00')::uuid, 'DC' || t, 'Deletion Team ' || t, 'dconc_team_' || t,
       'TEST-NOT-A-HASH', a, (select initial_coins from competition where id = 1)
  from (values ${ownerSql}) v(t, a);
insert into team_members (id, team_id, slot, admission_no)
select ('00000000-0000-0000-0000-0000000e' || lpad(t::text, 2, '0') || '0' || s)::uuid,
       ('00000000-0000-0000-0000-0000000e' || lpad(t::text, 2, '0') || '00')::uuid, s, 'DCONC' || t || '_' || s
  from (values ${teamNumbers}) v(t) cross join generate_series(1, 4) s;
insert into coin_transactions (team_id, type, amount, balance_after, created_at)
select ('00000000-0000-0000-0000-0000000e' || lpad(t::text, 2, '0') || '00')::uuid, 'INITIAL_GRANT', c.initial_coins, c.initial_coins, now()
  from (values ${teamNumbers}) v(t) cross join competition c where c.id = 1;
`);

const teamExists = (n) => count(`select count(*) from teams where id = '${team(n)}'`);
const adminExists = (n) => count(`select count(*) from staff_users where id = '${admin(n)}'`);
const ledgerOf = (n) =>
  count(`select count(*) from coin_transactions where team_id = '${team(n)}'`);
const auditOf = (ev, n) =>
  count(`select count(*) from audit_events where event_type = '${ev}' and team_id = '${team(n)}'`);
const logOf = (n) => count(`select count(*) from request_log where team_id = '${team(n)}'`);
const purchasesOf = (n) =>
  count(`select count(*) from team_time_purchases where team_id = '${team(n)}'`);

// ---- A: one key, two concurrent calls ------------------------------------------------------------------------------------
{
  const ledger = await ledgerOf(1);
  const rs = (await Promise.all([1, 2].map(() => held(delTeams([team(1)], 1))))).map(json);
  assert.equal(rs.filter((j) => !j.replayed).length, 1, "exactly one real deletion");
  assert.equal(rs.filter((j) => j.replayed).length, 1, "the other one is a replay");
  assert.equal(await teamExists(1), 0);
  assert.equal(await auditOf("TEAM_DELETED", 1), 1, "one audit row, not two");
  assert.ok(ledger > 0, "the team had a ledger");
  assert.equal(await ledgerOf(1), 0, "its ledger went with it, once");
  console.log("ok    A. one key, two concurrent calls: one deletion, one replay");
}

// ---- B: two tabs, different keys, same team --------------------------------------------------------------------------------
{
  const rs = await Promise.all([held(delTeams([team(2)], 2)), held(delTeams([team(2)], 3))]);
  const ok = rs.filter((r) => r.code === 0);
  const bad = rs.filter((r) => r.code !== 0);
  assert.equal(ok.length, 1, "one wins");
  assert.equal(bad.length, 1, "one loses");
  assert.match(bad[0].stderr, /NOT_FOUND/, "the loser is told the team is already gone");
  assert.equal(await teamExists(2), 0);
  assert.equal(await auditOf("TEAM_DELETED", 2), 1);
  console.log("ok    B. two tabs: one wins, the other gets NOT_FOUND, one audit row");
}

// ---- C: overlapping selections -----------------------------------------------------------------------------------------------
{
  const rs = await Promise.all([
    held(delTeams([team(3), team(4)], 4)),
    held(delTeams([team(4), team(5)], 5)),
  ]);
  assert.equal(rs.filter((r) => r.code === 0).length, 1, "exactly one selection is applied");
  assert.match(rs.find((r) => r.code !== 0).stderr, /NOT_FOUND/);
  const [t3, t4, t5] = [await teamExists(3), await teamExists(4), await teamExists(5)];
  assert.equal(t4, 0, "the shared team is gone");
  assert.equal(t3 + t5, 1, `the losing selection's other team survives whole (t3=${t3}, t5=${t5})`);
  console.log(
    "ok    C. overlapping selections: one whole selection applied, the other rolled back",
  );
}

// ---- D: delete_admins vs the admin's own create_team --------------------------------------------------------------------------
for (const order of ["create first", "delete first"]) {
  const a = order === "create first" ? 6 : 7;
  const code = order === "create first" ? "DCD1" : "DCD2";
  const create = () =>
    held(
      `public.create_team('${admin(a)}', '${code}', 'Raced Team', 'dconc_${code}', 'conc-team-password', ` +
        `array['${code}1','${code}2','${code}3','${code}4'], '${key(20 + a)}')`,
    );
  const del = () => held(delAdmins([admin(a)], 30 + a), 0.2);
  const first = order === "create first" ? create() : del();
  await sleep(300);
  const second = order === "create first" ? del() : create();
  const [r1, r2] = await Promise.all([first, second]);
  const createRes = order === "create first" ? r1 : r2;
  const delRes = order === "create first" ? r2 : r1;
  assert.equal(delRes.code, 0, `the deletion succeeds in both orders: ${delRes.stderr}`);
  if (order === "create first") assert.equal(createRes.code, 0, `create won: ${createRes.stderr}`);
  else
    assert.match(
      createRes.stderr,
      /FORBIDDEN/,
      "create_team after the admin was deleted is FORBIDDEN",
    );
  assert.equal(await adminExists(a), 0, "the admin is gone");
  assert.equal(
    await count(`select count(*) from teams where admin_id = '${admin(a)}'`),
    0,
    "no orphan team",
  );
  assert.equal(
    await count(`select count(*) from teams where team_code = '${code}'`),
    0,
    `no team ${code} survives (${order})`,
  );
  // when the team was created first it went with its admin - and so did its ledger row (nothing of it is left)
  const created = await count(
    `select count(*) from audit_events where event_type = 'TEAM_CREATED' and payload->>'team_code' = '${code}'`,
  );
  assert.equal(created, order === "create first" ? 1 : 0);
  assert.equal(
    await count(
      `select count(*) from audit_events where event_type = 'TEAM_DELETED' and payload->>'team_code' = '${code}'`,
    ),
    created,
  );
  assert.equal(
    await count(
      `select count(*) from coin_transactions c where c.team_id in (select team_id from audit_events where event_type = 'TEAM_CREATED' and payload->>'team_code' = '${code}')`,
    ),
    0,
    "no ledger row of the raced team survives",
  );
  assert.equal(
    await count(`select count(*) from request_log where team_id = '${admin(a)}'`),
    0,
    "no idempotency record in the deleted admin's scope (the create_team reply included)",
  );
  console.log(`ok    D. delete_admins vs create_team (${order}): no orphan, no leaked FK error`);
}

// ---- E: delete_teams vs a participant's purchase on the same team -----------------------------------------------------------------
// a started team with an unlocked theme and an entered question, so buy_hint is a real ledger write
for (const n of [8, 9, 14, 15]) {
  await must(`
    select public.start_team_competition('${team(n)}', '${member(n, 1)}', '${key(100 + n)}');
    select public.unlock_theme('${team(n)}', '${member(n, 1)}', 1::smallint, '${key(110 + n)}');
    select public.start_question('${team(n)}', '${member(n, 1)}', 1::smallint, '${key(120 + n)}');`);
}
const buy = (n, k) =>
  `public.buy_hint('${team(n)}', '${member(n, 1)}', 1::smallint, 1::smallint, '${key(k)}')`;
{
  // E1: the purchase holds the team lock first; the deletion queues, then removes the team. The ledger keeps the purchase.
  const before = await ledgerOf(8);
  const [p, d] = await Promise.all([
    held(buy(8, 130)),
    sleep(300).then(() => held(delTeams([team(8)], 131), 0.1)),
  ]);
  assert.equal(p.code, 0, `purchase: ${p.stderr}`);
  assert.equal(d.code, 0, `deletion: ${d.stderr}`);
  assert.equal(await teamExists(8), 0);
  assert.ok(before >= 1);
  assert.equal(
    await ledgerOf(8),
    0,
    "the purchase won the race and was then deleted with the team's ledger",
  );
  assert.equal(await count(`select count(*) from hint_purchases where team_id = '${team(8)}'`), 0);
  assert.equal(await logOf(8), 0, "the purchase's idempotency record went with the team");
  console.log(
    "ok    E1. purchase then deletion: purchase completed, then everything of the team is gone",
  );
}
{
  // E2: the deletion holds the lock first; the purchase queues, then finds no team and is refused. Nothing is written.
  const before = await ledgerOf(9);
  const [d, p] = await Promise.all([
    held(delTeams([team(9)], 132), 1),
    sleep(300).then(() => held(buy(9, 133), 0.1)),
  ]);
  assert.equal(d.code, 0, `deletion: ${d.stderr}`);
  assert.notEqual(p.code, 0, "the purchase on a deleted team must fail");
  assert.match(p.stderr, /NOT_FOUND|FORBIDDEN/);
  assert.equal(await teamExists(9), 0);
  assert.ok(before >= 1);
  assert.equal(await ledgerOf(9), 0, "no ledger row exists for the deleted team (none was added)");
  assert.equal(await logOf(9), 0, "the refused purchase stored no idempotency record");
  console.log("ok    E2. deletion then purchase: purchase refused, nothing written");
}

{
  // E3: Buy Time wins the race, then the deletion: the purchase row, its ledger row and its request_log row go with the team.
  const buyTime = (n, k) =>
    `public.buy_time('${team(n)}', '${member(n, 1)}', 1::smallint, 1::smallint, 0, '${key(k)}')`;
  const before = await ledgerOf(14);
  const [p, d] = await Promise.all([
    held(buyTime(14, 140)),
    sleep(300).then(() => held(delTeams([team(14)], 141), 0.1)),
  ]);
  assert.equal(p.code, 0, `time purchase: ${p.stderr}`);
  assert.equal(d.code, 0, `deletion: ${d.stderr}`);
  assert.equal(await teamExists(14), 0);
  assert.ok(before >= 1);
  assert.equal(await ledgerOf(14), 0, "the ledger, including the time purchase, is gone");
  assert.equal(await purchasesOf(14), 0, "the purchase row went with the team");
  assert.equal(await logOf(14), 0);
  console.log(
    "ok    E3. time purchase then deletion: completed, then purchase, ledger and log rows all deleted with the team",
  );

  // E4: the deletion wins, the time purchase queues behind it and is refused: no purchase row, no ledger row, no log row.
  const before15 = await ledgerOf(15);
  const [d2, p2] = await Promise.all([
    held(delTeams([team(15)], 142), 1),
    sleep(300).then(() => held(buyTime(15, 143), 0.1)),
  ]);
  assert.equal(d2.code, 0, `deletion: ${d2.stderr}`);
  assert.notEqual(p2.code, 0, "a time purchase on a deleted team must fail");
  assert.match(p2.stderr, /NOT_FOUND|FORBIDDEN/);
  assert.ok(before15 >= 1);
  assert.equal(await ledgerOf(15), 0);
  assert.equal(await purchasesOf(15), 0, "no purchase row was written for the deleted team");
  assert.equal(await logOf(15), 0, "the refused purchase left no idempotency record");
  console.log("ok    E4. deletion then time purchase: refused, nothing written");
}

{
  // E5/E6: a REVIEWER's approval races the deletion of the team it reviews. Teams 16 and 17 (owner: admin 2) each have a pending submission.
  for (const n of [16, 17]) {
    await must(`
      select public.start_team_competition('${team(n)}', '${member(n, 1)}', '${key(200 + n)}');
      select public.unlock_theme('${team(n)}', '${member(n, 1)}', 1::smallint, '${key(210 + n)}');
      select public.start_question('${team(n)}', '${member(n, 1)}', 1::smallint, '${key(220 + n)}');
      select public.submit_answer('${team(n)}', '${member(n, 1)}', 1::smallint, 'ans', 'because', '${key(230 + n)}');`);
  }
  const sub = (n) =>
    must(`select id from submissions where team_id = '${team(n)}' and status = 'PENDING'`);
  const approve = (sid, k) => `public.approve_submission('${admin(2)}', '${sid}', '${key(k)}')`;
  const adminLog = (k) =>
    count(
      `select count(*) from request_log where team_id = '${admin(2)}' and idem_key = '${key(k)}'`,
    );

  // E5: the approval holds the team lock first (reward written, reply stored in the ADMIN's scope); the deletion then removes it all
  const s16 = await sub(16);
  const [a1, d1] = await Promise.all([
    held(approve(s16, 240)),
    sleep(300).then(() => held(delTeams([team(16)], 241), 0.1)),
  ]);
  assert.equal(a1.code, 0, `approval: ${a1.stderr}`);
  assert.equal(d1.code, 0, `deletion: ${d1.stderr}`);
  assert.equal(await teamExists(16), 0);
  assert.equal(await ledgerOf(16), 0, "the reward row went with the ledger");
  assert.equal(
    await adminLog(240),
    0,
    "the admin's stored reply about the deleted team's submission is gone",
  );
  assert.equal(await adminExists(2), 1, "the reviewing admin survives");
  console.log(
    "ok    E5. approval then deletion: completed, then the reply in the admin's scope is deleted too",
  );

  // E6: the deletion wins; the approval queues, finds nothing, stores nothing - and a retry with the same key is an honest NOT_FOUND
  const s17 = await sub(17);
  const [d2, a2] = await Promise.all([
    held(delTeams([team(17)], 242), 1),
    sleep(300).then(() => held(approve(s17, 243), 0.1)),
  ]);
  assert.equal(d2.code, 0, `deletion: ${d2.stderr}`);
  assert.notEqual(a2.code, 0, "an approval of a deleted team's submission must fail");
  assert.match(a2.stderr, /NOT_FOUND|FORBIDDEN/);
  assert.equal(await adminLog(243), 0, "the refused approval stored nothing");
  const retry = await held(approve(s17, 243), 0);
  assert.notEqual(retry.code, 0);
  assert.match(
    retry.stderr,
    /NOT_FOUND|FORBIDDEN/,
    "the retry is not answered with an invented success",
  );
  assert.equal(await ledgerOf(17), 0);
  console.log("ok    E6. deletion then approval: refused, nothing stored, a retry is NOT_FOUND");
}

// ---- F: overlapping admin selections ---------------------------------------------------------------------------------------------
{
  // admins 3, 4 and 5 own one team each (teams 11, 12, 13)
  const rs = await Promise.all([
    held(delAdmins([admin(3), admin(4)], 40)),
    held(delAdmins([admin(4), admin(5)], 41)),
  ]);
  assert.equal(rs.filter((r) => r.code === 0).length, 1, "exactly one selection is applied");
  assert.match(rs.find((r) => r.code !== 0).stderr, /NOT_FOUND/);
  const [a3, a4, a5] = [await adminExists(3), await adminExists(4), await adminExists(5)];
  assert.equal(a4, 0, "the shared admin is gone");
  assert.equal(
    a3 + a5,
    1,
    `the losing selection's other admin survives whole (a3=${a3}, a5=${a5})`,
  );
  console.log(
    "ok    F. overlapping admin selections: one whole selection applied, the other rolled back",
  );
}

// ---- G: the world is consistent -------------------------------------------------------------------------------------------------
{
  assert.equal(
    await count(`select count(*) from app.invariant_coin_balance_mismatch`),
    0,
    "every balance equals its ledger tail",
  );
  assert.equal(await count(`select count(*) from app.invariant_team_member_count`), 0);
  assert.equal(
    await count(
      `select count(*) from coin_transactions c where not exists (select 1 from teams t where t.id = c.team_id)`,
    ),
    0,
    "no ledger row for a team that does not exist",
  );
  assert.equal(
    await count(
      `select count(*) from team_time_purchases p where not exists (select 1 from teams t where t.id = p.team_id)`,
    ),
    0,
    "no purchase row for a team that does not exist",
  );
  assert.equal(
    await count(
      `select count(*) from request_log r where r.team_id not in (select id from teams union select id from staff_users)`,
    ),
    0,
    "no idempotency record in the scope of an account that no longer exists",
  );
  assert.equal(
    await count(
      `select count(*) from request_log r where r.operation = 'create_team' and not exists (select 1 from teams t where t.id::text = r.response #>> '{team,id}')`,
    ),
    0,
    "no stored create_team reply about a team that no longer exists",
  );
  assert.equal(
    await count(
      `select count(*) from teams t left join staff_users s on s.id = t.admin_id where s.id is null`,
    ),
    0,
    "no team without its admin",
  );
  assert.ok((await count(`select count(*) from staff_users where role = 'SUPER_ADMIN'`)) === 1);
  console.log("ok    G. invariants hold after every race");
}
console.log("deletion concurrency tests passed");
