#!/usr/bin/env node
// Reproducible load benchmark of the B16 participant leaderboard: the REAL Next.js server (production build), the REAL
// route handlers and the REAL SQL (migrations 1-18) on a scratch PostgreSQL, with 100 teams, 300 participant clients and
// simultaneous score-changing events (hints, answers, approvals, theme completion, unlocks) going through the real API.
//
//   npm run build
//   npm i --no-save pg                      # the shim's PostgreSQL client; not a dependency of the app
//   BENCH_DB_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node scripts/bench/leaderboard-bench.mjs \
//        --teams 100 --clients 300 --steady 90 --stress 30 --pool 20 --out bench-result.json
//
// It creates (and drops) a scratch database, starts scripts/bench/pg-rest-shim.mjs (a tiny PostgREST stand-in with a bounded
// connection pool) and `next start`, seeds everything through the real endpoints, and runs:
//   0. DB-only:  EXPLAIN ANALYZE of the ranking query, then `pgbench` with `--clients` direct connections reading
//                get_team_leaderboard (needs `pgbench`; skipped with a notice when it is missing).
//   1. STEADY:   `--clients` browsers polling the way the app does (every 15 s +/- 20 % jitter) while writers change scores.
//   2. STRESS:   the same clients in a closed loop with no waiting (as fast as the server answers) while writers change scores.
//   3. QUIET:    after the writers stop, all clients read at once: every answer must be identical and equal to an INDEPENDENT
//                recomputation of the board from the base tables.
// Every response of every phase is checked (contiguous ranks, `me` = its row, order, only legitimate scores, nobody moves
// backwards). The PostgreSQL clock is pinned (the test clock the SQL tests use), so those checks are exact; consequently the
// benchmark exercises concurrency and load, not the passing of time (that is covered by supabase/tests/150_scoring.test.sql).
// Refuses non-local database hosts. Never run it against production.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir, cpus, totalmem, release } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Agent, request } from "undici";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--"))
      acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]);
    return acc;
  }, []),
);
const TEAMS = Number(args.teams ?? 100);
const UNSTARTED = Number(args.unstarted ?? 5);
const CLIENTS = Number(args.clients ?? 300);
const STEADY_S = Number(args.steady ?? 90);
const STRESS_S = Number(args.stress ?? 30);
const POOL = Number(args.pool ?? 20);
const POLL_MS = Number(args.interval ?? 15_000);
const JITTER = 0.2;
const APP_PORT = Number(args["app-port"] ?? 3300);
const DB_PORT = Number(args["db-port"] ?? 54500);
const PGBENCH_S = Number(args.pgbench ?? 20);
const OUT = args.out;

const adminUrl = process.env.BENCH_DB_ADMIN_URL;
if (!adminUrl) {
  console.error("BENCH_DB_ADMIN_URL is required (a superuser URL of a LOCAL scratch server).");
  process.exit(2);
}
const admin = new URL(adminUrl);
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(admin.hostname)) {
  console.error(`refusing non-local host "${admin.hostname}"`);
  process.exit(2);
}
if (!existsSync(join(root, ".next/BUILD_ID"))) {
  console.error("run `npm run build` first");
  process.exit(2);
}

const dbName = `lbbench_${randomBytes(4).toString("hex")}`;
const urlFor = (name) => {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  return u.toString();
};
const dbUrl = urlFor(dbName);
const APP = `http://localhost:${APP_PORT}`;
const SERVICE_KEY = randomBytes(24).toString("base64url");
const PEPPER = randomBytes(36).toString("base64url");
const PASSWORD = `Bench-${randomBytes(9).toString("base64url")}`;
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
const code = (i) => `B${String(i).padStart(3, "0")}`;

// ---- statistics ------------------------------------------------------------------------------------------------------
const pct = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null;
function stats(values) {
  const s = [...values].sort((a, b) => a - b);
  const r = (x) => (x === null ? null : Math.round(x * 100) / 100);
  return {
    n: s.length,
    avg: r(s.reduce((a, b) => a + b, 0) / (s.length || 1)),
    p50: r(pct(s, 50)),
    p95: r(pct(s, 95)),
    p99: r(pct(s, 99)),
    max: r(s.at(-1) ?? null),
  };
}

// ---- processes -------------------------------------------------------------------------------------------------------
const children = [];
function start(cmd, argv, env, name) {
  const p = spawn(cmd, argv, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.name = name;
  p.output = "";
  p.stdout.on("data", (d) => (p.output += d));
  p.stderr.on("data", (d) => (p.output += d));
  children.push(p);
  return p;
}
async function waitFor(url, what, ms = 120_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not yet */
    }
    if (Date.now() - t0 > ms) throw new Error(`${what} did not become ready`);
    await sleep(500);
  }
}
function psql(target, argv, label) {
  const r = spawnSync("psql", [target, "-X", "-q", "-v", "ON_ERROR_STOP=1", ...argv], {
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`${label} failed: ${r.stderr}`);
  return r.stdout;
}
const sqlFiles = (dir) =>
  readdirSync(join(root, dir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

// ---- CPU accounting (Linux) ------------------------------------------------------------------------------------------
const TICKS = 100; // clock ticks per second
function cpuTicks(pid) {
  try {
    const f = readFileSync(`/proc/${pid}/stat`, "utf8");
    const parts = f.slice(f.lastIndexOf(")") + 2).split(" ");
    return Number(parts[11]) + Number(parts[12]); // utime + stime
  } catch {
    return 0;
  }
}
function machineBusyTicks() {
  // /proc/stat "cpu  user nice system idle iowait irq softirq steal ..."
  const f = readFileSync("/proc/stat", "utf8")
    .split("\n")[0]
    .trim()
    .split(/\s+/)
    .slice(1)
    .map(Number);
  const total = f.reduce((x, y) => x + y, 0);
  return total - f[3] - (f[4] ?? 0);
}
function allPids(root_) {
  // the process and all its descendants
  const kids = new Map();
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const f = readFileSync(`/proc/${d}/stat`, "utf8");
      const ppid = Number(f.slice(f.lastIndexOf(")") + 2).split(" ")[1]);
      kids.set(ppid, [...(kids.get(ppid) ?? []), Number(d)]);
    } catch {
      /* gone */
    }
  }
  const out = [];
  const walk = (p) => {
    out.push(p);
    for (const c of kids.get(p) ?? []) walk(c);
  };
  walk(root_);
  return out;
}
function cpuSnapshot(procs) {
  return {
    at: performance.now(),
    machine: machineBusyTicks(),
    node: cpuTicks(process.pid),
    next: allPids(procs.next.pid).reduce((a, p) => a + cpuTicks(p), 0),
    shim: cpuTicks(procs.shim.pid),
  };
}
/** PostgreSQL's backends come and go, so its share is what is left of the machine's busy time after the Node processes. */
function cpuReport(a, b) {
  const secs = (b.at - a.at) / 1000;
  const f = (k) => Math.round(((b[k] - a[k]) / TICKS) * 100) / 100;
  const machine = f("machine");
  const known = f("next") + f("shim") + f("node");
  return {
    wall_s: Math.round(secs * 10) / 10,
    machine_cpu_utilisation_pct: Math.round((machine / (secs * cpus().length)) * 1000) / 10,
    cpu_seconds: {
      "next server": f("next"),
      "database shim": f("shim"),
      "load generator": f("node"),
      "postgres + other (machine total minus the above)": Math.round((machine - known) * 100) / 100,
    },
  };
}

// ---- HTTP ------------------------------------------------------------------------------------------------------------
// one socket per reader AND per writer: fewer would queue requests inside the load generator
const agent = new Agent({
  connections: CLIENTS + TEAMS + 100,
  headersTimeout: 60_000,
  bodyTimeout: 60_000,
});
let transportRetries = 0; // a keep-alive socket the server closed just as it was reused (a load-generator artefact, counted and reported)
async function http(method, path, { cookie, body, key, close } = {}) {
  const headers = {};
  if (close) headers.connection = "close";
  if (cookie) headers.cookie = cookie;
  if (method !== "GET") {
    headers.origin = APP;
    headers["content-type"] = "application/json";
  }
  if (key) headers["idempotency-key"] = key;
  const t0 = performance.now();
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await request(APP + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        dispatcher: agent,
      });
      const text = await res.body.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* not json */
      }
      return { status: res.statusCode, ms: performance.now() - t0, headers: res.headers, json };
    } catch (e) {
      const code = String(e?.code ?? e?.message ?? e);
      // only a read (GET) is retried, once, and only when the socket was closed under us
      if (method === "GET" && attempt === 0 && /UND_ERR_SOCKET|ECONNRESET/.test(code)) {
        transportRetries++;
        continue;
      }
      return { status: 0, ms: performance.now() - t0, headers: {}, json: null, error: code };
    }
  }
}
const sessionCookie = (res) => {
  const raw = []
    .concat(res.headers["set-cookie"] ?? [])
    .find((c) => c.startsWith("__Host-session="));
  if (!raw) throw new Error(`no session cookie (status ${res.status})`);
  return raw.split(";")[0];
};
async function pool(items, concurrency, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

// ---- main ------------------------------------------------------------------------------------------------------------
const result = { config: {}, environment: {}, phases: {} };
let bench; // our own bookkeeping connection pool (never part of the measured load)
const tmp = mkdtempSync(join(tmpdir(), "lbbench-"));
let exitCode = 0;
try {
  const FIX = psql(
    adminUrl,
    [
      "-A",
      "-t",
      "-c",
      `select to_char(date_trunc('second', now()) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
    ],
    "clock",
  ).trim();
  log(`creating scratch database ${dbName}; pinned clock ${FIX}`);
  psql(adminUrl, ["-c", `create database ${dbName}`], "create database");
  for (const f of sqlFiles("supabase/migrations"))
    psql(dbUrl, ["-f", join(root, "supabase/migrations", f)], `migration ${f}`);
  psql(dbUrl, ["-f", join(root, "supabase/seed.sql")], "seed");
  psql(
    adminUrl,
    [
      "-c",
      `alter database ${dbName} set app.allow_test_clock = 'on'`,
      "-c",
      `alter database ${dbName} set app.test_now = '${FIX}'`,
    ],
    "pin clock",
  );
  psql(
    dbUrl,
    ["-c", `select app.provision_superadmin('bench_super', 'Bench Super', '${PASSWORD}')`],
    "super admin",
  );
  psql(
    dbUrl,
    [
      "-c",
      "update competition set status = 'RUNNING', paused_at = null, ended_at = null, opened_at = coalesce(opened_at, now()) where id = 1",
    ],
    "competition RUNNING",
  );

  bench = new pg.Pool({ connectionString: dbUrl, max: 4 });

  const procs = {};
  procs.shim = start(
    "node",
    ["scripts/bench/pg-rest-shim.mjs"],
    {
      SHIM_DB_URL: dbUrl,
      SHIM_PORT: String(DB_PORT),
      SHIM_KEY: SERVICE_KEY,
      SHIM_POOL: String(POOL),
    },
    "shim",
  );
  procs.next = start(
    "node",
    ["node_modules/next/dist/bin/next", "start", "-p", String(APP_PORT)],
    {
      APP_ENV: "test",
      APP_ORIGIN: APP,
      NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${DB_PORT}`,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
      SESSION_TOKEN_PEPPER: PEPPER,
      NODE_ENV: "production",
    },
    "next",
  );
  await waitFor(`${APP}/api/health`, "next start");
  await sleep(500);

  // ---- environment description ------------------------------------------------------------------------------------
  const pgInfo = (
    await bench.query(
      "select version() as v, current_setting('shared_buffers') as sb, current_setting('max_connections') as mc, current_setting('work_mem') as wm",
    )
  ).rows[0];
  result.config = {
    teams: TEAMS,
    unstarted_teams: UNSTARTED,
    clients: CLIENTS,
    steady_seconds: STEADY_S,
    stress_seconds: STRESS_S,
    poll_interval_ms: POLL_MS,
    jitter: JITTER,
    db_pool_size: POOL,
    pgbench_seconds: PGBENCH_S,
  };
  result.environment = {
    machine: `${cpus().length} x ${cpus()[0]?.model ?? "cpu"}, ${Math.round(totalmem() / 2 ** 30)} GiB RAM, kernel ${release()}`,
    node: process.version,
    postgres: pgInfo.v.split(" on ")[0],
    postgres_settings: {
      shared_buffers: pgInfo.sb,
      max_connections: pgInfo.mc,
      work_mem: pgInfo.wm,
    },
    topology:
      "load generator, Next.js (production build), DB shim and PostgreSQL all on this one machine",
    clock:
      "PostgreSQL clock pinned (test clock), so minutes taken stay 0 and every consistency check is exact",
  };

  // ---- seed through the real endpoints ----------------------------------------------------------------------------
  log("seeding through the real API: Super Admin -> Admin -> teams -> participant sessions");
  const sLogin = await http("POST", "/api/auth/staff/login", {
    body: { username: "bench_super", password: PASSWORD },
  });
  if (sLogin.status !== 200)
    throw new Error(`super login failed: ${sLogin.status} ${JSON.stringify(sLogin.json)}`);
  const superCookie = sessionCookie(sLogin);
  const mk = await http("POST", "/api/super/admins", {
    cookie: superCookie,
    key: randomUUID(),
    body: { username: "bench_admin", password: PASSWORD, confirmPassword: PASSWORD },
  });
  if (mk.status !== 200)
    throw new Error(`create admin failed: ${mk.status} ${JSON.stringify(mk.json)}`);
  const aLogin = await http("POST", "/api/auth/staff/login", {
    body: { username: "bench_admin", password: PASSWORD },
  });
  const adminCookie = sessionCookie(aLogin);

  const teamNos = Array.from({ length: TEAMS }, (_, i) => i + 1);
  await pool(teamNos, 4, async (i) => {
    const r = await http("POST", "/api/admin/teams", {
      cookie: adminCookie,
      key: randomUUID(),
      body: {
        teamCode: code(i),
        name: `Bench team ${i}`,
        loginId: `bench_${String(i).padStart(3, "0")}`,
        password: PASSWORD,
        confirmPassword: PASSWORD,
        admissionNos: [1, 2, 3, 4].map((s) => `BN${String(i).padStart(3, "0")}${s}`),
      },
    });
    if (r.status !== 200)
      throw new Error(`create team ${i}: ${r.status} ${JSON.stringify(r.json)}`);
  });
  const slots = Math.ceil(CLIENTS / TEAMS);
  const clientDefs = Array.from({ length: CLIENTS }, (_, k) => ({
    team: (k % TEAMS) + 1,
    slot: Math.floor(k / TEAMS) + 1,
  }));
  if (slots > 4) throw new Error("at most 4 members per team: use --clients <= 4 x --teams");
  const sessions = await pool(clientDefs, 4, async (c) => {
    const r = await http("POST", "/api/auth/participant/login", {
      body: {
        teamLoginId: `bench_${String(c.team).padStart(3, "0")}`,
        password: PASSWORD,
        admissionNo: `BN${String(c.team).padStart(3, "0")}${c.slot}`,
      },
    });
    if (r.status !== 200)
      throw new Error(
        `participant login ${c.team}/${c.slot}: ${r.status} ${JSON.stringify(r.json)}`,
      );
    return { ...c, cookie: sessionCookie(r), code: code(c.team) };
  });
  // a second member of every team acts as the "player" of the writers (the clients keep their own sessions)
  const actor = new Map();
  for (const s of sessions) if (s.slot === 1) actor.set(s.team, s);
  const startedTeams = teamNos.slice(0, TEAMS - UNSTARTED);
  const unstartedCodes = new Set(teamNos.slice(TEAMS - UNSTARTED).map(code));
  await pool(startedTeams, 8, async (i) => {
    const c = actor.get(i).cookie;
    for (const [path] of [
      ["/api/p/start"],
      ["/api/p/themes/1/unlock"],
      ["/api/p/questions/1/enter"],
    ]) {
      const r = await http("POST", path, { cookie: c, key: randomUUID() });
      if (r.status !== 200)
        throw new Error(`setup ${path} team ${i}: ${r.status} ${JSON.stringify(r.json)}`);
    }
  });
  log(
    `seeded: ${TEAMS} teams (${startedTeams.length} started), ${sessions.length} participant sessions`,
  );

  if (args.hold) {
    // debugging aid: leave the seeded system running so it can be probed by hand
    writeFileSync(
      String(args.hold),
      JSON.stringify({
        app: APP,
        sessions: sessions.map((c) => ({ team: c.team, slot: c.slot, cookie: c.cookie })),
      }),
    );
    log(`holding: sessions written to ${args.hold}; stop with SIGTERM`);
    await new Promise((r) => process.on("SIGTERM", r));
    throw new Error("held and stopped");
  }

  // ---- bookkeeping helpers ----------------------------------------------------------------------------------------
  const teamIdByCode = new Map(
    (await bench.query("select id, team_code from teams")).rows.map((r) => [r.team_code, r.id]),
  );
  const officialScore = async (c) =>
    Number(
      (
        await bench.query("select official_score from app.team_scores(app.now(), $1)", [
          teamIdByCode.get(c),
        ])
      ).rows[0].official_score,
    );
  const pendingSubmission = async (c, q) =>
    (
      await bench.query(
        "select id from submissions where team_id = $1 and question_id = $2 and status = 'PENDING'",
        [teamIdByCode.get(c), q],
      )
    ).rows[0]?.id;

  // ---- the load phases --------------------------------------------------------------------------------------------
  /** Steps of one team's theme. `changes` marks the steps that move the score. */
  const stepsFor = (theme) => {
    const q = (n) => (theme - 1) * 5 + n;
    const steps = [];
    if (theme > 1)
      steps.push({
        name: "unlock theme",
        changes: true,
        run: (t) =>
          http("POST", `/api/p/themes/${theme}/unlock`, {
            cookie: actor.get(t).cookie,
            key: randomUUID(),
          }),
      });
    if (theme > 1)
      steps.push({
        name: "enter question",
        changes: false,
        run: (t) =>
          http("POST", `/api/p/questions/${q(1)}/enter`, {
            cookie: actor.get(t).cookie,
            key: randomUUID(),
          }),
      });
    steps.push({
      name: "buy hint",
      changes: true,
      run: (t) =>
        http("POST", `/api/p/questions/${q(1)}/hints`, {
          cookie: actor.get(t).cookie,
          key: randomUUID(),
          body: { tier: 1 },
        }),
    });
    for (let n = 1; n <= 5; n++) {
      if (n === 2)
        steps.push({
          name: "buy hint",
          changes: true,
          run: (t) =>
            http("POST", `/api/p/questions/${q(2)}/hints`, {
              cookie: actor.get(t).cookie,
              key: randomUUID(),
              body: { tier: 1 },
            }),
        });
      steps.push({
        name: "submit answer",
        changes: false,
        run: (t) =>
          http("POST", `/api/p/questions/${q(n)}/submit`, {
            cookie: actor.get(t).cookie,
            key: randomUUID(),
            body: { answer: "42" },
          }),
      });
      steps.push({
        name: n === 5 ? "approve (completes the theme)" : "approve",
        changes: true,
        run: async (t) => {
          const id = await pendingSubmission(code(t), q(n));
          if (!id) return { status: 0, ms: 0, error: "no pending submission" };
          return http("POST", `/api/admin/submissions/${id}/approve`, {
            cookie: adminCookie,
            key: randomUUID(),
          });
        },
      });
    }
    return steps;
  };

  /** One load phase. */
  async function phase(name, { seconds, mode, theme, writerSpreadMs }) {
    log(`phase ${name}: ${mode}, ${seconds}s, ${CLIENTS} clients, theme ${theme}`);
    await fetch(`http://127.0.0.1:${DB_PORT}/__bench/reset`, { method: "POST" });
    const traj = new Map(); // team code -> [score values in the order the team went through them]
    for (const t of startedTeams) traj.set(code(t), [await officialScore(code(t))]);
    const reads = []; // { ms, status }
    const snaps = []; // { client, rows: [[team, score]...], me }
    const writes = new Map(); // step name -> { ms: [], ok, bad }
    const badSamples = [];
    const t0 = performance.now();
    const stopAt = performance.now() + seconds * 1000;
    const cpu0 = cpuSnapshot(procs);

    const clientLoop = async (c, idx) => {
      if (mode === "steady")
        await sleep(Math.min(rnd(0, POLL_MS), Math.max(0, stopAt - performance.now()))); // clients are spread over the interval, as they are in real life
      while (performance.now() < stopAt) {
        const r = await http("GET", "/api/p/leaderboard", { cookie: c.cookie, close: true });
        const ok = r.status === 200 && r.json?.ok === true && Array.isArray(r.json?.data?.rows);
        reads.push({
          ms: r.ms,
          status: r.status,
          ok,
          at: Math.round(performance.now() - t0),
          slot: c.slot,
          team: c.team,
        });
        if (ok)
          snaps.push({
            client: idx,
            team: c.code,
            rows: r.json.data.rows.map((x) => [x.team_id, x.score, x.rank]),
            me: r.json.data.me,
          });
        else if (badSamples.length < 5)
          badSamples.push({
            status: r.status,
            error: r.error,
            body: JSON.stringify(r.json)?.slice(0, 200),
          });
        if (mode === "steady")
          await sleep(
            Math.min(
              POLL_MS * (1 + JITTER * (2 * Math.random() - 1)),
              Math.max(0, stopAt - performance.now()),
            ),
          );
      }
    };
    const writerLoop = async (t) => {
      const c = code(t);
      for (const step of stepsFor(theme)) {
        await sleep(rnd(0, writerSpreadMs));
        if (performance.now() > stopAt + 60_000) return;
        const r = await step.run(t);
        const w = writes.get(step.name) ?? { ms: [], ok: 0, bad: 0 };
        w.ms.push(r.ms);
        if (r.status === 200) w.ok++;
        else {
          w.bad++;
          if (badSamples.length < 5)
            badSamples.push({
              step: step.name,
              team: c,
              status: r.status,
              error: r.error,
              body: JSON.stringify(r.json)?.slice(0, 200),
            });
        }
        writes.set(step.name, w);
        if (step.changes && r.status === 200) traj.get(c).push(await officialScore(c));
      }
    };
    // what PostgreSQL's active sessions are waiting on, sampled once a second (Lock = row/transaction lock waits)
    const waits = new Map();
    const sampler = setInterval(async () => {
      try {
        const r = await bench.query(
          "select coalesce(wait_event_type, 'CPU/none') as t, coalesce(wait_event, '-') as e, count(*)::int as n from pg_stat_activity where datname = $1 and state = 'active' and pid <> pg_backend_pid() group by 1, 2",
          [dbName],
        );
        for (const row of r.rows)
          waits.set(`${row.t}:${row.e}`, (waits.get(`${row.t}:${row.e}`) ?? 0) + row.n);
      } catch {
        /* sampling is best effort */
      }
    }, 1000);
    let activityDump = null;
    setTimeout(async () => {
      try {
        activityDump = (
          await bench.query(
            "select pid, state, wait_event_type as wt, wait_event as we, round(extract(epoch from now() - query_start)::numeric, 2) as age_s, pg_blocking_pids(pid) as blocked_by, left(regexp_replace(query, '\\s+', ' ', 'g'), 110) as q from pg_stat_activity where datname = $1 and state <> 'idle' and pid <> pg_backend_pid() order by age_s desc nulls last limit 25",
            [dbName],
          )
        ).rows;
      } catch (e) {
        activityDump = String(e);
      }
    }, 10_000);
    await Promise.all([
      ...sessions.map((c, i) => clientLoop(c, i)),
      ...(args["no-writers"] === "true" ? [] : startedTeams.map(writerLoop)),
    ]);
    clearInterval(sampler);
    const wall = (performance.now() - t0) / 1000;
    const cpu = cpuReport(cpu0, cpuSnapshot(procs));
    const shimStats = await (await fetch(`http://127.0.0.1:${DB_PORT}/__bench/stats`)).json();

    // consistency of every response
    const viol = {
      ranks: 0,
      me: 0,
      order: 0,
      unstarted_not_last: 0,
      illegitimate_score: 0,
      moved_backwards: 0,
    };
    const idxOf = new Map([...traj].map(([k, v]) => [k, v]));
    const lastIdx = new Map(); // `${client}|${team}` -> index
    for (const s of snaps) {
      const rows = s.rows;
      if (
        rows.length !== TEAMS ||
        rows.some((r, i) => r[2] !== i + 1) ||
        new Set(rows.map((r) => r[0])).size !== TEAMS
      )
        viol.ranks++;
      const mine = rows.find((r) => r[0] === s.team);
      if (
        !s.me ||
        !mine ||
        s.me.team_id !== s.team ||
        s.me.rank !== mine[2] ||
        s.me.score !== mine[1]
      )
        viol.me++;
      let seenUnstarted = false;
      for (let i = 0; i < rows.length; i++) {
        const un = unstartedCodes.has(rows[i][0]);
        if (un) seenUnstarted = true;
        else if (seenUnstarted) viol.unstarted_not_last++;
        if (i > 0 && un === unstartedCodes.has(rows[i - 1][0])) {
          const a = rows[i - 1];
          const b = rows[i];
          if (a[1] < b[1] || (a[1] === b[1] && !(a[0] < b[0]))) viol.order++;
        }
        const tr = idxOf.get(rows[i][0]);
        if (un) {
          if (rows[i][1] !== 500) viol.illegitimate_score++;
        } else if (tr) {
          const k = `${s.client}|${rows[i][0]}`;
          let from = lastIdx.get(k) ?? 0;
          let at = -1;
          for (let j = from; j < tr.length; j++)
            if (tr[j] === rows[i][1]) {
              at = j;
              break;
            }
          if (at === -1) {
            if (tr.includes(rows[i][1])) viol.moved_backwards++;
            else viol.illegitimate_score++;
          } else lastIdx.set(k, at);
        }
      }
    }
    const okReads = reads.filter((r) => r.ok).map((r) => r.ms);
    const writeSummary = Object.fromEntries(
      [...writes].map(([k, w]) => [
        k,
        { n: w.ms.length, ok: w.ok, errors: w.bad, latency_ms: stats(w.ms) },
      ]),
    );
    const writeTotal = [...writes.values()].reduce((a, w) => a + w.ms.length, 0);
    const out = {
      mode,
      read_window_s: seconds,
      duration_incl_writer_tail_s: Math.round(wall * 10) / 10,
      leaderboard_reads: {
        total_requests: reads.length,
        requests_per_second: Math.round((reads.length / seconds) * 10) / 10,
        errors: reads.length - okReads.length,
        error_rate_pct:
          Math.round(((reads.length - okReads.length) / (reads.length || 1)) * 10000) / 100,
        latency_ms: stats(okReads),
      },
      score_changing_writes: {
        total_requests: writeTotal,
        errors: [...writes.values()].reduce((a, w) => a + w.bad, 0),
        by_step: writeSummary,
      },
      snapshots_checked: snaps.length,
      consistency_violations: viol,
      database_timing_ms: Object.fromEntries(
        Object.entries(shimStats).filter(([k]) =>
          [
            "get_team_leaderboard",
            "resolve_session",
            "approve_submission",
            "buy_hint",
            "submit_answer",
          ].includes(k),
        ),
      ),
      cpu,
      database_active_session_samples: Object.fromEntries([...waits].sort((a, b) => b[1] - a[1])),
      database_activity_at_10s: activityDump,
      slowest_reads: reads
        .filter((r) => r.ok)
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 12)
        .map((r) => ({
          ms: Math.round(r.ms),
          started_at_ms: r.at,
          member_slot: r.slot,
          team: r.team,
        })),
      sample_errors: badSamples,
    };
    result.phases[name] = out;
    log(
      `phase ${name} done: ${out.leaderboard_reads.total_requests} reads @ ${out.leaderboard_reads.requests_per_second}/s, p99 ${out.leaderboard_reads.latency_ms.p99} ms, errors ${out.leaderboard_reads.errors}, violations ${JSON.stringify(viol)}`,
    );
    return traj;
  }

  await phase("steady", {
    seconds: STEADY_S,
    mode: "steady",
    theme: 1,
    writerSpreadMs: Math.max(200, (STEADY_S * 1000 * 0.6) / 12),
  });
  await phase("stress", { seconds: STRESS_S, mode: "stress", theme: 2, writerSpreadMs: 600 });

  // ---- database only (after the load phases, so the tables hold two finished themes per team) --------------------------
  const databaseOnly = async () => {
    const explain = [];
    for (let i = 0; i < 20; i++) {
      const r = await bench.query(
        "explain (analyze, format json) select * from app.leaderboard_rows(app.now())",
      );
      explain.push(r.rows[0]["QUERY PLAN"][0]["Execution Time"]);
    }
    const timed = [];
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now();
      await bench.query("select app.leaderboard_rows(app.now())");
      timed.push(performance.now() - t0);
    }
    const db = {
      explain_analyze_ms: stats(explain),
      single_connection_round_trip_ms: stats(timed),
    };
    if (spawnSync("pgbench", ["--version"]).status !== 0) {
      db.pgbench = "skipped: pgbench not installed";
    } else {
      // one literal script per team (equal weights): the call is exactly what the handler sends, and the answer is checked first
      const ids = (
        await bench.query(
          "select t.id as tid, m.id as mid from teams t join team_members m on m.team_id = t.id and m.slot = 1 order by t.team_code",
        )
      ).rows;
      const probe = await bench.query("select public.get_team_leaderboard($1, $2) as r", [
        ids[0].tid,
        ids[0].mid,
      ]);
      if (!probe.rows[0].r?.rows || probe.rows[0].r.rows.length !== TEAMS)
        throw new Error("pgbench probe: the board is not what it should be");
      const files = ids.map((r, i) => {
        const f = join(tmp, `reader${String(i).padStart(3, "0")}.sql`);
        writeFileSync(f, `select public.get_team_leaderboard('${r.tid}', '${r.mid}');\n`);
        return f;
      });
      const before = cpuSnapshot(procs);
      const r = spawnSync(
        "pgbench",
        [
          "-n",
          "-c",
          String(CLIENTS),
          "-j",
          "2",
          "-T",
          String(PGBENCH_S),
          ...files.flatMap((f) => ["-f", f]),
          "-l",
          `--log-prefix=${join(tmp, "pgb")}`,
        ],
        {
          encoding: "utf8",
          cwd: tmp,
          timeout: (PGBENCH_S + 60) * 1000,
          env: {
            ...process.env,
            PGOPTIONS: "-c role=service_role",
            PGHOST: admin.hostname,
            PGPORT: admin.port || "5432",
            PGUSER: decodeURIComponent(admin.username || "postgres"),
            PGDATABASE: dbName,
          },
        },
      );
      const after = cpuSnapshot(procs);
      const out = `${r.stdout}\n${r.stderr}`;
      const lat = [];
      for (const f of readdirSync(tmp).filter((x) => x.startsWith("pgb")))
        for (const line of readFileSync(join(tmp, f), "utf8").split("\n")) {
          const p = line.split(" ");
          if (p.length >= 3 && /^\d+$/.test(p[2])) lat.push(Number(p[2]) / 1000);
        }
      db.pgbench = {
        command: `pgbench -n -c ${CLIENTS} -j 2 -T ${PGBENCH_S} -l -f reader000.sql ... -f reader${String(TEAMS - 1).padStart(3, "0")}.sql   (PGOPTIONS='-c role=service_role'; reader_i.sql = select public.get_team_leaderboard(<team i>, <its member 1>), equal weights)`,
        transactions: Number(
          /number of transactions actually processed: (\d+)/.exec(out)?.[1] ?? 0,
        ),
        failed: Number(/number of failed transactions: (\d+)/.exec(out)?.[1] ?? 0),
        tps: Number(/tps = ([\d.]+)/.exec(out)?.[1] ?? 0),
        latency_ms: stats(lat),
        cpu: cpuReport(before, after),
        raw_tail: out.trim().split("\n").slice(-8),
      };
    }
    result.phases.database_only = db;
    log(
      "database-only phase done",
      JSON.stringify({
        explain: db.explain_analyze_ms,
        single: db.single_connection_round_trip_ms,
        pgbench:
          typeof db.pgbench === "string"
            ? db.pgbench
            : { tps: db.pgbench.tps, p99: db.pgbench.latency_ms.p99 },
      }),
    );
  };

  await databaseOnly();

  // ---- quiet: identical answers, equal to an independent recomputation -----------------------------------------------
  {
    log(
      "quiet phase: every client reads at once; compare with an independent recomputation from the base tables",
    );
    const burstStart = performance.now();
    const answers = await Promise.all(
      sessions.map((c) => http("GET", "/api/p/leaderboard", { cookie: c.cookie, close: true })),
    );
    const burstMs = performance.now() - burstStart;
    const bad = answers.filter((a) => a.status !== 200).length;
    const firstBad = answers.find((a) => a.status !== 200);
    const first = answers.find((a) => a.status === 200);
    if (!first)
      throw new Error(
        `quiet phase: no successful read (${firstBad?.status} ${firstBad?.error ?? JSON.stringify(firstBad?.json)})`,
      );
    const canon = JSON.stringify(first.json.data.rows);
    const identical = answers.filter(
      (a) => a.status === 200 && JSON.stringify(a.json.data.rows) === canon,
    ).length;
    const rows = (
      await bench.query(`
      select t.team_code, t.status, t.coins,
             coalesce((select count(*) from team_questions tq where tq.team_id = t.id and tq.state = 'APPROVED'), 0)::int as solved,
             coalesce((select count(*) from (select theme_id from team_questions tq where tq.team_id = t.id and tq.state = 'APPROVED' group by theme_id having count(*) = 5) x), 0)::int as completed
        from teams t`)
    ).rows;
    const expected = rows
      .map((r) => ({
        team: r.team_code,
        started: r.status !== "NOT_STARTED",
        score: r.completed * 500 + r.solved * 100 + r.coins,
      }))
      .sort(
        (a, b) =>
          Number(!a.started) - Number(!b.started) ||
          b.score - a.score ||
          (a.team < b.team ? -1 : a.team > b.team ? 1 : 0),
      );
    const got = first.json.data.rows;
    const same =
      expected.length === got.length &&
      expected.every(
        (e, i) => got[i].team_id === e.team && got[i].score === e.score && got[i].rank === i + 1,
      );
    result.phases.quiet = {
      concurrent_reads: answers.length,
      burst_total_ms: Math.round(burstMs),
      burst_latency_ms: stats(answers.filter((a) => a.status === 200).map((a) => a.ms)),
      errors: bad,
      first_error: firstBad ? { status: firstBad.status, error: firstBad.error } : null,
      identical_answers: identical,
      independent_recomputation_matches: same,
      teams_with_a_completed_theme: rows.filter((r) => r.completed > 0).length,
    };
    log("quiet phase", JSON.stringify(result.phases.quiet));
  }

  const v = (p) =>
    Object.values(result.phases[p]?.consistency_violations ?? {}).reduce((a, b) => a + b, 0);
  result.child_output_tails = Object.fromEntries(
    children.map((c) => [c.name, c.output.slice(-1200)]),
  );
  result.load_generator = { keep_alive_socket_retries: transportRetries };
  result.verdict = {
    zero_errors: ["steady", "stress"].every(
      (p) =>
        result.phases[p].leaderboard_reads.errors === 0 &&
        result.phases[p].score_changing_writes.errors === 0,
    ),
    consistent_snapshots: v("steady") + v("stress") === 0,
    deterministic_when_quiet:
      result.phases.quiet.identical_answers === CLIENTS &&
      result.phases.quiet.independent_recomputation_matches,
  };
} catch (e) {
  console.error("BENCH FAILED:", e);
  for (const p of children)
    console.error(`--- ${p.name} output (tail) ---\n${p.output.slice(-1500)}`);
  exitCode = 1;
} finally {
  for (const p of children) p.kill("SIGTERM");
  await sleep(500);
  try {
    await bench?.end();
  } catch {
    /* ignore */
  }
  await agent.close();
  try {
    if (args["keep-db"] === "true") console.error(`kept scratch database ${dbName}`);
    else
      psql(
        adminUrl,
        ["-c", `drop database if exists ${dbName} with (force)`],
        "drop scratch database",
      );
  } catch (e) {
    console.error(String(e));
  }
  rmSync(tmp, { recursive: true, force: true });
}
if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(exitCode || (result.verdict && Object.values(result.verdict).every(Boolean) ? 0 : 1));
