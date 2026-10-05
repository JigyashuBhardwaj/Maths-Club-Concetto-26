#!/usr/bin/env node
/**
 * Repository hygiene guard (no dependencies).
 *
 *   node scripts/hygiene.mjs          check only (exit 1 on problems)
 *   node scripts/hygiene.mjs --fix    also append any missing .gitignore rules
 *
 * Checks:
 *  1. .gitignore covers env files (but allows .env.example), build output, test output.
 *  2. No NEXT_PUBLIC_ variable has a secret-looking name (.env.example and src/).
 *  3. No real .env file is tracked by git (only .env.example may be).
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  appendFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const fix = process.argv.includes("--fix");
const problems = [];

/* ---- 1. .gitignore ------------------------------------------------------------------ */
const REQUIRED_IGNORES = [
  "node_modules/",
  ".next/",
  "out/",
  "coverage/",
  "playwright-report/",
  "test-results/",
  "*.tsbuildinfo",
  "next-env.d.ts",
  ".env*",
  "!.env.example",
  ".vercel",
  ".DS_Store",
];

const gitignorePath = join(root, ".gitignore");
const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
const lines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
// `node_modules` and `node_modules/` are equivalent; accept either spelling.
const has = (rule) =>
  lines.has(rule) || lines.has(rule.replace(/\/$/, "")) || lines.has(`/${rule}`);
const missing = REQUIRED_IGNORES.filter((r) => !has(r));

if (missing.length > 0) {
  if (fix) {
    const block = `\n# --- added by scripts/hygiene.mjs ---\n${missing.join("\n")}\n`;
    if (existing === "") writeFileSync(gitignorePath, block.trimStart());
    else appendFileSync(gitignorePath, existing.endsWith("\n") ? block : `\n${block}`);
    console.log(`hygiene: added ${missing.length} rule(s) to .gitignore: ${missing.join(", ")}`);
  } else {
    problems.push(`.gitignore is missing: ${missing.join(", ")} (run \`npm run hygiene:fix\`)`);
  }
}

/* ---- 2. secret-looking NEXT_PUBLIC_ names ------------------------------------------- */
const SECRET_WORDS = /(SECRET|SERVICE_ROLE|PRIVATE|PASSWORD|PASSWD|TOKEN|PEPPER|JWT|API_KEY)/i;
const PUBLIC_NAME = /\bNEXT_PUBLIC_[A-Z0-9_]+/g;

function scan(text, label) {
  for (const name of text.match(PUBLIC_NAME) ?? []) {
    if (SECRET_WORDS.test(name))
      problems.push(`${label}: "${name}" is exposed to the browser but looks like a secret`);
  }
}

if (existsSync(join(root, ".env.example")))
  scan(readFileSync(join(root, ".env.example"), "utf8"), ".env.example");

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(tsx?|jsx?|mjs|css)$/.test(entry))
      scan(readFileSync(full, "utf8"), full.slice(root.length + 1));
  }
}
if (existsSync(join(root, "src"))) walk(join(root, "src"));

/* ---- 3. tracked env files ----------------------------------------------------------- */
try {
  const tracked = execFileSync("git", ["ls-files"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
    .split("\n")
    .filter(Boolean);
  for (const file of tracked) {
    const base = file.split("/").pop() ?? "";
    if (/^\.env(\.|$)/.test(base) && base !== ".env.example")
      problems.push(`${file} is tracked by git — remove it and rotate any secret in it`);
  }
} catch {
  /* not a git checkout (e.g. exported zip): skip */
}

if (problems.length > 0) {
  console.error("hygiene: FAILED");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("hygiene: OK");
