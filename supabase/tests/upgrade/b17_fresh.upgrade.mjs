// Fresh-database lifecycle test for B17 (migration 19, the official content).
//
// The bug this guards against: migration 19 used to skip a database whose content tables were empty. But a fresh Supabase database
// is built migrations FIRST, seed AFTER (`supabase db reset`, `supabase start`; `supabase db push --include-seed` too), so migration
// 19 always saw empty tables, did nothing, was recorded as applied, and the seed then filled in PLACEHOLDER content: a fresh database
// never held the official content. Now migration 19 installs the official rows itself when the tables are empty, and updates them when
// they exist (production). This script plays the real orders in scratch databases and checks, against the canonical JSON:
//
//   1. RESET      migrations 1-19, then seed.sql twice (what `supabase db reset` does)  -> official content, installed (no audit row);
//   2. PUSH       migrations 1-19 alone (what `supabase db push` does, no seed), seed.sql afterwards (`--include-seed`);
//   3. UPGRADE    migrations 1-18 + seed (a B16 database), then migration 19              -> official content, updated;
//   4. the three end states are IDENTICAL, column by column, structure included (so an installed row is a seeded row), and equal the JSON;
//   5. migration 19 re-run on each changes nothing and writes no audit row; a partial database (99 hints) aborts it, changing nothing;
//   6. seed.sql run again afterwards never turns the official text back into placeholders.
//
// scripts/db-verify.mjs runs it with VERIFY_ADMIN_URL. It creates and drops its own scratch databases.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const adminUrl = process.env.VERIFY_ADMIN_URL;
if (!adminUrl) {
  console.error("fresh test: VERIFY_ADMIN_URL is not set (run it through `npm run db:verify`).");
  process.exit(2);
}
const root = resolve(import.meta.dirname, "../../..");
const tag = randomBytes(4).toString("hex");
const urlOf = (name) => {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  return u.toString();
};
const psql = (url, args, input) => {
  const r = spawnSync("psql", [url, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8",
    input,
  });
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};
const names = [];
function createDb(label) {
  const name = `concetto_fresh17_${label}_${tag}`;
  names.push(name);
  const r = psql(adminUrl, ["-c", `create database ${name}`]);
  assert.equal(r.code, 0, r.err);
  return urlOf(name);
}
const run = (url, file) => {
  const r = psql(url, ["-f", file]);
  assert.equal(r.code, 0, `${file}\n${r.err}`);
  return r;
};
const q = (url, sql) => {
  const r = psql(url, ["-c", sql]);
  assert.equal(r.code, 0, `${r.err}\n${sql}`);
  return r.out;
};

const migDir = join(root, "supabase/migrations");
const migrations = readdirSync(migDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const official = migrations.filter((f) => /^20261006000019_/.test(f));
assert.equal(official.length, 1, "migration 19");
assert.equal(migrations.length, 19);
assert.equal(migrations.at(-1), official[0], "migration 19 is the last one");
const seed = join(root, "supabase/seed.sql");
const applyMigrations = (url, upTo = migrations.length) =>
  migrations.slice(0, upTo).forEach((f) => run(url, join(migDir, f)));

const content = JSON.parse(
  readFileSync(join(root, "content/concetto26/official-content.json"), "utf8"),
);
const ids = "ABCDEFGHIJ";
const expected = {
  themes: content.themes.map((t, i) => ({ id: i + 1, name: t.name, description: t.description })),
  questions: content.questions.map((x) => ({
    id: ids.indexOf(x.theme) * 5 + x.ordinal,
    body_md: x.question,
    reward_coins: x.reward,
  })),
  hints: content.questions.flatMap((x) => {
    const id = ids.indexOf(x.theme) * 5 + x.ordinal;
    return [1, 2].map((tier) => ({
      id: (id - 1) * 2 + tier,
      body_md: tier === 1 ? x.hint1 : x.hint2,
    }));
  }),
};

/** Everything the content tables hold, as one JSON document, plus a hash of the part that is NOT content (the structure). */
const dump = (url) =>
  JSON.parse(
    q(
      url,
      `select jsonb_build_object(
         'themes',    (select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'description', description) order by id) from themes),
         'questions', (select jsonb_agg(jsonb_build_object('id', id, 'body_md', body_md, 'reward_coins', reward_coins) order by id) from questions),
         'hints',     (select jsonb_agg(jsonb_build_object('id', id, 'body_md', body_md) order by id) from hints),
         'structure', (select md5(concat_ws('#',
             (select string_agg(concat_ws('|', id, code, topics, difficulty, unlock_cost, display_order), ',' order by id) from themes),
             (select string_agg(concat_ws('|', id, theme_id, ordinal, difficulty, time_limit_seconds), ',' order by id) from questions),
             (select string_agg(concat_ws('|', id, question_id, tier, cost), ',' order by id) from hints),
             (select string_agg(concat_ws('|', id, question_id, seconds, cost, coalesce(max_purchases::text, 'null'), display_order), ',' order by id) from question_buy_time_options),
             (select string_agg(concat_ws('|', question_id, reference_answer, coalesce(solution_notes, '')), ',' order by question_id) from question_keys)))),
         'counts', (select jsonb_build_array((select count(*) from themes), (select count(*) from questions), (select count(*) from hints),
                     (select count(*) from question_keys), (select count(*) from question_buy_time_options))),
         'audit', (select coalesce(jsonb_agg(payload->>'mode' order by id), '[]'::jsonb) from audit_events where event_type = 'CONTENT_IMPORTED')
       )`,
    ),
  );

function assertOfficial(state, where) {
  assert.deepEqual(state.themes, expected.themes, `${where}: themes equal the JSON`);
  assert.deepEqual(
    state.questions,
    expected.questions,
    `${where}: questions and rewards equal the JSON`,
  );
  assert.deepEqual(state.hints, expected.hints, `${where}: hints equal the JSON`);
  assert.deepEqual(
    state.counts,
    [10, 50, 100, 50, 150],
    `${where}: 10/50/100 + 50 keys + 150 buy-time options`,
  );
  const text = JSON.stringify([state.themes, state.questions, state.hints]);
  assert.ok(!/PLACEHOLDER|Lorem|Placeholder/.test(text), `${where}: no placeholder text`);
  assert.equal(state.questions[16].reward_coins, 60, `${where}: D.2 = 60`);
  assert.ok(content.rules[1].text.includes("base time limit of 4 minutes"), "rule 2 = 4 minutes");
}

try {
  // 1. RESET: migrations, then the seed twice
  const reset = createDb("reset");
  applyMigrations(reset);
  run(reset, seed);
  run(reset, seed);
  const a = dump(reset);
  assertOfficial(a, "reset");
  assert.deepEqual(a.audit, [], "reset: an install writes no audit row");
  console.log("ok    fresh: migrations then seed (supabase db reset order) -> official content");

  // 2. PUSH: migrations alone, the seed only afterwards
  const push = createDb("push");
  applyMigrations(push);
  const mid = dump(push);
  assert.deepEqual(mid.themes, expected.themes, "push: official content is there before any seed");
  assert.deepEqual(mid.questions, expected.questions);
  assert.deepEqual(mid.hints, expected.hints);
  assert.deepEqual(mid.counts.slice(0, 3), [10, 50, 100]);
  run(push, seed); // --include-seed
  const b = dump(push);
  assertOfficial(b, "push + seed");
  console.log(
    "ok    fresh: migrations alone, seed afterwards (db push --include-seed) -> official content",
  );

  // 3. UPGRADE: a B16 database (placeholder seed), then migration 19
  const up = createDb("upgrade");
  applyMigrations(up, 18);
  run(up, seed);
  const before = dump(up);
  assert.ok(
    /PLACEHOLDER/.test(before.themes[0].name),
    "upgrade: the B16 database holds placeholders",
  );
  run(up, join(migDir, official[0]));
  const c = dump(up);
  assertOfficial(c, "upgrade");
  assert.deepEqual(c.audit, ["updated"], "upgrade: one audit row, mode updated");
  console.log("ok    upgrade: B16 database + migration 19 -> official content");

  // 4. identical end states, structure included
  assert.equal(a.structure, b.structure, "reset and push end in the same structure");
  assert.equal(
    a.structure,
    c.structure,
    "an installed row has exactly the structure of an upgraded (seeded) row",
  );
  assert.deepEqual({ ...a, audit: 0 }, { ...b, audit: 0 });
  assert.deepEqual({ ...a, audit: 0 }, { ...c, audit: 0 });
  console.log("ok    the three lifecycles end in identical databases (content and structure)");

  // 5. idempotency and the guard
  for (const [label, url, mode] of [
    ["reset", reset, []],
    ["push", push, []],
    ["upgrade", up, ["updated"]],
  ]) {
    const r = run(url, join(migDir, official[0]));
    assert.ok(r.code === 0);
    const after = dump(url);
    assert.deepEqual(
      after.audit,
      mode,
      `${label}: re-running migration 19 writes no new audit row`,
    );
    assertOfficial(after, `${label} re-run`);
    run(url, seed);
    assertOfficial(dump(url), `${label} + seed again`);
  }
  console.log("ok    re-running migration 19 or the seed changes nothing");

  const odd = createDb("odd");
  applyMigrations(odd, 18);
  run(odd, seed);
  q(odd, "delete from hints where id = 100");
  const snap = q(odd, "select md5(string_agg(name || description, '') ) from themes");
  const refused = psql(odd, ["-f", join(migDir, official[0])]);
  assert.notEqual(refused.code, 0, "a partial database is refused");
  assert.match(refused.err, /expected 10 themes, 50 questions and 100 hints, found 10, 50 and 99/);
  assert.equal(
    q(odd, "select md5(string_agg(name || description, '') ) from themes"),
    snap,
    "nothing changed",
  );
  const empty = createDb("onetheme");
  applyMigrations(empty, 18);
  q(
    empty,
    "insert into themes (id, code, name, description, difficulty, unlock_cost, display_order) values (1, 'A', 'x', 'y', 'EASY', 100, 1)",
  );
  const half = psql(empty, ["-f", join(migDir, official[0])]);
  assert.notEqual(half.code, 0, "one theme but no questions: refused");
  assert.equal(q(empty, "select count(*) from themes"), "1", "and nothing was installed");
  console.log("ok    a partial database aborts migration 19 and changes nothing");
} finally {
  for (const n of names) psql(adminUrl, ["-c", `drop database if exists ${n} with (force)`]);
}
console.log(
  "B17 fresh lifecycle: official content installed on a fresh database, updated on an upgrade, identical either way",
);
