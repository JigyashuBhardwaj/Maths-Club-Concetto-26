#!/usr/bin/env node
// Applies supabase/migrations/*.sql (in filename order) and supabase/seed.sql to a SCRATCH database, then runs
// every supabase/tests/*.sql file against it. Requires `psql` and a PostgreSQL server you may create databases on.
//
//   DB_VERIFY_URL=postgres://user@127.0.0.1:5432/postgres npm run db:verify
//
// The scratch database is created with a random name and always dropped afterwards. Nothing else is touched.
// Never point this at a production database. It refuses URLs that do not look local unless DB_VERIFY_ALLOW_REMOTE=1.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const adminUrl = process.env.DB_VERIFY_URL;
if (!adminUrl) {
  console.error(
    "db:verify: set DB_VERIFY_URL to a server you can create scratch databases on (never production).",
  );
  process.exit(2);
}
const url = new URL(adminUrl);
const local = ["localhost", "127.0.0.1", "::1", ""].includes(url.hostname);
if (!local && process.env.DB_VERIFY_ALLOW_REMOTE !== "1") {
  console.error(
    `db:verify: refusing non-local host "${url.hostname}" (set DB_VERIFY_ALLOW_REMOTE=1 for a throwaway server).`,
  );
  process.exit(2);
}

const dbName = `concetto_verify_${randomBytes(4).toString("hex")}`;
const urlFor = (name) => {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  return u.toString();
};
const psql = (target, args, label) => {
  const r = spawnSync("psql", [target, "-X", "-q", "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    console.error(`FAIL  ${label}\n${r.stderr}`);
    return false;
  }
  console.log(`ok    ${label}`);
  return true;
};

let ok = true;
if (!psql(adminUrl, ["-c", `create database ${dbName}`], `create scratch database ${dbName}`))
  process.exit(1);
try {
  const target = urlFor(dbName);
  const sqlFiles = (dir) =>
    readdirSync(join(root, dir))
      .filter((f) => (dir.endsWith("tests") ? f.endsWith(".test.sql") : f.endsWith(".sql")))
      .sort();
  for (const f of sqlFiles("supabase/migrations")) {
    ok = psql(target, ["-f", join(root, "supabase/migrations", f)], `migration ${f}`) && ok;
    if (!ok) break;
  }
  if (ok) ok = psql(target, ["-f", join(root, "supabase/seed.sql")], "seed (first run)");
  if (ok)
    ok = psql(target, ["-f", join(root, "supabase/seed.sql")], "seed (second run, idempotent)");
  if (ok) {
    for (const f of sqlFiles("supabase/tests")) {
      ok = psql(target, ["-f", join(root, "supabase/tests", f)], `test ${f}`) && ok;
    }
  }
} finally {
  psql(
    adminUrl,
    ["-c", `drop database if exists ${dbName} with (force)`],
    `drop scratch database ${dbName}`,
  );
}
console.log(ok ? "\ndb:verify PASSED" : "\ndb:verify FAILED");
process.exit(ok ? 0 : 1);
