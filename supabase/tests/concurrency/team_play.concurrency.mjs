// Multi-connection tests for the B13 gameplay engine. Plain-SQL tests cannot open parallel sessions, so this script
// uses several `psql` processes against the scratch database that scripts/db-verify.mjs created (VERIFY_DB_URL).
// It commits its own rows (the scratch database is dropped afterwards) and runs on the real clock.
//
//   1. four members unlock the same theme (four keys)         -> exactly one unlock, one deduction
//   2. one member retries an unlock four times (one key)      -> one unlock, three replays
//   3. four members enter Q1 together (four keys)             -> one start, ONE deadline for everybody
//   4. one member retries start_question four times (one key) -> one start, three replays
//   5. four members submit together (four keys)               -> one PENDING submission, three SUBMISSION_PENDING
//   6. a submit is retried four times (one key)               -> one submission, three replays
//   7. a submit queues behind another session while the question's deadline passes
//                                                             -> QUESTION_TIMED_OUT, never a submission
//   8. two reviewers approve the same submission              -> one reward; a retry storm replays
//   9. an approval races a disapproval                        -> exactly one wins, consistent state
//  10. the team timer and the question timer are independent clocks
//  11. repeated reads (refresh / reconnect) change nothing
//
// Each writing session holds the team lock for ~1 s (`pg_sleep` inside the transaction) so the others genuinely queue.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const url = process.env.VERIFY_DB_URL;
if (!url) {
  console.error("concurrency test: VERIFY_DB_URL is not set (run it through `npm run db:verify`).");
  process.exit(2);
}

// There may be only one Super Admin, so these are the same two staff rows start_team.concurrency.mjs creates
// (inserted here only when that script has not run).
const SUPER = "00000000-0000-0000-0000-0000000000f1";
const ADMIN = "00000000-0000-0000-0000-0000000000f2";
const team = (n) => `00000000-0000-0000-0000-00000000e${n}00`;
const member = (n, s) => `00000000-0000-0000-0000-00000000e${n}0${s}`;
const key = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TEAMS = [1, 2, 3, 4, 5, 6, 7, 8];

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
// a session that holds whatever lock its call took for `hold` seconds before committing
const held = (call, hold = 1) =>
  psql(`begin;\nselect ${call};\nselect pg_sleep(${hold});\ncommit;`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const codes = (rs) => rs.filter((r) => r.code !== 0).map((r) => r.stderr);
const one = (sql) => must(sql);

const unlock = (t, s, theme, k) =>
  `public.unlock_theme('${team(t)}', '${member(t, s)}', ${theme}::smallint, '${key(k)}')`;
const enter = (t, s, q, k) =>
  `public.start_question('${team(t)}', '${member(t, s)}', ${q}::smallint, '${key(k)}')`;
const submit = (t, s, q, ans, k) =>
  `public.submit_answer('${team(t)}', '${member(t, s)}', ${q}::smallint, '${ans}', 'because', '${key(k)}')`;
const approve = (who, sub, k) => `public.approve_submission('${who}', '${sub}', '${key(k)}')`;
const pendingId = (t, q) =>
  one(
    `select id from submissions where team_id = '${team(t)}' and question_id = ${q} and status = 'PENDING'`,
  );

// ---- fixtures (committed): staff, eight teams x four members, competition RUNNING --------------------------------
await must(`
insert into staff_users (id, username, display_name, password_hash, role)
values ('${SUPER}', 'conc_super', 'Concurrency Super', 'TEST-NOT-A-HASH', 'SUPER_ADMIN') on conflict (id) do nothing;
insert into staff_users (id, username, display_name, password_hash, role, created_by)
values ('${ADMIN}', 'conc_admin', 'Concurrency Admin', 'TEST-NOT-A-HASH', 'ADMIN', '${SUPER}') on conflict (id) do nothing;
${TEAMS.map(
  (n) => `
insert into teams (id, team_code, name, login_id, password_hash, admin_id, coins)
values ('${team(n)}', 'P0${n}', 'Play ${n}', 'play_team_${n}', 'TEST-NOT-A-HASH', '${ADMIN}', 500);
insert into coin_transactions (team_id, type, amount, balance_after, created_at) values ('${team(n)}', 'INITIAL_GRANT', 500, 500, now());
insert into team_members (id, team_id, slot, admission_no)
select ('00000000-0000-0000-0000-00000000e${n}0' || s)::uuid, '${team(n)}', s, 'PLAY${n}' || s from generate_series(1, 4) s;`,
).join("\n")}
update competition set status = 'RUNNING', paused_at = null, ended_at = null, opened_at = coalesce(opened_at, now()) where id = 1;
`);
for (const n of TEAMS) {
  const r = json(
    await psql(
      `select public.start_team_competition('${team(n)}', '${member(n, 1)}', '${key(9000 + n)}')`,
    ),
  );
  assert.equal(r.state.team.status, "RUNNING");
}
const coins = (t) => one(`select coins from teams where id = '${team(t)}'`);
const count = (sql) => one(`select count(*) ${sql}`);

// ---- 1. four members unlock the same theme -----------------------------------------------------------------------
{
  const rs = await Promise.all([1, 2, 3, 4].map((s) => held(unlock(1, s, 1, 100 + s))));
  assert.equal(rs.filter((r) => r.code === 0).length, 1, "exactly one unlock wins");
  const failures = codes(rs);
  assert.equal(failures.length, 3);
  for (const f of failures) assert.match(f, /THEME_ALREADY_UNLOCKED/, f);
  assert.equal(await coins(1), "400", "one deduction");
  assert.equal(await count(`from team_themes where team_id = '${team(1)}' and theme_id = 1`), "1");
  assert.equal(
    await count(`from coin_transactions where team_id = '${team(1)}' and type = 'THEME_UNLOCK'`),
    "1",
  );
  assert.equal(await count(`from team_questions where team_id = '${team(1)}'`), "5");
  assert.equal(
    await one(
      `select state || '/' || coalesce(timer_deadline::text, 'null') from team_questions where team_id = '${team(1)}' and question_id = 1`,
    ),
    "AVAILABLE/null",
    "Q1 AVAILABLE with no timer",
  );
  console.log("ok    1. four members unlocking one theme: one unlock, one deduction (500 -> 400)");
}

// ---- 2. one key, four simultaneous retries of an unlock ----------------------------------------------------------
{
  const rs = (await Promise.all([1, 2, 3, 4].map(() => held(unlock(2, 1, 1, 200))))).map(json);
  assert.equal(rs.filter((j) => !j.replayed).length, 1, "one real unlock");
  assert.equal(rs.filter((j) => j.replayed).length, 3, "three replays");
  assert.equal(await coins(2), "400");
  assert.equal(await count(`from team_themes where team_id = '${team(2)}'`), "1");
  assert.equal(
    await count(`from audit_events where team_id = '${team(2)}' and event_type = 'THEME_UNLOCKED'`),
    "1",
  );
  console.log("ok    2. an unlock retried with one key is applied once");
}

// ---- 3. four members enter Q1 together: one deadline -------------------------------------------------------------
for (const t of [3, 4, 5, 6, 7, 8]) await must(`select ${unlock(t, 1, 1, 300 + t)}`);
{
  const rs = (await Promise.all([1, 2, 3, 4].map((s) => held(enter(3, s, 1, 310 + s))))).map(json);
  assert.equal(
    rs.filter((j) => j.started_now).length,
    1,
    "exactly one request starts the question",
  );
  assert.equal(
    new Set(rs.map((j) => j.question.deadline)).size,
    1,
    "every member observes the same deadline",
  );
  assert.equal(
    await one(
      `select (timer_deadline = activated_at + interval '240 seconds')::text || '/' || state from team_questions where team_id = '${team(3)}' and question_id = 1`,
    ),
    "true/ACTIVE",
    "the timer starts at activation",
  );
  assert.equal(
    await count(
      `from audit_events where team_id = '${team(3)}' and event_type = 'QUESTION_STARTED'`,
    ),
    "1",
  );
  // a later entry never restarts it
  const before = await one(
    `select timer_deadline from team_questions where team_id = '${team(3)}' and question_id = 1`,
  );
  await sleep(1200);
  const late = json(await psql(`select ${enter(3, 2, 1, 320)}`));
  assert.equal(late.started_now, false);
  assert.equal(
    await one(
      `select timer_deadline from team_questions where team_id = '${team(3)}' and question_id = 1`,
    ),
    before,
    "a second entry does not restart the timer",
  );
  console.log("ok    3. four members entering Q1 together share one deadline");
}

// ---- 4. start_question retried with one key ----------------------------------------------------------------------
{
  const rs = (await Promise.all([1, 2, 3, 4].map(() => held(enter(4, 1, 1, 400))))).map(json);
  assert.equal(rs.filter((j) => j.started_now && !j.replayed).length, 1);
  assert.equal(rs.filter((j) => j.replayed).length, 3);
  assert.equal(new Set(rs.map((j) => j.question.deadline)).size, 1);
  assert.equal(
    await count(
      `from audit_events where team_id = '${team(4)}' and event_type = 'QUESTION_STARTED'`,
    ),
    "1",
  );
  console.log("ok    4. a retried start_question starts once");
}

// ---- 5. four members submit together -----------------------------------------------------------------------------
{
  await must(`select ${enter(5, 1, 1, 500)}`);
  const rs = await Promise.all(
    [1, 2, 3, 4].map((s) => held(submit(5, s, 1, `answer ${s}`, 510 + s))),
  );
  assert.equal(rs.filter((r) => r.code === 0).length, 1, "one submission wins");
  for (const f of codes(rs)) assert.match(f, /SUBMISSION_PENDING/, f);
  assert.equal(
    await count(
      `from submissions where team_id = '${team(5)}' and question_id = 1 and status = 'PENDING'`,
    ),
    "1",
  );
  assert.equal(await count(`from submissions where team_id = '${team(5)}'`), "1");
  assert.equal(
    await one(`select state from team_questions where team_id = '${team(5)}' and question_id = 1`),
    "PENDING_APPROVAL",
  );
  console.log("ok    5. four simultaneous submits: one pending submission");
}

// ---- 6. a submit retried with one key ----------------------------------------------------------------------------
{
  await must(`select ${enter(6, 1, 1, 600)}`);
  const rs = (
    await Promise.all([1, 2, 3, 4].map(() => held(submit(6, 2, 1, "same answer", 610))))
  ).map(json);
  assert.equal(rs.filter((j) => !j.replayed).length, 1);
  assert.equal(rs.filter((j) => j.replayed).length, 3);
  assert.equal(
    await count(`from submissions where team_id = '${team(6)}'`),
    "1",
    "no duplicate submission",
  );
  assert.equal(
    await count(
      `from audit_events where team_id = '${team(6)}' and event_type = 'ANSWER_SUBMITTED'`,
    ),
    "1",
  );
  console.log("ok    6. a retried submit creates one submission");
}

// ---- 7. a submit queues behind another session while the deadline passes -------------------------------------------
{
  // team 7: Q1 active with a deadline 1.5 s away; session A holds the team lock for 3 s (saving a draft); the
  // submit arrives at ~0.3 s, queues on the lock, and obtains it only after the deadline.
  await must(`select ${enter(7, 1, 1, 700)}`);
  await must(
    `update team_questions set timer_deadline = clock_timestamp() + interval '1500 milliseconds' where team_id = '${team(7)}' and question_id = 1`,
  );
  const holder = held(
    `public.save_draft('${team(7)}', '${member(7, 1)}', 1::smallint, 'draft', 0, '')`,
    3,
  );
  await sleep(300);
  const racer = psql(`select ${submit(7, 2, 1, "late answer", 710)}`);
  const [h, r] = await Promise.all([holder, racer]);
  assert.equal(h.code, 0, h.stderr);
  assert.notEqual(r.code, 0, "the late submit must be refused");
  assert.match(r.stderr, /QUESTION_TIMED_OUT/, r.stderr);
  assert.equal(await count(`from submissions where team_id = '${team(7)}'`), "0", "nothing stored");
  assert.equal(
    await one(`select state from team_questions where team_id = '${team(7)}' and question_id = 1`),
    "ACTIVE",
    "the refused request changed nothing (the timeout is materialised by the next successful mutation)",
  );
  // the next successful mutation settles it, at the deadline
  await must(`select ${unlock(7, 1, 2, 720)}`);
  assert.equal(
    await one(
      `select state || '/' || (timed_out_at <= clock_timestamp() - interval '1 second')::text from team_questions where team_id = '${team(7)}' and question_id = 1`,
    ),
    "TIMED_OUT/true",
  );
  console.log(
    "ok    7. a submit that obtains the lock after the deadline is refused; no submission exists",
  );
}

// ---- 8. two reviewers approve one submission ---------------------------------------------------------------------
{
  const sub = await pendingId(5, 1);
  const rs = await Promise.all([
    held(approve(ADMIN, sub, 800)),
    held(approve(SUPER, sub, 801)),
    held(approve(ADMIN, sub, 802)),
  ]);
  assert.equal(rs.filter((r) => r.code === 0).length, 1, "one approval wins");
  for (const f of codes(rs)) assert.match(f, /SUBMISSION_NOT_PENDING/, f);
  assert.equal(await coins(5), "450", "the fixed reward (50) is paid once: 500 - 100 + 50");
  assert.equal(
    await count(`from coin_transactions where team_id = '${team(5)}' and type = 'QUESTION_REWARD'`),
    "1",
  );
  assert.equal(
    await one(
      `select string_agg(question_id || ':' || state, ',' order by question_id) from team_questions where team_id = '${team(5)}' and question_id <= 3`,
    ),
    "1:APPROVED,2:ACTIVE,3:LOCKED",
    "the next question is ACTIVE, the one after stays LOCKED",
  );
  // team 6: the same approval retried with one key
  const sub6 = await pendingId(6, 1);
  const rs6 = (await Promise.all([1, 2, 3].map(() => held(approve(ADMIN, sub6, 810))))).map(json);
  assert.equal(rs6.filter((j) => !j.replayed).length, 1);
  assert.equal(rs6.filter((j) => j.replayed).length, 2);
  assert.equal(await coins(6), "450");
  assert.equal(
    await count(`from coin_transactions where team_id = '${team(6)}' and type = 'QUESTION_REWARD'`),
    "1",
  );
  console.log("ok    8. approval and reward happen once; a retry storm replays");
}

// ---- 9. approve races disapprove ----------------------------------------------------------------------------------
{
  // team 4: submit, then the two decisions arrive together
  await must(`select ${submit(4, 3, 1, "contested", 900)}`);
  const sub = await pendingId(4, 1);
  const rs = await Promise.all([
    held(approve(ADMIN, sub, 901)),
    held(`public.disapprove_submission('${SUPER}', '${sub}', 'no', '${key(902)}')`),
  ]);
  assert.equal(rs.filter((r) => r.code === 0).length, 1, "exactly one decision wins");
  for (const f of codes(rs)) assert.match(f, /SUBMISSION_NOT_PENDING/, f);
  const status = await one(`select status from submissions where id = '${sub}'`);
  const q = await one(
    `select state from team_questions where team_id = '${team(4)}' and question_id = 1`,
  );
  const reward = await count(
    `from coin_transactions where team_id = '${team(4)}' and type = 'QUESTION_REWARD'`,
  );
  if (status === "APPROVED") {
    assert.equal(q, "APPROVED");
    assert.equal(reward, "1");
    assert.equal(await coins(4), "450");
  } else {
    assert.equal(status, "REJECTED");
    assert.equal(q, "ACTIVE");
    assert.equal(reward, "0");
    assert.equal(await coins(4), "400");
  }
  console.log(`ok    9. approve vs disapprove: one decision won (${status}), state consistent`);
}

// ---- 10. the team timer and the question timer are independent -------------------------------------------------
{
  assert.equal(
    await one(
      `select (ends_at - started_at = interval '14400 seconds')::text from teams where id = '${team(3)}'`,
    ),
    "true",
    "the team timer is 14400 s from the first valid member, whatever the questions did",
  );
  assert.equal(
    await one(
      `select count(distinct timer_deadline) from team_questions where team_id in ('${team(3)}', '${team(4)}', '${team(5)}') and state = 'ACTIVE'`,
    ),
    "3",
    "each team/question has its own deadline",
  );
  assert.equal(
    await one(
      `select (timer_deadline < t.ends_at)::text from team_questions q join teams t on t.id = q.team_id where q.team_id = '${team(3)}' and q.question_id = 1`,
    ),
    "true",
  );
  console.log("ok    10. team and question timers are independent");
}

// ---- 11. refresh / reconnect: reads change nothing ------------------------------------------------------------
{
  const before = await one(
    `select (select string_agg(state_version::text, ',' order by id) from teams where id in (${TEAMS.map((n) => `'${team(n)}'`).join(",")}))
        || '|' || (select count(*) from team_questions) || '|' || (select count(*) from audit_events) || '|' || (select count(*) from submissions)`,
  );
  const reads = [];
  for (let i = 0; i < 6; i++)
    for (const n of [3, 5])
      reads.push(
        psql(
          `select public.get_team_state('${team(n)}', '${member(n, 1)}'); select public.get_question_for_team('${team(n)}', '${member(n, 2)}', 1::smallint);`,
        ),
      );
  for (const r of await Promise.all(reads)) assert.equal(r.code, 0, r.stderr);
  const after = await one(
    `select (select string_agg(state_version::text, ',' order by id) from teams where id in (${TEAMS.map((n) => `'${team(n)}'`).join(",")}))
        || '|' || (select count(*) from team_questions) || '|' || (select count(*) from audit_events) || '|' || (select count(*) from submissions)`,
  );
  assert.equal(after, before, "reads create no state");
  console.log("ok    11. repeated reads (refresh/reconnect) create no state");
}
console.log("gameplay concurrency tests passed");
