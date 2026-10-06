#!/usr/bin/env node
// Creates the one and only SUPER_ADMIN account. Interactive; run it once per deployment.
//
//   PROVISION_DATABASE_URL=postgres://owner@127.0.0.1:5432/concetto npm run provision:superadmin
//
// - PROVISION_DATABASE_URL is a direct PostgreSQL connection for a role that may execute app.provision_superadmin
//   (the database owner / postgres). It is NOT the service-role key and is never stored anywhere.
// - Credentials are typed at the prompt (the password is not echoed) and sent to `psql` on STDIN only: never on a
//   command line, never in an environment variable, never in a file, never printed. The password is hashed (bcrypt,
//   cost 12) inside the database function; neither the password nor the hash is ever shown by this script.
// - Exactly one SUPER_ADMIN may exist (unique index staff_one_super_admin). If one already exists the script
//   refuses and changes nothing. Resetting a lost Super Admin password is a deliberate manual database operation.
// - Refuses non-local hosts unless PROVISION_ALLOW_REMOTE=1 (set it only for a database you really mean to touch).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

const USERNAME_RE = /^[A-Za-z0-9._-]{3,64}$/;
const MIN_PASSWORD = 10;
const MAX_PASSWORD_BYTES = 72; // bcrypt limit; the database enforces it too

export function validateInputs({ username, displayName, password }) {
  if (!USERNAME_RE.test(username))
    return "Username must be 3-64 characters: letters, digits, '.', '_' or '-'.";
  if (displayName.trim() === "" || displayName.length > 100)
    return "Display name must be 1-100 characters.";
  if (password.length < MIN_PASSWORD)
    return `Password must be at least ${MIN_PASSWORD} characters.`;
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES)
    return `Password must be at most ${MAX_PASSWORD_BYTES} bytes.`;
  return null;
}

/** Dollar-quote a value with a random tag that cannot occur inside it, so no escaping rules are needed. */
export function dollarQuote(value) {
  for (;;) {
    const tag = `q${randomBytes(6).toString("hex")}`;
    if (!value.includes(`$${tag}`)) return `$${tag}$${value}$${tag}$`;
  }
}

export function buildSql({ username, displayName, password }) {
  return `select app.provision_superadmin(${dollarQuote(username)}, ${dollarQuote(displayName)}, ${dollarQuote(password)});\n`;
}

/** Connection settings go to the child as PG* variables so that the URL (which may hold a password) is not in argv. */
export function connectionEnv(urlString, baseEnv = process.env) {
  const u = new URL(urlString);
  if (!["postgres:", "postgresql:"].includes(u.protocol)) throw new Error("not a postgres URL");
  const env = { ...baseEnv };
  for (const k of ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "PGSSLMODE"])
    delete env[k];
  env.PGHOST = u.hostname.replace(/^\[|\]$/g, "");
  if (u.port) env.PGPORT = u.port;
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  env.PGDATABASE = decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres";
  const ssl = u.searchParams.get("sslmode");
  if (ssl) env.PGSSLMODE = ssl;
  return env;
}

/** Map psql stderr to a safe message; never forwards anything that could contain a credential. */
export function describeFailure(stderr) {
  if (/SUPER_ADMIN_EXISTS/.test(stderr))
    return {
      code: 3,
      message: "A SUPER_ADMIN already exists (or that username is taken). Nothing was changed.",
    };
  if (/INVALID_USERNAME|INVALID_DISPLAY_NAME|INVALID_PASSWORD/.test(stderr))
    return {
      code: 4,
      message: "The database rejected the credentials as invalid. Nothing was changed.",
    };
  if (/function app\.provision_superadmin.*does not exist|schema "app" does not exist/.test(stderr))
    return {
      code: 5,
      message: "The auth migration (…_auth_functions.sql) has not been applied to this database.",
    };
  if (/permission denied/.test(stderr))
    return { code: 5, message: "This database role may not execute app.provision_superadmin." };
  if (
    /could not connect|connection to server|password authentication failed|does not exist/.test(
      stderr,
    )
  )
    return { code: 5, message: "Could not connect to the database with PROVISION_DATABASE_URL." };
  return {
    code: 5,
    message: "Provisioning failed (database error). Nothing was printed to avoid leaking input.",
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Prompting. With a TTY: hidden password entry. Without one (piped stdin, used by tests): plain lines.
// ---------------------------------------------------------------------------------------------------------------
function makePrompter() {
  if (process.stdin.isTTY) return makeTtyPrompter();
  // Piped stdin (used by tests): one answer per line, nothing is echoed back.
  const rl = createInterface({ input: process.stdin, terminal: false });
  const queue = [];
  const waiters = [];
  let closed = false;
  rl.on("line", (line) => (waiters.length ? waiters.shift()(line) : queue.push(line)));
  rl.on("close", () => {
    closed = true;
    while (waiters.length) waiters.shift()(null);
  });
  const nextLine = () =>
    queue.length
      ? Promise.resolve(queue.shift())
      : closed
        ? Promise.resolve(null)
        : new Promise((res) => waiters.push(res));
  return {
    ask: async (label) => {
      process.stderr.write(`${label}: \n`);
      return nextLine();
    },
    close: () => rl.close(),
  };
}

function makeTtyPrompter() {
  const readVisible = (label) =>
    new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
      rl.question(`${label}: `, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  const readHidden = (label) =>
    new Promise((resolve) => {
      process.stderr.write(`${label}: `);
      let buf = "";
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      const onData = (chunk) => {
        for (const ch of chunk) {
          if (ch === "\r" || ch === "\n" || ch === "\u0004") {
            process.stdin.setRawMode(false);
            process.stdin.off("data", onData);
            process.stdin.pause();
            process.stderr.write("\n");
            resolve(buf);
            return;
          }
          if (ch === "\u0003") {
            process.stdin.setRawMode(false);
            process.stderr.write("\n");
            process.exit(130);
          }
          if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
          else buf += ch;
        }
      };
      process.stdin.on("data", onData);
    });
  return {
    ask: (label, { hidden = false } = {}) => (hidden ? readHidden(label) : readVisible(label)),
    close: () => {},
  };
}

async function main() {
  const dbUrl = process.env.PROVISION_DATABASE_URL;
  if (!dbUrl) {
    console.error(
      "provision:superadmin: set PROVISION_DATABASE_URL to a direct PostgreSQL URL (never the service-role key).",
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
        `provision:superadmin: refusing non-local host "${u.hostname}" (set PROVISION_ALLOW_REMOTE=1 if you really mean it).`,
      );
      return 2;
    }
  } catch {
    console.error("provision:superadmin: PROVISION_DATABASE_URL is not a valid postgres URL.");
    return 2;
  }

  const p = makePrompter();
  console.error(`Provisioning the SUPER_ADMIN on ${target}`);
  const username = await p.ask("Super Admin username");
  const displayName = await p.ask("Display name");
  const password = await p.ask(`Password (min ${MIN_PASSWORD} chars, hidden)`, { hidden: true });
  const again = await p.ask("Repeat password", { hidden: true });
  if ([username, displayName, password, again].some((v) => v === null)) {
    console.error("provision:superadmin: input ended early; nothing was changed.");
    return 1;
  }
  if (password !== again) {
    console.error("provision:superadmin: passwords do not match; nothing was changed.");
    return 1;
  }
  const problem = validateInputs({ username, displayName, password });
  if (problem) {
    console.error(`provision:superadmin: ${problem} Nothing was changed.`);
    return 1;
  }
  const confirm = await p.ask(
    `Create the SUPER_ADMIN "${username}" on ${target}? Type yes to continue`,
  );
  p.close();
  if (confirm?.trim().toLowerCase() !== "yes") {
    console.error("provision:superadmin: cancelled; nothing was changed.");
    return 1;
  }

  const r = spawnSync("psql", ["-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    env,
    input: buildSql({ username, displayName, password }),
    encoding: "utf8",
  });
  if (r.error) {
    console.error(
      "provision:superadmin: could not run psql (is the PostgreSQL client installed?).",
    );
    return 5;
  }
  if (r.status !== 0) {
    const f = describeFailure(r.stderr ?? "");
    console.error(`provision:superadmin: ${f.message}`);
    return f.code;
  }
  console.log(
    `SUPER_ADMIN "${username}" created. The password was hashed in the database and is not stored anywhere else.`,
  );
  return 0;
}

// Only run when executed directly (the helpers above are imported by unit tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
