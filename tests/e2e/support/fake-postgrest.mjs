// An in-memory stand-in for the Supabase/PostgREST endpoint, used ONLY by the Playwright suite (and its unit test).
//
// Why it exists: the browser tests must drive the real Next.js server (routes, cookies, route guards, UI) without a
// database, a Docker daemon or committed credentials. The app is started with NEXT_PUBLIC_SUPABASE_URL pointing here,
// so the production code path is unchanged: there is no test switch inside the application. This process implements
// the four authentication functions of migration 11 (participant_login, staff_login, resolve_session, revoke_session)
// with the same rules and the same JSON result shapes as the SQL. The SQL itself is proven by supabase/tests/70_auth.
//
// Fidelity notes (kept deliberately small): throttling constants, "one live session per member", 12 h expiry, the
// generic INVALID_CREDENTIALS answer, and "participants may log in only while the competition is RUNNING/PAUSED" mirror
// the SQL. Deviation for test isolation: the competition status a team observes can be set per team through the
// test-only control endpoint (the SQL has one global status).
//
// Identities come from the E2E_IDENTITIES environment variable, generated at random for every run by
// playwright.config.ts; nothing secret is stored in the repository.
import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

const SESSION_MS = 12 * 60 * 60 * 1000;

class AppError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

function same(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * @param {{ staff: {username:string,password:string,displayName:string,role:string,active?:boolean}[],
 *           teams: {code:string,name:string,loginId:string,password:string,members:{slot:number,admissionNo:string}[]}[] }} identities
 * @param {() => number} [now]
 */
export function createFakeBackend(identities, now = () => Date.now()) {
  const staff = new Map(
    identities.staff.map((s) => [
      s.username.toLowerCase(),
      { id: randomUUID(), active: true, ...s },
    ]),
  );
  const teams = new Map(
    identities.teams.map((t) => [
      t.loginId.toLowerCase(),
      {
        id: randomUUID(),
        status: "NOT_STARTED",
        competition: "RUNNING",
        ...t,
        members: t.members.map((m) => ({ id: randomUUID(), ...m })),
      },
    ]),
  );
  /** token hash ("\\x…") -> session */
  const sessions = new Map();
  const throttle = new Map();

  const iso = (ms) => new Date(ms).toISOString();

  function retryAfter(key) {
    const t = throttle.get(key);
    return t?.lockedUntil && t.lockedUntil > now() ? Math.ceil((t.lockedUntil - now()) / 1000) : 0;
  }
  function fail(key) {
    const t = throttle.get(key) ?? { windowStart: now(), attempts: 0, lockedUntil: 0 };
    if (t.windowStart < now() - 10 * 60 * 1000) {
      t.windowStart = now();
      t.attempts = 0;
    }
    t.attempts += 1;
    if (t.attempts >= 8) {
      t.lockedUntil = now() + Math.min(300, 30 * 2 ** Math.min(t.attempts - 8, 10)) * 1000;
    }
    throttle.set(key, t);
  }
  const clear = (key) => throttle.delete(key);
  const needHash = (h) => {
    if (typeof h !== "string" || !/^\\x[0-9a-f]{64}$/.test(h)) {
      throw new AppError("participant_login: token hash must be exactly 32 bytes");
    }
  };

  function sessionJson(s) {
    return { id: s.id, expires_at: iso(s.expiresAt) };
  }
  function principalJson(s) {
    if (s.kind === "STAFF") {
      const u = s.staff;
      return {
        ok: true,
        role: u.role,
        session: sessionJson(s),
        staff: { id: u.id, username: u.username, display_name: u.displayName },
      };
    }
    return {
      ok: true,
      role: "PARTICIPANT",
      session: sessionJson(s),
      member: { id: s.member.id, slot: s.member.slot },
      team: { id: s.team.id, code: s.team.code, name: s.team.name, status: s.team.status },
    };
  }

  const functions = {
    participant_login(a) {
      needHash(a.p_token_hash);
      const key = `team:${String(a.p_login_id ?? "")
        .trim()
        .toLowerCase()}`;
      const wait = retryAfter(key);
      if (wait > 0) return { ok: false, code: "RATE_LIMITED", retry_after_seconds: wait };
      const team = teams.get(
        String(a.p_login_id ?? "")
          .trim()
          .toLowerCase(),
      );
      const adm = String(a.p_admission_no ?? "")
        .trim()
        .toUpperCase();
      const member = team?.members.find((m) => m.admissionNo === adm);
      const passwordOk = same(a.p_password, team?.password ?? "\u0000no-such-team");
      if (!team || !passwordOk || !member) {
        fail(key);
        return { ok: false, code: "INVALID_CREDENTIALS" };
      }
      if (team.competition !== "RUNNING" && team.competition !== "PAUSED") {
        clear(key);
        return { ok: false, code: "COMPETITION_NOT_RUNNING", competition_status: team.competition };
      }
      for (const s of sessions.values()) {
        if (s.kind === "MEMBER" && s.member.id === member.id && !s.revoked) s.revoked = true;
      }
      const s = {
        id: randomUUID(),
        kind: "MEMBER",
        member,
        team,
        expiresAt: now() + SESSION_MS,
        revoked: false,
      };
      sessions.set(a.p_token_hash, s);
      clear(key);
      return principalJson(s);
    },

    staff_login(a) {
      needHash(a.p_token_hash);
      const name = String(a.p_username ?? "")
        .trim()
        .toLowerCase();
      const key = `staff:${name}`;
      const wait = retryAfter(key);
      if (wait > 0) return { ok: false, code: "RATE_LIMITED", retry_after_seconds: wait };
      const user = staff.get(name);
      const passwordOk = same(a.p_password, user?.password ?? "\u0000no-such-user");
      if (!user || !passwordOk || !user.active) {
        fail(key);
        return { ok: false, code: "INVALID_CREDENTIALS" };
      }
      const s = {
        id: randomUUID(),
        kind: "STAFF",
        staff: user,
        expiresAt: now() + SESSION_MS,
        revoked: false,
      };
      sessions.set(a.p_token_hash, s);
      clear(key);
      return principalJson(s);
    },

    resolve_session(a) {
      const s = typeof a.p_token_hash === "string" ? sessions.get(a.p_token_hash) : undefined;
      if (!s || s.revoked) return { ok: false, code: "UNAUTHENTICATED" };
      if (s.expiresAt <= now()) {
        s.revoked = true;
        return { ok: false, code: "UNAUTHENTICATED" };
      }
      if (s.kind === "STAFF" && !s.staff.active) {
        s.revoked = true;
        return { ok: false, code: "UNAUTHENTICATED" };
      }
      return principalJson(s);
    },

    revoke_session(a) {
      const s = typeof a.p_token_hash === "string" ? sessions.get(a.p_token_hash) : undefined;
      if (!s || s.revoked) return { ok: true, revoked: false };
      if (s.expiresAt <= now()) {
        s.revoked = true;
        return { ok: true, revoked: false };
      }
      s.revoked = true;
      return { ok: true, revoked: true };
    },
  };

  /** Test-only controls (never reachable from the app, which only calls /rest/v1/rpc/*). */
  const controls = {
    /** Makes every live session of one account look expired (staff username or member admission number). */
    /** @param {{ username?: string, admissionNo?: string }} who */
    expire({ username, admissionNo }) {
      let n = 0;
      for (const s of sessions.values()) {
        const hit =
          (username &&
            s.kind === "STAFF" &&
            s.staff.username.toLowerCase() === String(username).toLowerCase()) ||
          (admissionNo &&
            s.kind === "MEMBER" &&
            s.member.admissionNo === String(admissionNo).toUpperCase());
        if (hit && !s.revoked) {
          s.expiresAt = now() - 1000;
          n += 1;
        }
      }
      return { expired: n };
    },
    /** The competition status the given team's login observes. */
    competition({ loginId, status }) {
      const team = teams.get(String(loginId).toLowerCase());
      if (!team) throw new AppError("unknown team");
      team.competition = status;
      return { ok: true };
    },
    /** Disables / re-enables a staff account (its live sessions then stop resolving, as in resolve_session). */
    staffActive({ username, active }) {
      const u = staff.get(String(username).toLowerCase());
      if (!u) throw new AppError("unknown staff");
      u.active = Boolean(active);
      return { ok: true };
    },
    /** Number of non-revoked, non-expired sessions of an account (so a test can assert that logout revoked it). */
    /** @param {{ username?: string, admissionNo?: string }} who */
    liveSessions({ username, admissionNo }) {
      let n = 0;
      for (const s of sessions.values()) {
        if (s.revoked || s.expiresAt <= now()) continue;
        if (
          username &&
          s.kind === "STAFF" &&
          s.staff.username.toLowerCase() === String(username).toLowerCase()
        )
          n += 1;
        if (
          admissionNo &&
          s.kind === "MEMBER" &&
          s.member.admissionNo === String(admissionNo).toUpperCase()
        )
          n += 1;
      }
      return { live: n };
    },
  };

  return {
    rpc: (fn, args) => {
      if (!Object.hasOwn(functions, fn)) return undefined;
      return functions[fn](args ?? {});
    },
    controls,
    AppError,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createFakeServer({ identities, serviceKey }) {
  const backend = createFakeBackend(identities);
  const send = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/__health") return send(res, 200, { ok: true });

      if (req.method === "POST" && url.pathname.startsWith("/__test/")) {
        const name = url.pathname.slice("/__test/".length);
        if (!Object.hasOwn(backend.controls, name))
          return send(res, 404, { error: "unknown control" });
        const body = JSON.parse((await readBody(req)) || "{}");
        return send(res, 200, backend.controls[name](body));
      }

      const match = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname);
      if (req.method !== "POST" || !match) return send(res, 404, { message: "not found" });
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      if (!same(req.headers.apikey, serviceKey) || !same(bearer, serviceKey)) {
        return send(res, 401, { message: "Invalid API key" });
      }
      const args = JSON.parse((await readBody(req)) || "{}");
      const result = backend.rpc(match[1], args);
      if (result === undefined) {
        return send(res, 404, {
          code: "PGRST202",
          message: `Could not find the function public.${match[1]}`,
          details: null,
          hint: null,
        });
      }
      return send(res, 200, result);
    } catch (err) {
      if (err instanceof AppError) {
        // PostgREST maps `raise exception` (SQLSTATE P0001) to HTTP 400 with {code, message, details, hint}.
        return send(res, 400, { code: "P0001", message: err.message, details: null, hint: null });
      }
      return send(res, 500, { message: "fake backend error" });
    }
  });
}

// Run as a process: `node tests/e2e/support/fake-postgrest.mjs` (started by playwright.config.ts).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const identities = JSON.parse(process.env.E2E_IDENTITIES ?? "null");
  const serviceKey = process.env.E2E_SERVICE_KEY;
  const port = Number(process.env.E2E_DB_PORT);
  if (!identities || !serviceKey || !Number.isInteger(port)) {
    console.error("fake-postgrest: E2E_IDENTITIES, E2E_SERVICE_KEY and E2E_DB_PORT are required.");
    process.exit(2);
  }
  createFakeServer({ identities, serviceKey }).listen(port, "127.0.0.1", () => {
    console.log(`fake-postgrest listening on 127.0.0.1:${port}`);
  });
}
