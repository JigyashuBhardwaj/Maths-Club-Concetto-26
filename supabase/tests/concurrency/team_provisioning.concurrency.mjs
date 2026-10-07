// Multi-connection tests for the B12 provisioning functions. Plain-SQL tests cannot open parallel sessions, so this
// script uses several `psql` processes against the scratch database that scripts/db-verify.mjs created and passes in
// VERIFY_DB_URL. It commits its own rows (the scratch database is dropped afterwards).
//
//   A. a double click / retry storm: four concurrent create_team calls with ONE key       -> one team, three replays
//   B. two admins create a team with the SAME team code at the same instant               -> one wins, the other rolls back whole
//   C. four concurrent create_admin calls with ONE key, then with four keys for ONE name  -> one admin each time
//   D. create_team races set_competition_status('open')                                    -> no deadlock; both finish
//
// Each session holds its locks for ~1 s (`pg_sleep` inside the transaction), so the others genuinely queue on them.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const url = process.env.VERIFY_DB_URL;
if (!url) {
  console.error("concurrency test: VERIFY_DB_URL is not set (run it through `npm run db:verify`).");
  process.exit(2);
}

const ADMIN1 = "00000000-0000-0000-0000-0000000000e2";
const ADMIN2 = "00000000-0000-0000-0000-0000000000e3";
const key = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

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

// A session that holds the locks its call took for 1 s before committing.
const slow = (call) => psql(`begin;\nselect ${call};\nselect pg_sleep(1);\ncommit;`);
const team = (who, code, login, k, adm) =>
  slow(
    `public.create_team('${who}', '${code}', 'Team ${code}', '${login}', 'conc-team-password', ` +
      `array['${adm}1','${adm}2','${adm}3','${adm}4'], '${key(k)}')`,
  );
const admin = (name, k) =>
  slow(`public.create_admin('${SUPER}', '${name}', 'conc-admin-password', '${key(k)}')`);

// Exactly one Super Admin can exist: reuse the one another script created in this scratch database, else create it.
await must(`
insert into staff_users (id, username, display_name, password_hash, role)
select '00000000-0000-0000-0000-0000000000e1', 'pconc_super', 'Provisioning Concurrency Super', 'TEST-NOT-A-HASH', 'SUPER_ADMIN'
 where not exists (select 1 from staff_users where role = 'SUPER_ADMIN');
`);
const SUPER = await must(`select id from staff_users where role = 'SUPER_ADMIN'`);
await must(`
insert into staff_users (id, username, display_name, password_hash, role, created_by)
values ('${ADMIN1}', 'pconc_admin1', 'Admin 1', 'TEST-NOT-A-HASH', 'ADMIN', '${SUPER}'),
       ('${ADMIN2}', 'pconc_admin2', 'Admin 2', 'TEST-NOT-A-HASH', 'ADMIN', '${SUPER}');
`);

const count = async (sql) => Number(await must(sql));

// ---- A: one key, four concurrent calls ------------------------------------------------------------------------------
{
  const results = (
    await Promise.all([1, 2, 3, 4].map(() => team(ADMIN1, "PA1", "pa1_login", 201, "PAADM")))
  ).map(json);
  assert.equal(
    results.filter((j) => !j.replayed).length,
    1,
    "exactly one request creates the team",
  );
  assert.equal(
    results.filter((j) => j.replayed).length,
    3,
    "the others replay the stored response",
  );
  assert.equal(new Set(results.map((j) => j.team.id)).size, 1, "everyone sees the same team");
  assert.equal(await count(`select count(*) from teams where team_code = 'PA1'`), 1);
  assert.equal(
    await count(
      `select count(*) from team_members m join teams t on t.id = m.team_id where t.team_code = 'PA1'`,
    ),
    4,
  );
  assert.equal(
    await count(
      `select count(*) from coin_transactions c join teams t on t.id = c.team_id where t.team_code = 'PA1'`,
    ),
    1,
    "one initial grant",
  );
  assert.equal(
    await count(
      `select count(*) from audit_events where event_type = 'TEAM_CREATED' and payload->>'team_code' = 'PA1'`,
    ),
    1,
  );
  console.log("ok    A. a retry storm with one key creates one team and replays the rest");
}

// ---- B: two admins, same team code, same instant -------------------------------------------------------------------
{
  const rs = await Promise.all([
    team(ADMIN1, "PB1", "pb1_login_a", 211, "PBA"),
    team(ADMIN2, "PB1", "pb1_login_b", 212, "PBB"),
  ]);
  const won = rs.filter((r) => r.code === 0);
  const lost = rs.filter((r) => r.code !== 0);
  assert.equal(won.length, 1, "exactly one admin gets the team code");
  assert.equal(lost.length, 1);
  assert.ok(lost[0].stderr.includes("TEAM_CODE_TAKEN"), `the loser is told so: ${lost[0].stderr}`);
  assert.equal(await count(`select count(*) from teams where team_code = 'PB1'`), 1);
  // the loser left nothing behind: no orphan member, ledger or audit row for its inputs
  const loserAdm = won[0].stdout.includes("pb1_login_a") ? "PBB" : "PBA";
  assert.equal(
    await count(`select count(*) from team_members where admission_no like '${loserAdm}%'`),
    0,
    "no orphan members",
  );
  assert.equal(
    await count(`select count(*) from teams where login_id in ('pb1_login_a', 'pb1_login_b')`),
    1,
  );
  assert.equal(
    await count(
      `select count(*) from coin_transactions c where not exists (select 1 from teams t where t.id = c.team_id)`,
    ),
    0,
  );
  console.log("ok    B. two admins racing for one team code: one wins, the loser rolls back whole");
}

// ---- C: create_admin ------------------------------------------------------------------------------------------------
{
  const same = (await Promise.all([1, 2, 3, 4].map(() => admin("pconc_new_a", 221)))).map(json);
  assert.equal(same.filter((j) => !j.replayed).length, 1);
  assert.equal(await count(`select count(*) from staff_users where username = 'pconc_new_a'`), 1);
  assert.equal(
    await count(
      `select count(*) from audit_events where event_type = 'ADMIN_CREATED' and payload->>'username' = 'pconc_new_a'`,
    ),
    1,
  );

  const many = await Promise.all([231, 232, 233, 234].map((k) => admin("pconc_new_b", k)));
  assert.equal(many.filter((r) => r.code === 0).length, 1, "one name, four keys: one admin");
  assert.ok(many.filter((r) => r.code !== 0).every((r) => r.stderr.includes("USERNAME_TAKEN")));
  assert.equal(await count(`select count(*) from staff_users where username = 'pconc_new_b'`), 1);
  console.log("ok    C. a retry storm and a name race both create exactly one admin");
}

// ---- D: create_team vs `open` -----------------------------------------------------------------------------------------
{
  // The scratch database is shared with the other concurrency scripts (which run first and may leave the competition
  // RUNNING). Put it back to SETUP directly (test-only) so that `open` is a real transition here.
  await must(
    `update competition set status = 'SETUP', opened_at = null, paused_at = null, ended_at = null where id = 1`,
  );
  const [open, made] = await Promise.all([
    psql(
      `begin;\nselect public.set_competition_status('${SUPER}', 'open', '${key(241)}');\nselect pg_sleep(1);\ncommit;`,
    ),
    team(ADMIN2, "PD1", "pd1_login", 242, "PDADM"),
  ]);
  assert.equal(open.code, 0, `open failed: ${open.stderr}`);
  assert.equal(made.code, 0, `create_team failed: ${made.stderr}`);
  assert.equal(await must(`select status from competition`), "RUNNING");
  assert.equal(await must(`select status from teams where team_code = 'PD1'`), "NOT_STARTED");
  console.log("ok    D. create_team racing the competition `open`: no deadlock, both complete");
}

console.log("concurrency tests passed");
