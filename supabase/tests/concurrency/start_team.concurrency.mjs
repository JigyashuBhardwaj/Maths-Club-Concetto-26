// Multi-connection tests for the B10 runtime engine. Plain-SQL tests cannot open parallel sessions, so this script
// does it with several `psql` processes against the scratch database that scripts/db-verify.mjs created and passes in
// VERIFY_DB_URL. It commits its own rows (the scratch database is dropped afterwards).
//
//   A. four members of one team enter at the same moment (four different keys)  -> one timer, one audit row
//   B. one member retries the same request four times at once (one key)         -> one start, three replays
//   C. a start races a competition pause, on two teams                           -> no deadlock, no timer after the pause
//
// Each session holds the team lock for ~1 s (`pg_sleep` inside the transaction), so the others genuinely queue on it.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const url = process.env.VERIFY_DB_URL;
if (!url) {
  console.error("concurrency test: VERIFY_DB_URL is not set (run it through `npm run db:verify`).");
  process.exit(2);
}

const SUPER = "00000000-0000-0000-0000-0000000000f1";
const team = (n) => `00000000-0000-0000-0000-00000000f${n}00`;
const member = (n, s) => `00000000-0000-0000-0000-00000000f${n}0${s}`;
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

// A session that holds whatever lock its call took for 1 s before committing.
const slowStart = (t, s, k) =>
  psql(`begin;
select public.start_team_competition('${team(t)}', '${member(t, s)}', '${key(k)}');
select pg_sleep(1);
commit;`);

const parse = (r) => {
  assert.equal(r.code, 0, `session failed: ${r.stderr}`);
  const line = r.stdout.split("\n").find((l) => l.startsWith("{"));
  assert.ok(line, `no JSON result in: ${r.stdout}`);
  return JSON.parse(line);
};

// ---- fixtures (committed): one super admin, four teams x four members, competition RUNNING --------------------------
await must(`
insert into staff_users (id, username, display_name, password_hash, role)
values ('${SUPER}', 'conc_super', 'Concurrency Super', 'TEST-NOT-A-HASH', 'SUPER_ADMIN');
insert into staff_users (id, username, display_name, password_hash, role, created_by)
values ('00000000-0000-0000-0000-0000000000f2', 'conc_admin', 'Concurrency Admin', 'TEST-NOT-A-HASH', 'ADMIN', '${SUPER}');
${[1, 2, 3, 4]
  .map(
    (n) => `
insert into teams (id, team_code, name, login_id, password_hash, admin_id, coins)
values ('${team(n)}', 'C0${n}', 'Concurrency ${n}', 'conc_team_${n}', 'TEST-NOT-A-HASH', '00000000-0000-0000-0000-0000000000f2', 500);
insert into coin_transactions (team_id, type, amount, balance_after, created_at) values ('${team(n)}', 'INITIAL_GRANT', 500, 500, now());
insert into team_members (id, team_id, slot, admission_no)
select ('00000000-0000-0000-0000-00000000f${n}0' || s)::uuid, '${team(n)}', s, 'CONC${n}' || s from generate_series(1, 4) s;`,
  )
  .join("\n")}
update competition set status = 'RUNNING', opened_at = now() where id = 1;
`);

// ---- A: four members, four keys, same instant ----------------------------------------------------------------------
{
  const results = (await Promise.all([1, 2, 3, 4].map((s) => slowStart(1, s, 100 + s)))).map(parse);
  const started = results.filter((j) => j.started_now);
  assert.equal(started.length, 1, "exactly one request starts the team");
  assert.equal(results.filter((j) => j.replayed).length, 0, "different keys are not replays");
  const stamps = new Set(results.map((j) => `${j.state.team.started_at}/${j.state.team.ends_at}`));
  assert.equal(stamps.size, 1, "every member observes the same started_at/ends_at");
  const row = await must(
    `select count(*), min(started_at), max(started_at), max(extract(epoch from ends_at - started_at)), max(state_version)
       from teams where id = '${team(1)}' and status = 'RUNNING'`,
  );
  const [count, , , span, version] = row.split("|");
  assert.equal(count, "1");
  assert.equal(Number(span), 14400, "exactly 14400 s");
  assert.equal(version, "1", "one state_version bump");
  assert.equal(
    await must(
      `select count(*) from audit_events where event_type = 'TEAM_STARTED' and team_id = '${team(1)}'`,
    ),
    "1",
    "one audit row",
  );
  console.log(
    "ok    A. four members entering together share one timer (14400 s, 1 audit row, version 1)",
  );
}

// ---- B: one key, four simultaneous retries -------------------------------------------------------------------------
{
  const results = (await Promise.all([1, 2, 3, 4].map(() => slowStart(2, 1, 200)))).map(parse);
  assert.equal(results.filter((j) => j.started_now && !j.replayed).length, 1, "one real start");
  assert.equal(results.filter((j) => j.replayed).length, 3, "three replays");
  assert.equal(new Set(results.map((j) => j.state.team.started_at)).size, 1);
  assert.equal(
    await must(
      `select count(*) from request_log where team_id = '${team(2)}' and idem_key = '${key(200)}'`,
    ),
    "1",
  );
  assert.equal(
    await must(
      `select count(*) from audit_events where event_type = 'TEAM_STARTED' and team_id = '${team(2)}'`,
    ),
    "1",
  );
  console.log("ok    B. a retry storm with one key starts once and replays the rest");
}

// ---- C: a start races a pause (two teams), no deadlock --------------------------------------------------------------
{
  const pause = psql(`select public.set_competition_status('${SUPER}', 'pause', '${key(300)}');`);
  const starts = [slowStart(3, 1, 301), slowStart(4, 1, 302)];
  const [p, ...ss] = await Promise.all([pause, ...starts]);
  assert.equal(p.code, 0, `pause failed: ${p.stderr}`);
  assert.ok(!/deadlock/i.test(p.stderr + ss.map((s) => s.stderr).join("")), "no deadlock");
  for (const s of ss) {
    if (s.code !== 0)
      assert.match(s.stderr, /COMPETITION_PAUSED/, `unexpected failure: ${s.stderr}`);
  }
  assert.equal(await must(`select status from competition where id = 1`), "PAUSED");
  // whichever order the locks were taken in, no team may have started after the pause instant
  assert.equal(
    await must(
      `select count(*) from teams t, competition c where t.id in ('${team(3)}', '${team(4)}') and t.started_at > c.paused_at`,
    ),
    "0",
    "no timer starts after the pause",
  );
  console.log("ok    C. start vs pause: no deadlock, no timer started after the pause");
}
console.log("concurrency tests passed");
