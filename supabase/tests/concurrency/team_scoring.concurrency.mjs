// Multi-connection tests for B16: scoring, the live leaderboard and the UFM penalty under concurrent load.
// Plain-SQL tests cannot open parallel sessions, so this script uses many `psql` processes against the scratch database that
// scripts/db-verify.mjs created (VERIFY_DB_URL). It commits its own rows (the scratch database is dropped afterwards).
//
// The database clock is PINNED for the whole script (database-level app.test_now), so a score can only change because of a
// state change - never because a minute boundary happened to tick - and every expectation below is exact. Lock timing is real:
// each writing session holds the team lock for a moment (`pg_sleep` inside the transaction) so the others genuinely queue.
//
//    A. sixteen teams get their first answer approved at the same time while eight readers poll both boards
//         -> every observed score of every team is one of the two legitimate values (never "coins paid, question not
//            counted"), ranks are 1..N in order, `me` is the same row as in `rows`, the unstarted teams are last
//    B. at the same time: four teams Final Submit, four teams are penalised (two of them race a Final Submit, two are
//       penalised four times over), four teams expire by timer (finalize_team_if_due + the sweeper), four teams keep playing
//         -> one freeze per team, one UFM audit row, no deadlock, readers never see a team move backwards
//    C. a burst of 200 concurrent board reads on a quiet database -> identical rankings
//    D. no drift: the same boards, re-read after the terminal events, are identical
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const url = process.env.VERIFY_DB_URL;
if (!url) {
  console.error("concurrency test: VERIFY_DB_URL is not set (run it through `npm run db:verify`).");
  process.exit(2);
}

const SUPER = "00000000-0000-0000-0000-0000000000f1";
const ADMIN = "00000000-0000-0000-0000-0000000000f2";
const nn = (n) => String(n).padStart(2, "0");
const team = (n) => `00000000-0000-0000-0000-0000000b${nn(n)}00`;
const member = (n, s) => `00000000-0000-0000-0000-0000000b${nn(n)}0${s}`;
const code = (n) => `S${nn(n)}`;
const key = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TEAMS = Array.from({ length: 16 }, (_, i) => i + 1);
const SUBMITTERS = [1, 2, 3, 4];
const PENALISED = [5, 6, 7, 8];
const RACERS = [5, 6]; // penalty races Final Submit
const TWICE = [7, 8]; // penalised by four requests at once
const EXPIRING = [9, 10, 11, 12];
const PLAYING = [13, 14, 15, 16];

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
const held = (call, hold = 0.4) =>
  psql(`begin;\nselect ${call};\nselect pg_sleep(${hold});\ncommit;`);
const one = (sql) => must(sql);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const staffBoard = () => `public.get_leaderboard('${ADMIN}')`;
const teamBoard = (n) => `public.get_team_leaderboard('${team(n)}', '${member(n, 1)}')`;
const approve = (sub, k) => `public.approve_submission('${ADMIN}', '${sub}', '${key(k)}')`;
const finalSubmit = (n, k) =>
  `public.final_submit('${team(n)}', '${member(n, 1)}', true, '${key(k)}')`;
const penalize = (n, k) => `public.penalize_team('${ADMIN}', '${team(n)}', '${key(k)}')`;

// ---- fixtures (committed): sixteen teams x four members, a pinned clock, competition RUNNING --------------------------
const dbName = await one(`select current_database()`);
const FIX = await one(
  `select to_char(date_trunc('second', now()) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
);
await must(`
alter database "${dbName}" set app.allow_test_clock = 'on';
alter database "${dbName}" set app.test_now = '${FIX}';
insert into staff_users (id, username, display_name, password_hash, role)
values ('${SUPER}', 'conc_super', 'Concurrency Super', 'TEST-NOT-A-HASH', 'SUPER_ADMIN') on conflict (id) do nothing;
insert into staff_users (id, username, display_name, password_hash, role, created_by)
values ('${ADMIN}', 'conc_admin', 'Concurrency Admin', 'TEST-NOT-A-HASH', 'ADMIN', '${SUPER}') on conflict (id) do nothing;
${TEAMS.map(
  (n) => `
insert into teams (id, team_code, name, login_id, password_hash, admin_id, coins)
values ('${team(n)}', '${code(n)}', 'Scoring ${n}', 'score_team_${n}', 'TEST-NOT-A-HASH', '${ADMIN}', 500);
insert into coin_transactions (team_id, type, amount, balance_after, created_at) values ('${team(n)}', 'INITIAL_GRANT', 500, 500, now());
insert into team_members (id, team_id, slot, admission_no)
select ('00000000-0000-0000-0000-0000000b${nn(n)}0' || s)::uuid, '${team(n)}', s, 'SCO${nn(n)}' || s from generate_series(1, 4) s;`,
).join("\n")}
update competition set status = 'RUNNING', paused_at = null, ended_at = null, opened_at = coalesce(opened_at, now()) where id = 1;
`);
await Promise.all(
  TEAMS.map(async (n) => {
    const r = json(
      await psql(
        `select public.start_team_competition('${team(n)}', '${member(n, 1)}', '${key(20000 + n)}')`,
      ),
    );
    assert.equal(r.state.team.status, "RUNNING");
    await must(
      `select public.unlock_theme('${team(n)}', '${member(n, 1)}', 1::smallint, '${key(20100 + n)}')`,
    );
    await must(
      `select public.start_question('${team(n)}', '${member(n, 1)}', 1::smallint, '${key(20200 + n)}')`,
    );
    await must(
      `select public.submit_answer('${team(n)}', '${member(n, 1)}', 1::smallint, 'ans', 'because', '${key(20300 + n)}')`,
    );
  }),
);
const sub = {};
for (const n of TEAMS)
  sub[n] = await one(
    `select id from submissions where team_id = '${team(n)}' and question_id = 1 and status = 'PENDING'`,
  );
// Teams that were created by the other concurrency scripts are part of the board too; they are not ours to assert on.
const unstarted = new Set(
  (
    await one(
      `select coalesce(string_agg(team_code, ','), '') from teams where status = 'NOT_STARTED'`,
    )
  )
    .split(",")
    .filter(Boolean),
);
const total = Number(await one(`select count(*) from teams`));
const BEFORE = 400; // 500 coins - the 100 unlock, minute 0
const AFTER = 550; // + 100 for the solved question + 50 reward coins
const TERMINAL_EXPIRED = AFTER - 240 * 5; // 240 minutes taken

// ---- readers ---------------------------------------------------------------------------------------------------------
// One psql session = one reader: it alternates the staff board and a participant board, `loops` times, and prints each JSON.
const reader = (n, loops) =>
  psql(
    Array.from(
      { length: loops },
      () =>
        `select ${staffBoard()};\nselect pg_sleep(0.03);\nselect ${teamBoard(n)};\nselect pg_sleep(0.03);`,
    ).join("\n"),
  );
const observed = (r) => {
  assert.equal(r.code, 0, `reader failed: ${r.stderr}`);
  assert.ok(!/deadlock/i.test(r.stderr));
  return r.stdout
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l));
};
// structural coherence of ONE board payload
const coherent = (b) => {
  assert.equal(b.rows.length, total, "every team is on every board");
  b.rows.forEach((row, i) => {
    assert.equal(row.rank, i + 1, "ranks are 1..N in order");
    assert.deepEqual(Object.keys(row).sort(), ["rank", "score", "team_id"]);
  });
  let seenUnstarted = false;
  for (let i = 0; i < b.rows.length; i += 1) {
    const isUn = unstarted.has(b.rows[i].team_id);
    if (seenUnstarted) assert.ok(isUn, "a started team is never ranked below an unstarted one");
    seenUnstarted ||= isUn;
    if (i > 0 && !isUn) {
      assert.ok(
        b.rows[i - 1].score >= b.rows[i].score,
        `scores descend: ${b.rows[i - 1].score} then ${b.rows[i].score}`,
      );
    }
  }
  if (b.me) assert.deepEqual(b.me, b.rows[b.me.rank - 1], "`me` is the same row as in `rows`");
};
const scoreOf = (b, n) => b.rows.find((r) => r.team_id === code(n))?.score;

// ---- A. simultaneous approvals while readers poll ---------------------------------------------------------------------
{
  const readers = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => reader(12 + (i % 4) + 1, 25));
  await sleep(150);
  const writers = TEAMS.map((n) => held(approve(sub[n], 21000 + n), 0.4));
  const all = await Promise.all([...writers, ...readers]);
  for (const w of all.slice(0, TEAMS.length)) assert.equal(w.code, 0, w.stderr);
  const seen = new Map(); // team -> set of observed scores
  for (const r of all.slice(TEAMS.length)) {
    const boards = observed(r);
    assert.ok(boards.length >= 25);
    for (const b of boards) {
      coherent(b);
      for (const n of TEAMS) {
        const s = scoreOf(b, n);
        assert.ok(
          s === BEFORE || s === AFTER,
          `team ${n}: torn score ${s} (coins and question state must change together)`,
        );
        (seen.get(n) ?? seen.set(n, new Set()).get(n)).add(s);
      }
    }
    // a reader never watches a team go back
    const per = (n) => boards.map((b) => scoreOf(b, n)).filter((s) => s !== undefined);
    for (const n of TEAMS) {
      const xs = per(n);
      for (let i = 1; i < xs.length; i += 1)
        assert.ok(xs[i] >= xs[i - 1], `team ${n} went backwards for one reader`);
    }
  }
  const final = json(await psql(`select ${staffBoard()}`));
  coherent(final);
  for (const n of TEAMS)
    assert.equal(scoreOf(final, n), AFTER, `team ${n} scored after its approval`);
  const mixed = [...seen.values()].filter((s) => s.size === 2).length;
  console.log(
    `ok    A. 16 simultaneous approvals under 8 polling readers: no torn score (${mixed} teams were seen changing)`,
  );
}

// ---- B. terminal events across many teams at once ---------------------------------------------------------------------
{
  // age four teams past their end (the pinned clock stays put): started 4 h and one minute before the pinned instant
  await must(`
    update teams set started_at = '${FIX}'::timestamptz - interval '4 hours 1 minute',
                     ends_at = '${FIX}'::timestamptz - interval '1 minute'
     where id in (${EXPIRING.map((n) => `'${team(n)}'`).join(",")});`);
  const readers = [1, 2, 3, 4, 5, 6].map((i) => reader(13 + (i % 4), 30));
  await sleep(150);
  const writers = [
    ...SUBMITTERS.map((n) => held(finalSubmit(n, 22000 + n), 0.5)),
    ...RACERS.flatMap((n) => [
      held(finalSubmit(n, 22100 + n), 0.5),
      held(penalize(n, 22200 + n), 0.5),
    ]),
    ...TWICE.flatMap((n) => [0, 1, 2, 3].map((j) => held(penalize(n, 22300 + n * 10 + j), 0.5))),
    ...EXPIRING.map((n) => held(`public.finalize_team_if_due('${team(n)}')`, 0.5)),
    held(`public.expire_due_teams(200)`, 0.5),
  ];
  const all = await Promise.all([...writers, ...readers]);
  const writes = all.slice(0, writers.length);
  for (const w of writes) {
    if (w.code !== 0) {
      assert.ok(!/deadlock/i.test(w.stderr), `deadlock: ${w.stderr}`);
      // the only legitimate losers: a Final Submit that met an already penalised (ended) team
      assert.match(w.stderr, /TEAM_ENDED|ALREADY_SUBMITTED/, `unexpected failure: ${w.stderr}`);
    }
  }
  // exactly one effect per team
  for (const n of [...SUBMITTERS, ...PENALISED, ...EXPIRING]) {
    const row = (
      await one(
        `select status || '|' || (final_score is not null) from teams where id = '${team(n)}'`,
      )
    ).split("|");
    assert.ok(["FINAL_SUBMITTED", "ENDED"].includes(row[0]), `team ${n} is terminal: ${row[0]}`);
    assert.equal(row[1], "true", `team ${n}: the score was frozen`);
  }
  for (const n of PENALISED)
    assert.equal(
      await one(
        `select count(*) from audit_events where team_id = '${team(n)}' and event_type = 'UFM_PENALIZED'`,
      ),
      "1",
      `team ${n}: one UFM_PENALIZED row`,
    );
  for (const n of TWICE)
    assert.equal(
      await one(
        `select count(*) from audit_events where team_id = '${team(n)}' and event_type = 'TEAM_ENDED'`,
      ),
      "1",
      `team ${n}: ended once`,
    );
  for (const n of [...SUBMITTERS, ...EXPIRING]) {
    assert.equal(
      await one(
        `select count(*) from audit_events where team_id = '${team(n)}' and event_type = 'UFM_PENALIZED'`,
      ),
      "0",
    );
  }
  for (const n of EXPIRING)
    assert.equal(
      await one(
        `select count(*) from audit_events where team_id = '${team(n)}' and event_type = 'TEAM_ENDED'`,
      ),
      "1",
      `team ${n}: expired once`,
    );
  for (const n of PLAYING)
    assert.equal(
      await one(`select status from teams where id = '${team(n)}'`),
      "RUNNING",
      `team ${n} is still playing`,
    );

  for (const r of all.slice(writers.length)) {
    const boards = observed(r);
    for (const b of boards) coherent(b);
    for (const n of SUBMITTERS)
      for (const b of boards)
        assert.equal(scoreOf(b, n), AFTER, `team ${n}: Final Submit keeps the score`);
    for (const n of PLAYING) for (const b of boards) assert.equal(scoreOf(b, n), AFTER);
    for (const n of PENALISED) {
      const xs = boards.map((b) => scoreOf(b, n));
      xs.forEach((s) => assert.ok(s === AFTER || s === 0, `team ${n}: ${s}`));
      for (let i = 1; i < xs.length; i += 1)
        assert.ok(
          !(xs[i - 1] === 0 && xs[i] === AFTER),
          `team ${n}: a penalty was undone for a reader`,
        );
    }
    for (const n of EXPIRING) {
      const xs = boards.map((b) => scoreOf(b, n));
      xs.forEach((s) => assert.equal(s, TERMINAL_EXPIRED, `team ${n}: expired score ${s}`));
    }
  }
  // the official board after the storm
  const b = json(await psql(`select ${staffBoard()}`));
  coherent(b);
  for (const n of SUBMITTERS) assert.equal(scoreOf(b, n), AFTER);
  for (const n of PENALISED) assert.equal(scoreOf(b, n), 0);
  for (const n of EXPIRING) assert.equal(scoreOf(b, n), TERMINAL_EXPIRED);
  for (const n of PLAYING) assert.equal(scoreOf(b, n), AFTER);
  // the gameplay snapshot of a penalised team is kept (history intact); the freeze matches the live basis
  for (const n of PENALISED)
    assert.equal(
      await one(`select final_score from teams where id = '${team(n)}'`),
      String(AFTER),
      `team ${n}: gameplay score kept`,
    );
  for (const n of EXPIRING)
    assert.equal(
      await one(`select final_minutes_taken from teams where id = '${team(n)}'`),
      "240",
      `team ${n}: 240 minutes`,
    );
  assert.equal(
    await one(
      `select count(*) from submissions where team_id in (${PENALISED.map((n) => `'${team(n)}'`).join(",")})`,
    ),
    "4",
    "answers intact",
  );
  assert.equal(
    await one(`select count(*) from app.invariant_coin_balance_mismatch`),
    "0",
    "ledger chain intact",
  );
  console.log(
    "ok    B. 16 teams reaching terminal states (submit / penalty / timer) at once: one freeze each, one audit, no backward step",
  );
}

// ---- C. a burst of concurrent reads on a quiet database ---------------------------------------------------------------
{
  const t0 = Date.now();
  const calls = [];
  for (let i = 0; i < 100; i += 1) {
    calls.push(staffBoard());
    calls.push(teamBoard(13 + (i % 4)));
  }
  const results = [];
  for (let i = 0; i < calls.length; i += 40) {
    results.push(...(await Promise.all(calls.slice(i, i + 40).map((c) => psql(`select ${c}`)))));
  }
  const boards = results.map(json);
  const canon = (b) => JSON.stringify(b.rows);
  assert.equal(
    new Set(boards.map(canon)).size,
    1,
    "all 200 concurrent reads saw one identical ranking",
  );
  boards.forEach(coherent);
  for (const b of boards.filter((x) => x.me)) assert.match(b.me.team_id, /^S1[3-6]$/);
  console.log(
    `ok    C. 200 concurrent board reads: one identical ranking (${Date.now() - t0} ms in total)`,
  );
}

// ---- D. no drift -----------------------------------------------------------------------------------------------------
{
  const before = await one(
    `select string_agg(team_code || ':' || final_score || ':' || final_minutes_taken, ',' order by team_code) from teams where team_code like 'S%' and final_score is not null`,
  );
  const board1 = json(await psql(`select ${staffBoard()}`)).rows;
  await sleep(1500);
  await must(`select public.expire_due_teams(200)`);
  const after = await one(
    `select string_agg(team_code || ':' || final_score || ':' || final_minutes_taken, ',' order by team_code) from teams where team_code like 'S%' and final_score is not null`,
  );
  assert.equal(after, before, "frozen scores did not change");
  assert.deepEqual(
    json(await psql(`select ${staffBoard()}`)).rows,
    board1,
    "the board did not move",
  );
  console.log("ok    D. frozen scores and the board are stable");
}

await must(
  `alter database "${dbName}" reset app.test_now; alter database "${dbName}" reset app.allow_test_clock;`,
);
console.log("scoring concurrency tests passed");
