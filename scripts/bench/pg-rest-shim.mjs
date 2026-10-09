#!/usr/bin/env node
// A minimal PostgREST stand-in for the leaderboard benchmark: `POST /rest/v1/rpc/<function>` -> `select public.<function>(...)`
// on a REAL PostgreSQL, through a bounded connection pool (like the Supabase pooler). It exists only so the real Next.js
// server and the real handlers can be load-tested against the real SQL without a Supabase project. It is not part of the app.
//
// Environment: SHIM_DB_URL (postgres URL), SHIM_PORT, SHIM_KEY (the service key the app sends), SHIM_POOL (default 20).
// Extra endpoints (benchmark only): GET /__bench/stats, POST /__bench/reset - per-function database timings
// (`wait` = time waiting for a pooled connection, `query` = time in PostgreSQL, both in ms).
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

import pg from "pg";

const { SHIM_DB_URL, SHIM_PORT, SHIM_KEY } = process.env;
if (!SHIM_DB_URL || !SHIM_PORT || !SHIM_KEY) {
  console.error("shim: SHIM_DB_URL, SHIM_PORT and SHIM_KEY are required");
  process.exit(2);
}
// the app talks to the database as service_role (the explicit function grants), exactly like Supabase
const pool = new pg.Pool({
  connectionString: SHIM_DB_URL,
  max: Number(process.env.SHIM_POOL ?? 20),
  options: "-c role=service_role",
});

// public functions: argument names and types, so JSON arguments can be passed with the right cast
const sig = new Map();
{
  const { rows } = await pool.query(`
    select p.proname, p.proargnames,
           array(select format_type(t, null) from unnest(p.proargtypes::oid[]) with ordinality u(t, i) order by i) as types
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proargnames is not null`);
  for (const r of rows)
    sig.set(r.proname, Object.fromEntries(r.proargnames.map((n, i) => [n, r.types[i]])));
}

const stats = new Map();
const record = (fn, wait, query) => {
  const s = stats.get(fn) ?? { wait: [], query: [] };
  s.wait.push(wait);
  s.query.push(query);
  stats.set(fn, s);
};
const pct = (a, p) =>
  a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : null;
const summary = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const avg = s.reduce((x, y) => x + y, 0) / (s.length || 1);
  return {
    n: s.length,
    avg,
    p50: pct(s, 50),
    p95: pct(s, 95),
    p99: pct(s, 99),
    max: s.at(-1) ?? null,
  };
};

const same = (a, b) => {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
const send = (res, status, body) => {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
};

createServer(async (req, res) => {
  try {
    if (req.url === "/__bench/stats") {
      return send(
        res,
        200,
        Object.fromEntries(
          [...stats].map(([fn, s]) => [fn, { wait: summary(s.wait), query: summary(s.query) }]),
        ),
      );
    }
    if (req.url === "/__bench/reset") {
      stats.clear();
      return send(res, 200, { ok: true });
    }
    const m = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(req.url ?? "");
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!m || req.method !== "POST") return send(res, 404, { message: "not found" });
    if (!same(req.headers.apikey, SHIM_KEY) || !same(bearer, SHIM_KEY))
      return send(res, 401, { message: "bad key" });
    const fn = m[1];
    const types = sig.get(fn);
    if (!types) return send(res, 404, { message: `unknown function ${fn}` });
    const args = await readBody(req);
    const names = Object.keys(args);
    const params = names.map((n) =>
      types[n] === "jsonb" || types[n] === "json" ? JSON.stringify(args[n]) : args[n],
    );
    const sql = `select to_jsonb(public.${fn}(${names.map((n, i) => `${n} => $${i + 1}::${types[n]}`).join(", ")})) as r`;
    const t0 = performance.now();
    const client = await pool.connect();
    const t1 = performance.now();
    try {
      const { rows } = await client.query(sql, params);
      record(fn, t1 - t0, performance.now() - t1);
      return send(res, 200, rows[0]?.r ?? null);
    } catch (e) {
      record(fn, t1 - t0, performance.now() - t1);
      return send(res, 400, {
        code: e.code ?? "XX000",
        message: e.message,
        details: e.detail ?? null,
        hint: e.hint ?? null,
      });
    } finally {
      client.release();
    }
  } catch (e) {
    send(res, 500, { message: String(e?.message ?? e) });
  }
}).listen(Number(SHIM_PORT), "127.0.0.1", () => console.log(`shim ready on ${SHIM_PORT}`));
