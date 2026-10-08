// Multi-connection tests for the B15 economy and finalization engine (hints, Buy Time, Final Submit, the sweeper).
// Plain-SQL tests cannot open parallel sessions, so this script uses several `psql` processes against the scratch
// database that scripts/db-verify.mjs created (VERIFY_DB_URL). It commits its own rows (the scratch database is
// dropped afterwards) and runs on the real clock. Each writing session holds the team lock for ~1 s (`pg_sleep`
// inside the transaction) so the others genuinely queue behind it.
//
//    1. four members buy the same Hint 1 (four keys)              -> one charge, three `already_owned`
//    2. one member retries a hint purchase four times (one key)   -> one charge, three replays
//    3. four members buy time with the same expected count        -> one purchase, three STALE_PURCHASE_COUNT
//    4. coin race: the balance fits exactly one purchase          -> exactly one succeeds, balance never negative
//    5. four members final-submit (four keys)                     -> one FINAL_SUBMITTED, three ALREADY_SUBMITTED
//    6. final submit races submit_answer, in both orders          -> consistent either way
//    7. final submit vs finalize_team_if_due / expire_due_teams   -> one terminal status, one TEAM_ENDED audit
//    8. the sweeper runs while a participant holds the team lock  -> it skips the team instead of blocking
//    9. an approval races a final submit                          -> the reward is paid once, the team ends frozen
//   10. Buy Time races the question deadline                      -> extended or QUESTION_TIMED_OUT, never both
//   11. retry storms with one key for Buy Time and Final Submit   -> one effect each
//   12. deadlock probe: randomized interleavings over four teams  -> no "deadlock detected", invariants hold
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const url = process.env.VERIFY_DB_URL;
if (!url) {
  console.error("concurrency test: VERIFY_DB_URL is not set (run it through `npm run db:verify`).");
  process.exit(2);
}

// There may be only one Super Admin, so these are the same two staff rows the other concurrency scripts create
// (inserted here only when those scripts have not run).
const SUPER = "00000000-0000-0000-0000-0000000000f1";
const ADMIN = "00000000-0000-0000-0000-0000000000f2";
const nn = (n) => String(n).padStart(2, "0");
const team = (n) => `00000000-0000-0000-0000-0000000d${nn(n)}00`;
const member = (n, s) => `00000000-0000-0000-0000-0000000d${nn(n)}0${s}`;
const key = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TEAMS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const PROBE = [13, 14, 15, 16];
const LOW_COIN_TEAM = 4; // starts with exactly one purchase's worth of coins left after the theme unlock

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
// a session that merely holds the team row lock
const lockTeam = (t, hold) =>
  psql(
    `begin;\nselect 1 from teams where id = '${team(t)}' for update;\nselect pg_sleep(${hold});\ncommit;`,
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = (rs) => rs.filter((r) => r.code !== 0).map((r) => r.stderr);
const successes = (rs) => rs.filter((r) => r.code === 0);
const one = (sql) => must(sql);
const count = (sql) => one(`select count(*) ${sql}`);
const coins = (t) => one(`select coins from teams where id = '${team(t)}'`);

const unlock = (t, s, theme, k) =>
  `public.unlock_theme('${team(t)}', '${member(t, s)}', ${theme}::smallint, '${key(k)}')`;
const enter = (t, s, q, k) =>
  `public.start_question('${team(t)}', '${member(t, s)}', ${q}::smallint, '${key(k)}')`;
const submit = (t, s, q, ans, k) =>
  `public.submit_answer('${team(t)}', '${member(t, s)}', ${q}::smallint, '${ans}', 'because', '${key(k)}')`;
const hint = (t, s, q, tier, k) =>
  `public.buy_hint('${team(t)}', '${member(t, s)}', ${q}::smallint, ${tier}::smallint, '${key(k)}')`;
const time = (t, s, q, opt, expected, k) =>
  `public.buy_time('${team(t)}', '${member(t, s)}', ${q}::smallint, ${opt}::smallint, ${expected}, '${key(k)}')`;
const finalSubmit = (t, s, k) =>
  `public.final_submit('${team(t)}', '${member(t, s)}', true, '${key(k)}')`;
const approve = (sub, k) => `public.approve_submission('${ADMIN}', '${sub}', '${key(k)}')`;
const pendingId = (t, q) =>
  one(
    `select id from submissions where team_id = '${team(t)}' and question_id = ${q} and status = 'PENDING'`,
  );
const deadline = (t, q) =>
  one(
    `select extract(epoch from timer_deadline)::numeric(20,3) from team_questions where team_id = '${team(t)}' and question_id = ${q}`,
  );
const endsAt = (t) => one(`select ends_at from teams where id = '${team(t)}'`);
const ledgerCount = (t, type) =>
  count(`from coin_transactions where team_id = '${team(t)}' and type = '${type}'`);
const auditCount = (t, type) =>
  count(`from audit_events where team_id = '${team(t)}' and event_type = '${type}'`);
const invariantsClean = async (label) => {
  assert.equal(
    await one(`select count(*) from app.invariant_coin_balance_mismatch`),
    "0",
    `${label}: ledger chain intact`,
  );
  assert.equal(
    await one(`select count(*) from teams where coins < 0`),
    "0",
    `${label}: no negative balance`,
  );
};

// ---- fixtures (committed): staff, sixteen teams x four members, competition RUNNING --------------------------------
await must(`
insert into staff_users (id, username, display_name, password_hash, role)
values ('${SUPER}', 'conc_super', 'Concurrency Super', 'TEST-NOT-A-HASH', 'SUPER_ADMIN') on conflict (id) do nothing;
insert into staff_users (id, username, display_name, password_hash, role, created_by)
values ('${ADMIN}', 'conc_admin', 'Concurrency Admin', 'TEST-NOT-A-HASH', 'ADMIN', '${SUPER}') on conflict (id) do nothing;
${TEAMS.map((n) => {
  return `
insert into teams (id, team_code, name, login_id, password_hash, admin_id, coins)
values ('${team(n)}', 'E${nn(n)}', 'Economy ${n}', 'eco_team_${n}', 'TEST-NOT-A-HASH', '${ADMIN}', 500);
insert into coin_transactions (team_id, type, amount, balance_after, created_at) values ('${team(n)}', 'INITIAL_GRANT', 500, 500, now());${
    n === LOW_COIN_TEAM
      ? `
insert into coin_transactions (team_id, type, amount, balance_after, staff_id, created_at) values ('${team(n)}', 'ADMIN_ADJUSTMENT', -380, 120, '${ADMIN}', now());
update teams set coins = 120 where id = '${team(n)}';`
      : ""
  }
insert into team_members (id, team_id, slot, admission_no)
select ('00000000-0000-0000-0000-0000000d${nn(n)}0' || s)::uuid, '${team(n)}', s, 'ECO${nn(n)}' || s from generate_series(1, 4) s;`;
}).join("\n")}
update competition set status = 'RUNNING', paused_at = null, ended_at = null, opened_at = coalesce(opened_at, now()) where id = 1;
`);
for (const n of TEAMS) {
  const r = json(
    await psql(
      `select public.start_team_competition('${team(n)}', '${member(n, 1)}', '${key(9000 + n)}')`,
    ),
  );
  assert.equal(r.state.team.status, "RUNNING");
  assert.equal(r.state.team.duration_seconds, 14400, "new teams get the 4 h allowance");
  await must(`select ${unlock(n, 1, 1, 9100 + n)}`);
  await must(`select ${enter(n, 1, 1, 9200 + n)}`);
}
// prices come from the data: read them once instead of hard-coding them
const HINT1 = Number(await one(`select cost from hints where question_id = 1 and tier = 1`));
const OPT1_COST = Number(
  await one(`select cost from question_buy_time_options where question_id = 1 and id = 1`),
);
const OPT1_SECONDS = Number(
  await one(`select seconds from question_buy_time_options where question_id = 1 and id = 1`),
);
const START_COINS = Number(await coins(1)); // after the unlock
assert.ok(HINT1 > 0 && OPT1_COST > 0 && OPT1_SECONDS > 0);

// ---- 1. four members buy the same Hint 1 ------------------------------------------------------------------------
{
  const rs = (await Promise.all([1, 2, 3, 4].map((s) => held(hint(1, s, 1, 1, 100 + s))))).map(
    json,
  );
  assert.equal(rs.filter((j) => !j.already_owned).length, 1, "exactly one purchase is charged");
  assert.equal(rs.filter((j) => j.already_owned).length, 3, "the others see it already owned");
  assert.equal(await coins(1), String(START_COINS - HINT1), "one charge");
  assert.equal(await count(`from hint_purchases where team_id = '${team(1)}'`), "1");
  assert.equal(await ledgerCount(1, "HINT_PURCHASE"), "1");
  assert.equal(await auditCount(1, "HINT_PURCHASED"), "1");
  for (const j of rs) assert.ok(typeof j.hint.body_md === "string", "everyone gets the text");
  await invariantsClean("1");
  console.log("ok    1. four members buying one hint: one charge, three already_owned");
}

// ---- 2. one key, four simultaneous retries of a hint purchase ----------------------------------------------------
{
  const rs = (await Promise.all([1, 2, 3, 4].map(() => held(hint(2, 1, 1, 1, 200))))).map(json);
  assert.equal(rs.filter((j) => !j.replayed).length, 1, "one real purchase");
  assert.equal(rs.filter((j) => j.replayed).length, 3, "three replays");
  assert.equal(await coins(2), String(START_COINS - HINT1));
  assert.equal(await ledgerCount(2, "HINT_PURCHASE"), "1");
  assert.equal(await auditCount(2, "HINT_PURCHASED"), "1");
  console.log("ok    2. a hint purchase retried with one key is applied once");
}

// ---- 3. four members buy time with the same expected count -------------------------------------------------------
{
  const before = await deadline(3, 1);
  const endBefore = await endsAt(3);
  const rs = await Promise.all([1, 2, 3, 4].map((s) => held(time(3, s, 1, 1, 0, 300 + s))));
  assert.equal(successes(rs).length, 1, "exactly one purchase wins");
  const fs = failures(rs);
  assert.equal(fs.length, 3);
  for (const f of fs) assert.match(f, /STALE_PURCHASE_COUNT/, f);
  assert.equal(await coins(3), String(START_COINS - OPT1_COST), "one charge");
  assert.equal(
    Number(await deadline(3, 1)),
    Number(before) + OPT1_SECONDS,
    "the deadline moved exactly once",
  );
  assert.equal(await endsAt(3), endBefore, "the ultimate timer is untouched");
  assert.equal(await count(`from team_time_purchases where team_id = '${team(3)}'`), "1");
  assert.equal(await ledgerCount(3, "TIME_PURCHASE"), "1");
  assert.equal(await auditCount(3, "TIME_PURCHASED"), "1");
  await invariantsClean("3");
  console.log(
    "ok    3. four members buying time together: one purchase, three STALE_PURCHASE_COUNT",
  );
}

// ---- 4. coin race: the balance fits exactly one purchase --------------------------------------------------------
{
  assert.equal(await coins(LOW_COIN_TEAM), "20", "team 4 starts the race with 20 coins");
  assert.ok(HINT1 === 20 && OPT1_COST === 20, "this scenario needs two prices of exactly 20");
  const rs = await Promise.all([
    held(hint(LOW_COIN_TEAM, 1, 1, 1, 400)),
    held(time(LOW_COIN_TEAM, 2, 1, 1, 0, 401)),
    held(time(LOW_COIN_TEAM, 3, 1, 1, 0, 402)),
    held(time(LOW_COIN_TEAM, 4, 1, 1, 0, 403)),
  ]);
  assert.equal(successes(rs).length, 1, "exactly one of the competing purchases succeeds");
  for (const f of failures(rs)) assert.match(f, /INSUFFICIENT_COINS|STALE_PURCHASE_COUNT/, f);
  assert.equal(await coins(LOW_COIN_TEAM), "0", "the whole balance was spent once");
  assert.equal(
    await one(
      `select count(*) from coin_transactions where team_id = '${team(LOW_COIN_TEAM)}' and type in ('HINT_PURCHASE', 'TIME_PURCHASE')`,
    ),
    "1",
    "one purchase row in the ledger",
  );
  await invariantsClean("4");
  console.log("ok    4. a coin race for the last 20 coins: one purchase, balance 0, ledger intact");
}

// ---- 5. four members final-submit together ------------------------------------------------------------------------
{
  const rs = await Promise.all([1, 2, 3, 4].map((s) => held(finalSubmit(5, s, 500 + s))));
  assert.equal(successes(rs).length, 1, "exactly one final submit wins");
  const fs = failures(rs);
  assert.equal(fs.length, 3);
  for (const f of fs) assert.match(f, /ALREADY_SUBMITTED/, f);
  assert.equal(await one(`select status from teams where id = '${team(5)}'`), "FINAL_SUBMITTED");
  assert.equal(await auditCount(5, "TEAM_FINAL_SUBMITTED"), "1", "one audit row");
  assert.equal(
    await one(
      `select (ended_at = final_submitted_at and ended_at is not null)::text from teams where id = '${team(5)}'`,
    ),
    "true",
  );
  console.log(
    "ok    5. four simultaneous final submits: one FINAL_SUBMITTED, three ALREADY_SUBMITTED",
  );
}

// ---- 6. final submit races submit_answer, in both orders -------------------------------------------------------------
{
  // 6a: the final submit holds the lock first -> the queued submit finds the team frozen and writes nothing
  const a = held(finalSubmit(6, 1, 600), 1.2);
  await sleep(300);
  const b = psql(`select ${submit(6, 2, 1, "late answer", 601)}`);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.code, 0, ra.stderr);
  assert.notEqual(rb.code, 0, "the queued submit must fail");
  assert.match(rb.stderr, /ALREADY_SUBMITTED/, rb.stderr);
  assert.equal(
    await count(`from submissions where team_id = '${team(6)}'`),
    "0",
    "nothing written",
  );

  // 6b: the submit holds the lock first -> both succeed, and the pending answer is counted in the audit payload
  const c = held(submit(7, 2, 1, "early answer", 700), 1.2);
  await sleep(300);
  const d = psql(`select ${finalSubmit(7, 1, 701)}`);
  const [rc, rd] = await Promise.all([c, d]);
  assert.equal(rc.code, 0, rc.stderr);
  assert.equal(rd.code, 0, rd.stderr);
  assert.equal(await one(`select status from teams where id = '${team(7)}'`), "FINAL_SUBMITTED");
  assert.equal(
    await count(`from submissions where team_id = '${team(7)}' and status = 'PENDING'`),
    "1",
    "the pending answer survives for review",
  );
  assert.equal(
    await one(
      `select payload->>'pending_submissions' from audit_events where team_id = '${team(7)}' and event_type = 'TEAM_FINAL_SUBMITTED'`,
    ),
    "1",
  );
  console.log(
    "ok    6. final submit vs submit: either order is consistent, no submission after the freeze",
  );
}

// ---- 7. final submit vs the finalizers at the deadline ------------------------------------------------------------
{
  await must(
    `update teams set ends_at = clock_timestamp() + interval '1500 milliseconds' where id = '${team(8)}'`,
  );
  await sleep(1700); // every session below starts after the deadline
  const rs = await Promise.all([
    psql(`select public.finalize_team_if_due('${team(8)}')`),
    psql(`select public.finalize_team_if_due('${team(8)}')`),
    psql(`select public.expire_due_teams(50)`),
    psql(`select ${finalSubmit(8, 1, 800)}`),
  ]);
  for (const r of rs.slice(0, 3)) assert.equal(r.code, 0, r.stderr);
  assert.notEqual(rs[3].code, 0, "a final submit after the deadline must fail");
  assert.match(rs[3].stderr, /TEAM_ENDED/, rs[3].stderr);
  assert.equal(await one(`select status from teams where id = '${team(8)}'`), "ENDED");
  assert.equal(
    await one(`select (ended_at = ends_at)::text from teams where id = '${team(8)}'`),
    "true",
    "ended_at is the scheduled end",
  );
  assert.equal(await auditCount(8, "TEAM_ENDED"), "1", "one terminal audit");
  assert.equal(await auditCount(8, "TEAM_FINAL_SUBMITTED"), "0", "never both");
  const finalizedByOne = rs
    .slice(0, 2)
    .map((r) => JSON.parse(r.stdout))
    .filter((j) => j.finalized).length;
  assert.equal(finalizedByOne + Number(rs[2].stdout), 1, "exactly one finalizer did the work");
  console.log(
    "ok    7. the deadline: one ENDED status, one TEAM_ENDED audit, never also FINAL_SUBMITTED",
  );
}

// ---- 8. the sweeper skips a team that a participant holds -----------------------------------------------------------
{
  await must(
    `update teams set ends_at = clock_timestamp() + interval '1200 milliseconds' where id = '${team(9)}'`,
  );
  await sleep(1400);
  const holder = lockTeam(9, 3);
  await sleep(500);
  const t0 = Date.now();
  const swept = await psql(`select public.expire_due_teams(50)`);
  const elapsed = Date.now() - t0;
  assert.equal(swept.code, 0, swept.stderr);
  assert.ok(elapsed < 2000, `the sweeper must not wait for the lock (took ${elapsed} ms)`);
  assert.equal(swept.stdout, "0", "nothing else was due, and the held team was skipped");
  assert.equal(await one(`select status from teams where id = '${team(9)}'`), "RUNNING");
  await holder;
  const after = await psql(`select public.expire_due_teams(50)`);
  assert.equal(after.stdout, "1", "the next sweep picks it up");
  assert.equal(await one(`select status from teams where id = '${team(9)}'`), "ENDED");
  assert.equal(
    await one(`select (ended_at = ends_at)::text from teams where id = '${team(9)}'`),
    "true",
  );
  console.log(
    `ok    8. the sweeper skipped a locked team (${elapsed} ms) and caught it on the next run`,
  );
}

// ---- 9. an approval races a final submit ------------------------------------------------------------------------
{
  await must(`select ${submit(10, 1, 1, "42", 1000)}`);
  const sub = await pendingId(10, 1);
  const coinsBefore = Number(await coins(10));
  const rs = await Promise.all([
    held(approve(sub, 1001)),
    held(finalSubmit(10, 2, 1002)),
    held(approve(sub, 1003)),
  ]);
  assert.ok(
    successes(rs).length >= 2,
    `the approval and the final submit both succeed (${failures(rs).join(" | ")})`,
  );
  for (const f of failures(rs)) assert.match(f, /SUBMISSION_NOT_PENDING/, f);
  assert.equal(await one(`select status from teams where id = '${team(10)}'`), "FINAL_SUBMITTED");
  assert.equal(await one(`select status from submissions where id = '${sub}'`), "APPROVED");
  assert.equal(await ledgerCount(10, "QUESTION_REWARD"), "1", "the reward is paid once");
  const reward = Number(
    await one(
      `select amount from coin_transactions where team_id = '${team(10)}' and type = 'QUESTION_REWARD'`,
    ),
  );
  assert.equal(Number(await coins(10)), coinsBefore + reward);
  assert.equal(
    await one(`select state from team_questions where team_id = '${team(10)}' and question_id = 1`),
    "APPROVED",
  );
  await invariantsClean("9");
  console.log(
    "ok    9. approval vs final submit: reward paid once, team frozen with the reward kept",
  );
}

// ---- 10. Buy Time races the question deadline ---------------------------------------------------------------------
{
  // 10a: the deadline passes while the purchase queues -> QUESTION_TIMED_OUT, nothing charged
  await must(
    `update team_questions set timer_deadline = clock_timestamp() + interval '1200 milliseconds' where team_id = '${team(11)}' and question_id = 1`,
  );
  const holder = lockTeam(11, 1.8);
  await sleep(300);
  const late = await psql(`select ${time(11, 2, 1, 1, 0, 1100)}`);
  await holder;
  assert.notEqual(late.code, 0, "an expired question cannot be extended");
  assert.match(late.stderr, /QUESTION_TIMED_OUT/, late.stderr);
  assert.equal(await coins(11), String(START_COINS), "nothing was charged");
  assert.equal(await ledgerCount(11, "TIME_PURCHASE"), "0");

  // 10b: the lock is released well before the deadline -> the purchase extends it
  await must(
    `update team_questions set timer_deadline = clock_timestamp() + interval '20 seconds' where team_id = '${team(12)}' and question_id = 1`,
  );
  const before = await deadline(12, 1);
  const holder2 = lockTeam(12, 0.8);
  await sleep(200);
  const early = json(await psql(`select ${time(12, 2, 1, 1, 0, 1200)}`));
  await holder2;
  assert.equal(early.purchase.seconds, OPT1_SECONDS);
  assert.equal(Number(await deadline(12, 1)), Number(before) + OPT1_SECONDS);
  assert.equal(await coins(12), String(START_COINS - OPT1_COST));
  await invariantsClean("10");
  console.log(
    "ok    10. Buy Time vs the question deadline: extended or QUESTION_TIMED_OUT, never both",
  );
}

// ---- 11. retry storms with one key --------------------------------------------------------------------------------
{
  // team 12 already bought option 1 (scenario 10b): a fresh key, option 2, expected count 1
  const rs = (await Promise.all([1, 2, 3, 4].map(() => held(time(12, 3, 1, 2, 1, 1300))))).map(
    json,
  );
  assert.equal(rs.filter((j) => !j.replayed).length, 1, "one real purchase");
  assert.equal(rs.filter((j) => j.replayed).length, 3, "three replays");
  assert.equal(await count(`from team_time_purchases where team_id = '${team(12)}'`), "2");
  assert.equal(await ledgerCount(12, "TIME_PURCHASE"), "2");
  assert.equal(await auditCount(12, "TIME_PURCHASED"), "2");
  const fs = (await Promise.all([1, 2, 3, 4].map(() => held(finalSubmit(11, 1, 1310))))).map(json);
  assert.equal(fs.filter((j) => !j.replayed).length, 1);
  assert.equal(fs.filter((j) => j.replayed).length, 3);
  assert.equal(await auditCount(11, "TEAM_FINAL_SUBMITTED"), "1");
  assert.equal(
    await count(`from request_log where team_id = '${team(11)}' and idem_key = '${key(1310)}'`),
    "1",
  );
  await invariantsClean("11");
  console.log("ok    11. retry storms with one key apply Buy Time and Final Submit once");
}

// ---- 12. deadlock probe -------------------------------------------------------------------------------------------
{
  let seed = 20261008;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const known =
    /INSUFFICIENT_COINS|STALE_PURCHASE_COUNT|TIME_PURCHASE_LIMIT|HINT_TIER1_REQUIRED|SUBMISSION_PENDING|SUBMISSION_NOT_PENDING|ALREADY_SUBMITTED|QUESTION_NOT_ACTIVE|QUESTION_TIMED_OUT|THEME_ALREADY_UNLOCKED|THEME_LOCKED|NOT_FOUND|TEAM_ENDED|THEME_NOT_AVAILABLE|PREREQUISITE/;
  let n = 5000;
  const all = [];
  for (let wave = 0; wave < 8; wave += 1) {
    const sessions = [];
    for (let i = 0; i < 8; i += 1) {
      const t = pick(PROBE);
      const s = 1 + Math.floor(rnd() * 4);
      const roll = rnd();
      n += 1;
      let call;
      if (roll < 0.2) call = hint(t, s, 1, 1, n);
      else if (roll < 0.3) call = hint(t, s, 1, 2, n);
      else if (roll < 0.5)
        call = time(t, s, 1, 1 + Math.floor(rnd() * 3), Math.floor(rnd() * 3), n);
      else if (roll < 0.65) call = submit(t, s, 1, `a${n}`, n);
      else if (roll < 0.75) call = unlock(t, s, 2, n);
      else if (roll < 0.85) call = finalSubmit(t, s, n);
      else call = `public.get_team_state('${team(t)}', '${member(t, s)}')`;
      sessions.push(held(call, 0.15));
    }
    all.push(...(await Promise.all(sessions)));
    // approve whatever is pending on the probe teams, racing the next wave
    for (const t of PROBE) {
      const sub = await one(
        `select id from submissions where team_id = '${team(t)}' and status = 'PENDING' limit 1`,
      );
      n += 1;
      if (sub) all.push(await held(approve(sub, n), 0.1));
    }
  }
  for (const r of all) {
    if (r.code !== 0) {
      assert.ok(!/deadlock/i.test(r.stderr), `deadlock detected: ${r.stderr}`);
      assert.match(r.stderr, known, `unexpected failure: ${r.stderr}`);
    }
  }
  await invariantsClean("12");
  assert.equal(
    await one(
      `select count(*) from teams where id in (${PROBE.map((p) => `'${team(p)}'`).join(",")}) and (status = 'FINAL_SUBMITTED') <> (final_submitted_at is not null)`,
    ),
    "0",
  );
  const done = all.filter((r) => r.code === 0).length;
  console.log(
    `ok    12. deadlock probe: ${all.length} randomized sessions (${done} succeeded), no deadlock`,
  );
}
console.log("economy concurrency tests passed");
