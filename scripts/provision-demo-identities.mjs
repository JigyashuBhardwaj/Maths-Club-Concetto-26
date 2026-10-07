#!/usr/bin/env node
// Creates DEMO / DEVELOPMENT identities so B11/B12 can be exercised by hand: one ADMIN and one or more teams of four
// members. It follows the same architecture as `npm run provision:superadmin`:
//
//   PROVISION_DATABASE_URL=postgres://owner@127.0.0.1:5432/concetto npm run provision:demo -- --teams 2
//
// - Nothing is hard-coded and nothing is committed. Every password is generated here, at random, when the script runs,
//   is hashed INSIDE the database (app.hash_password, bcrypt) and is printed exactly once to this terminal. It is never
//   written to a file, an environment variable or a command line, and no hash is ever selected or printed.
// - Re-running is safe: identities that already exist are left untouched (their passwords are NOT shown again).
//   `--reset-passwords` gives the existing demo identities new random passwords.
// - It needs the Super Admin to exist already (`npm run provision:superadmin`), because every ADMIN is created by one.
// - `--open-competition` additionally opens the competition (SETUP -> RUNNING) as that Super Admin, through the same
//   public.set_competition_status function the API uses, so participants can sign in (they cannot while it is SETUP).
// - It refuses non-local databases unless PROVISION_ALLOW_REMOTE=1, and refuses a database that already holds teams that
//   are not demo teams (PROVISION_DEMO_ALLOW_MIXED=1 overrides). Never run it against the production database: it is a
//   development tool and every identity it creates is named demo_* / DEMO*.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { connectionEnv, dollarQuote } from "./provision-superadmin.mjs";

export const ADMIN_USERNAME = "demo_admin";
export const MAX_TEAMS = 4;
const MEMBERS_PER_TEAM = 4;

export const teamIdentity = (n) => {
  const nn = String(n).padStart(2, "0");
  return {
    n,
    code: `DEMO_${nn}`,
    name: `Demo Team ${n}`,
    loginId: `demo_team_${nn}`,
    admissionNumbers: Array.from(
      { length: MEMBERS_PER_TEAM },
      (_, i) => `DEMO${nn}${String(i + 1).padStart(2, "0")}`,
    ),
  };
};

/** 20 characters of base64url (120 bits). Long enough to be unguessable, short enough to type. */
export function generatePassword() {
  return randomBytes(15).toString("base64url");
}

export function parseArgs(argv) {
  const opts = { teams: 1, resetPasswords: false, openCompetition: false, yes: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--teams") {
      const n = Number(argv[(i += 1)]);
      if (!Number.isInteger(n) || n < 1 || n > MAX_TEAMS) {
        return { error: `--teams must be a whole number from 1 to ${MAX_TEAMS}.` };
      }
      opts.teams = n;
    } else if (a === "--reset-passwords") opts.resetPasswords = true;
    else if (a === "--open-competition") opts.openCompetition = true;
    else if (a === "--yes") opts.yes = true;
    else return { error: `Unknown option "${a}".` };
  }
  return { opts };
}

/** What already exists. Prints `key|value` lines only: never a hash. */
export const INSPECT_SQL = `
select 'super', count(*) from staff_users where role = 'SUPER_ADMIN';
select 'competition', status from competition where id = 1;
select 'staff', username from staff_users where username = '${ADMIN_USERNAME}';
select 'team', login_id from teams where login_id::text like 'demo\\_team\\_%' escape '\\';
select 'foreign_teams', count(*) from teams where login_id::text not like 'demo\\_team\\_%' escape '\\';
`;

export function parseInspect(stdout) {
  const state = {
    super: 0,
    competition: null,
    adminExists: false,
    teamsExisting: new Set(),
    foreignTeams: 0,
  };
  for (const line of stdout.split("\n")) {
    const [key, value] = line.trim().split("|");
    if (key === "super") state.super = Number(value);
    else if (key === "competition") state.competition = value;
    else if (key === "staff") state.adminExists = true;
    else if (key === "team") state.teamsExisting.add(value);
    else if (key === "foreign_teams") state.foreignTeams = Number(value);
  }
  return state;
}

/**
 * The work to do: which identities get a password this run. `existing` comes from parseInspect.
 * An existing identity is untouched unless `resetPasswords`.
 */
export function planWork(opts, existing, passwordFor = generatePassword) {
  const plan = { admin: null, teams: [] };
  if (!existing.adminExists || opts.resetPasswords) {
    plan.admin = {
      username: ADMIN_USERNAME,
      password: passwordFor(),
      action: existing.adminExists ? "reset" : "created",
    };
  }
  for (let n = 1; n <= opts.teams; n += 1) {
    const team = teamIdentity(n);
    const exists = existing.teamsExisting.has(team.loginId);
    if (!exists || opts.resetPasswords) {
      plan.teams.push({ ...team, password: passwordFor(), action: exists ? "reset" : "created" });
    }
  }
  return plan;
}

/** One transaction. Passwords appear only as dollar-quoted arguments of app.hash_password; nothing returns a hash. */
export function buildProvisionSql(plan) {
  const sql = ["begin;"];
  if (plan.admin) {
    const pw = dollarQuote(plan.admin.password);
    if (plan.admin.action === "created") {
      sql.push(
        `insert into staff_users (username, display_name, password_hash, role, created_by)
select '${ADMIN_USERNAME}', 'Demo Admin', app.hash_password(${pw}), 'ADMIN', s.id
from staff_users s where s.role = 'SUPER_ADMIN';`,
      );
    } else {
      sql.push(
        `update staff_users set password_hash = app.hash_password(${pw}), is_active = true where username = '${ADMIN_USERNAME}';`,
      );
    }
  }
  for (const t of plan.teams) {
    const pw = dollarQuote(t.password);
    if (t.action === "created") {
      sql.push(
        `with new_team as (
  insert into teams (team_code, name, login_id, password_hash, admin_id, coins)
  select '${t.code}', '${t.name}', '${t.loginId}', app.hash_password(${pw}), a.id, c.initial_coins
  from staff_users a cross join competition c where a.username = '${ADMIN_USERNAME}'
  returning id, coins
)
insert into coin_transactions (team_id, type, amount, balance_after, created_at)
select id, 'INITIAL_GRANT', coins, coins, now() from new_team where coins > 0;`,
        `insert into team_members (team_id, slot, admission_no)
select t.id, s.slot, 'DEMO' || '${String(t.n).padStart(2, "0")}' || lpad(s.slot::text, 2, '0')
from teams t cross join generate_series(1, ${MEMBERS_PER_TEAM}) s(slot) where t.login_id = '${t.loginId}';`,
      );
    } else {
      sql.push(
        `update teams set password_hash = app.hash_password(${pw}) where login_id = '${t.loginId}';`,
      );
    }
  }
  sql.push("commit;");
  return `${sql.join("\n")}\n`;
}

/** Opens the competition as the Super Admin (idempotent for an already RUNNING competition). */
export const OPEN_SQL = `select (public.set_competition_status(
  (select id from staff_users where role = 'SUPER_ADMIN'), 'open', gen_random_uuid()))->>'to';\n`;

export function describeFailure(stderr) {
  if (/COMPETITION_NOT_READY/.test(stderr))
    return "The competition cannot open yet: it needs at least one team and the seeded 10 themes × 50 questions (apply supabase/seed.sql).";
  if (/INVALID_COMPETITION_TRANSITION/.test(stderr))
    return "The competition is not in a state that can be opened (it is paused or has ended).";
  if (
    /function app\.hash_password.*does not exist|schema "app" does not exist|relation "staff_users" does not exist/.test(
      stderr,
    )
  )
    return "The migrations have not been applied to this database.";
  if (/permission denied/.test(stderr))
    return "This database role may not run the provisioning statements.";
  if (
    /could not connect|connection to server|password authentication failed|does not exist/.test(
      stderr,
    )
  )
    return "Could not connect to the database with PROVISION_DATABASE_URL.";
  return "Provisioning failed (database error). Nothing was printed, to avoid leaking input.";
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  return new Promise((resolve) => {
    process.stderr.write(question);
    rl.once("line", (line) => {
      rl.close();
      resolve(line);
    });
    rl.once("close", () => resolve(null));
  });
}

function psql(env, sql, { tuples = false } = {}) {
  const args = ["-X", "-q", "-v", "ON_ERROR_STOP=1", ...(tuples ? ["-t", "-A"] : []), "-f", "-"];
  return spawnSync("psql", args, { env, input: sql, encoding: "utf8" });
}

export function formatReport(plan, { competitionStatus, opened }) {
  const lines = [
    "",
    "Demo identities (the passwords below are shown ONCE and are not stored anywhere):",
    "",
  ];
  if (plan.admin) {
    lines.push(
      `  ${plan.admin.action === "created" ? "ADMIN (created)" : "ADMIN (password reset)"}`,
    );
    lines.push(`    username : ${plan.admin.username}`);
    lines.push(`    password : ${plan.admin.password}`, "");
  }
  for (const t of plan.teams) {
    lines.push(
      `  TEAM ${t.code} "${t.name}" (${t.action === "created" ? "created" : "password reset"})`,
    );
    lines.push(`    team login id    : ${t.loginId}`);
    lines.push(`    team password   : ${t.password}`);
    lines.push(`    admission numbers: ${t.admissionNumbers.join(", ")}`, "");
  }
  if (!plan.admin && plan.teams.length === 0) {
    lines.push(
      "  Nothing to create: the requested demo identities already exist (use --reset-passwords for new passwords).",
      "",
    );
  }
  const open = opened || competitionStatus === "RUNNING" || competitionStatus === "PAUSED";
  lines.push(
    `Competition status: ${opened ? "RUNNING (opened by this run)" : (competitionStatus ?? "unknown")}.`,
    ...(open
      ? []
      : [
          "Participants can sign in only while it is RUNNING or PAUSED. Re-run with --open-competition to open it.",
        ]),
    "These are demo identities. Never create them in the production database.",
  );
  return lines.join("\n");
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`provision:demo: ${parsed.error}`);
    return 2;
  }
  const { opts } = parsed;
  const dbUrl = process.env.PROVISION_DATABASE_URL;
  if (!dbUrl) {
    console.error(
      "provision:demo: set PROVISION_DATABASE_URL to a direct PostgreSQL URL for a DEVELOPMENT database (never the service-role key).",
    );
    return 2;
  }
  if (process.env.APP_ENV === "production") {
    console.error(
      "provision:demo: APP_ENV is production. Demo identities are never created in a production environment.",
    );
    return 2;
  }
  let env;
  let target;
  try {
    const u = new URL(dbUrl);
    env = connectionEnv(dbUrl);
    target = `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
    const local = ["localhost", "127.0.0.1", "::1", "[::1]", ""].includes(u.hostname);
    if (!local && process.env.PROVISION_ALLOW_REMOTE !== "1") {
      console.error(
        `provision:demo: refusing non-local host "${u.hostname}" (set PROVISION_ALLOW_REMOTE=1 if this really is a development database).`,
      );
      return 2;
    }
  } catch {
    console.error("provision:demo: PROVISION_DATABASE_URL is not a valid postgres URL.");
    return 2;
  }

  const inspected = psql(env, INSPECT_SQL, { tuples: true });
  if (inspected.error || inspected.status !== 0) {
    console.error(
      `provision:demo: ${inspected.error ? "could not run psql (is the PostgreSQL client installed?)." : describeFailure(inspected.stderr ?? "")}`,
    );
    return 5;
  }
  const state = parseInspect(inspected.stdout);
  if (state.super < 1) {
    console.error(
      "provision:demo: no SUPER_ADMIN exists yet. Run `npm run provision:superadmin` first (every ADMIN is created by one).",
    );
    return 3;
  }
  if (state.foreignTeams > 0 && process.env.PROVISION_DEMO_ALLOW_MIXED !== "1") {
    console.error(
      "provision:demo: this database already holds teams that are not demo teams. Refusing to mix demo identities into it (PROVISION_DEMO_ALLOW_MIXED=1 overrides).",
    );
    return 3;
  }

  const plan = planWork(opts, state);
  console.error(
    `Demo identities on ${target}: ${plan.admin ? `admin ${plan.admin.action}` : "admin kept"}, ${plan.teams.length} of ${opts.teams} team(s) to create/reset${opts.openCompetition ? ", open the competition" : ""}.`,
  );
  if (!opts.yes) {
    const answer = await ask("Type yes to continue: ");
    if (answer?.trim().toLowerCase() !== "yes") {
      console.error("provision:demo: cancelled; nothing was changed.");
      return 1;
    }
  }

  if (plan.admin || plan.teams.length > 0) {
    const r = psql(env, buildProvisionSql(plan));
    if (r.error || r.status !== 0) {
      console.error(
        `provision:demo: ${r.error ? "could not run psql." : describeFailure(r.stderr ?? "")} Nothing was changed.`,
      );
      return 5;
    }
  }
  let opened = false;
  let status = state.competition;
  if (opts.openCompetition) {
    const r = psql(env, OPEN_SQL, { tuples: true });
    if (r.error || r.status !== 0) {
      console.error(
        `provision:demo: identities were created, but the competition was not opened: ${r.error ? "could not run psql." : describeFailure(r.stderr ?? "")}`,
      );
      console.log(formatReport(plan, { competitionStatus: status, opened: false }));
      return 4;
    }
    status = r.stdout.trim() || status;
    opened = status === "RUNNING";
  }
  console.log(formatReport(plan, { competitionStatus: status, opened }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
