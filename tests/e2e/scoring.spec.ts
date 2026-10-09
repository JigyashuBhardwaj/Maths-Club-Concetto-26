import { randomBytes, randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import {
  adminReviewer,
  ageTeam,
  api,
  beginTheme,
  createPlayerTeam,
  inspect,
  memberApi,
  player,
  signInMember,
} from "./support/game";
import type { E2ETeam } from "./support/identities";
import { loginForCookies, signInStaff, staffCredentials } from "./support/session";

/**
 * Patch B16: the score, the live leaderboard and the UFM penalty, in real browsers against the real routes. The
 * in-memory database behind them mirrors the SQL (tests/e2e/support/fake-*.mjs); the SQL itself, the rounding, the ties,
 * the freeze and the concurrency are proven against real PostgreSQL in supabase/tests/150-170 and the concurrency script.
 *
 * score = completed themes x 500 + solved questions x 100 + remaining coins - minutes taken x 5.
 * A team starts with 500 coins, unlocking a theme costs 100, a hint 20, an approval pays 50. Minutes are ELAPSED minutes
 * (allowance - remaining), rounded to the nearest minute, so `ageTeam(.., 405_000)` (6:45) plus a few seconds of test
 * run time is always exactly 7 minutes, with a 45 s margin either way.
 *
 * Every test builds its OWN team through the real `POST /api/admin/teams`, so tests never share a clock or a balance.
 */
test.describe.configure({ timeout: 120_000 });

const Q1 = 1;
const SEVEN_MIN = 405_000;
const LIVE = { timeout: 25_000 };

interface Row {
  rank: number;
  team_id: string;
  score: number;
}

/** The staff leaderboard, read the way the Admin home reads it. */
async function staffBoard(ctx: APIRequestContext): Promise<Row[]> {
  const res = await ctx.get("/api/leaderboard");
  expect(res.status()).toBe(200);
  return (await res.json()).data.rows as Row[];
}

async function adminCtx() {
  return api(await loginForCookies("/api/auth/staff/login", staffCredentials("e2e_admin")));
}

async function superCtx() {
  return api(await loginForCookies("/api/auth/staff/login", staffCredentials("e2e_super")));
}

/** The official score the admin leaderboard shows for a team, or null when it is not on the board. */
async function scoreOnBoard(ctx: APIRequestContext, team: E2ETeam): Promise<number | null> {
  return (await staffBoard(ctx)).find((r) => r.team_id === team.code)?.score ?? null;
}

async function teamIdOf(ctx: APIRequestContext, team: E2ETeam): Promise<string> {
  const res = await ctx.get("/api/admin/matrix");
  const teams = (await res.json()).data.teams as { id: string; team_code: string }[];
  return teams.find((t) => t.team_code === team.code)!.id;
}

/** Submits an answer to `qid` as `p` and returns the id the database gave the submission. */
async function submitAnswer(team: E2ETeam, p: ReturnType<typeof player>, qid: number) {
  const res = await p.submit(qid, "42");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (await inspect(team)).submissions.find((s) => s.qid === qid)!.id;
}

/** A team that is mid-way through theme A, seven minutes into its four hours, 400 coins after the unlock. */
async function startedTeam() {
  const team = await createPlayerTeam();
  await beginTheme(team);
  await ageTeam(team, SEVEN_MIN, { questions: false });
  return team;
}

test.describe("score and leaderboard (API)", () => {
  test("the score follows spend, approvals and the finished theme: completed x 500 + solved x 100 + coins - minutes x 5", async () => {
    const team = await startedTeam();
    const admin = await adminCtx();
    const { api: reviewerApi, review } = await adminReviewer();
    const a = player(await memberApi(team, 1));
    try {
      // 500 coins - 100 for the unlock = 400; 7 minutes = -35
      expect(await scoreOnBoard(admin, team)).toBe(365);
      expect((await inspect(team)).score).toBe(365);

      // a hint costs 20 coins, so 20 points
      expect((await a.hint(Q1, 1)).status).toBe(200);
      expect(await scoreOnBoard(admin, team)).toBe(345);

      // an approved answer: +50 coins reward and +100 for a solved question
      const first = await submitAnswer(team, a, Q1);
      expect(await scoreOnBoard(admin, team)).toBe(345); // waiting for approval changes nothing
      expect((await review.approve(first)).status).toBe(200);
      expect(await scoreOnBoard(admin, team)).toBe(495);

      // four more approvals complete the theme: +500 for it, +50 and +100 for each answer
      for (const qid of [2, 3, 4, 5]) {
        const id = await submitAnswer(team, a, qid);
        expect((await review.approve(id)).status).toBe(200);
      }
      expect(await scoreOnBoard(admin, team)).toBe(1595);
      expect((await inspect(team)).score).toBe(1595);
    } finally {
      await reviewerApi.dispose();
      await admin.dispose();
    }
  });

  test("Final Submit freezes the score; a late approval pays coins but never changes it", async () => {
    const team = await startedTeam();
    const admin = await adminCtx();
    const { api: reviewerApi, review } = await adminReviewer();
    const a = player(await memberApi(team, 1));
    try {
      const pending = await submitAnswer(team, a, Q1);
      expect(await scoreOnBoard(admin, team)).toBe(365);
      expect((await a.finalSubmit()).status).toBe(200);

      const frozen = await inspect(team);
      expect(frozen.final).toMatchObject({ minutes: 7, completed: 0, solved: 0, score: 365 });
      expect(await scoreOnBoard(admin, team)).toBe(365);

      // time passes for nobody: the frozen team's score does not drift, however long the page is open
      await ageTeam(team, 600_000);
      await new Promise((r) => setTimeout(r, 1500));
      expect(await scoreOnBoard(admin, team)).toBe(365);

      // the reviewer approves the waiting answer after the freeze: the reward is paid once, the score stays
      const approved = await review.approve(pending);
      expect(approved.status).toBe(200);
      expect(approved.body.data.reward_awarded).toBe(50);
      const after = await inspect(team);
      expect(after.coins).toBe(frozen.coins + 50);
      expect(after.final).toEqual(frozen.final);
      expect(await scoreOnBoard(admin, team)).toBe(365);
    } finally {
      await reviewerApi.dispose();
      await admin.dispose();
    }
  });

  test("when the timer runs out the score is frozen at the full four hours, and a late approval does not change it", async () => {
    const team = await createPlayerTeam();
    await beginTheme(team);
    const admin = await adminCtx();
    const { api: reviewerApi, review } = await adminReviewer();
    const a = player(await memberApi(team, 1));
    try {
      const pending = await submitAnswer(team, a, Q1);
      // 4 h of the clock pass (and a minute more): the team is over
      await ageTeam(team, 14_400_000 + 60_000, { questions: false });
      const s = await a.state();
      expect(s.body.data.team.status).toBe("ENDED");

      // 400 coins - 240 minutes x 5 = -800: a negative score is a score
      expect(await scoreOnBoard(admin, team)).toBe(-800);
      expect((await inspect(team)).final).toMatchObject({ minutes: 240, score: -800 });

      expect((await review.approve(pending)).status).toBe(200); // pays the coins...
      expect((await inspect(team)).coins).toBe(450);
      expect(await scoreOnBoard(admin, team)).toBe(-800); // ...but the frozen score is final
    } finally {
      await reviewerApi.dispose();
      await admin.dispose();
    }
  });

  test("started teams rank before teams that have not started, ranks are 1..n without gaps, the order is the same for everyone", async () => {
    const started = await startedTeam();
    const idle = await createPlayerTeam(); // never started: 500 on the formula, ranked after every started team
    const admin = await adminCtx();
    const sup = await superCtx();
    const member = await memberApi(started, 1);
    try {
      const rows = await staffBoard(admin);
      expect(rows.map((r) => r.rank)).toEqual(rows.map((_, i) => i + 1));
      const iStarted = rows.findIndex((r) => r.team_id === started.code);
      const iIdle = rows.findIndex((r) => r.team_id === idle.code);
      expect(iStarted).toBeGreaterThanOrEqual(0);
      expect(iIdle).toBeGreaterThan(iStarted);
      expect(rows[iIdle]!.score).toBe(500);

      // the Super Admin and the participant see the very same order (the participant board also carries "me")
      expect(await staffBoard(sup)).toEqual(rows);
      const res = await member.get("/api/p/leaderboard");
      expect(res.status()).toBe(200);
      const mine = (await res.json()).data as { rows: Row[]; me: Row };
      expect(mine.rows.map((r) => r.team_id)).toEqual(rows.map((r) => r.team_id));
      expect(mine.me).toMatchObject({ team_id: started.code, score: 365 });
      expect(mine.rows.find((r) => r.team_id === started.code)).toEqual(mine.me);
      for (const r of mine.rows)
        expect(Object.keys(r).sort()).toEqual(["rank", "score", "team_id"]);
    } finally {
      await member.dispose();
      await sup.dispose();
      await admin.dispose();
    }
  });
});

test.describe("leaderboard on screen", () => {
  test("a participant sees every team, a prominent own line and nothing to click", async ({
    page,
    context,
  }) => {
    const team = await startedTeam();
    await signInMember(context, team, 1);
    await page.goto("/participant");

    const me = page.getByTestId("lb-me");
    await expect(me.getByLabel("Your team ID")).toHaveText(team.code, LIVE);
    await expect(me.getByLabel("Your score")).toHaveText("365", LIVE);
    await expect(me.getByLabel("Your rank")).toHaveText(/^#\d+$/);

    // the same team is highlighted in the table, with the same rank and score
    const mine = page.locator("tr.lb-mine");
    await expect(mine).toHaveCount(1);
    await expect(mine.locator("td").nth(1)).toHaveText(team.code);
    await expect(mine.locator("td").nth(2)).toHaveText("365");
    expect(`#${(await mine.locator("td").first().innerText()).replace("#", "")}`).toBe(
      await me.getByLabel("Your rank").innerText(),
    );

    // view only: no button, link or input inside the board
    await expect(
      page.locator(".leaderboard button, .leaderboard a, .leaderboard input"),
    ).toHaveCount(0);
    // the team's own rows are real rows, not placeholders (at least this team and the shared ones exist)
    const real = await page.locator(".leaderboard tbody tr td:nth-child(2)").allInnerTexts();
    expect(real.filter((t) => t !== "—" && t !== "").length).toBeGreaterThanOrEqual(1);
    expect(real).toContain(team.code);
  });

  test("the participant's own line moves as soon as the team's score does (a hint purchase, no waiting for the minute)", async ({
    page,
    context,
  }) => {
    const team = await startedTeam();
    await signInMember(context, team, 1);
    await page.goto("/participant");
    await expect(page.getByTestId("lb-me").getByLabel("Your score")).toHaveText("365", LIVE);

    // another member acts through the API (a second sign-in of the SAME member would end the browser's session)
    const a = player(await memberApi(team, 2));
    expect((await a.hint(Q1, 1)).status).toBe(200); // 20 coins
    // the team's state is polled every few seconds; a state change refreshes the board right after
    await expect(page.getByTestId("lb-me").getByLabel("Your score")).toHaveText("345", LIVE);
  });

  test("Admin and Super Admin see rank, Team ID and score of every team", async ({ page }) => {
    const team = await startedTeam();
    for (const who of ["e2e_admin", "e2e_super"] as const) {
      await page.context().clearCookies();
      await signInStaff(page, who);
      await page.goto(who === "e2e_admin" ? "/admin" : "/superadmin");
      const board = page.getByRole("table");
      await expect(board.getByRole("columnheader")).toHaveText(["Rank", "Team_ID", "Score"]);
      await expect(
        board.getByRole("row", { name: new RegExp(`#\\d+\\s*${team.code}\\s*365`) }),
      ).toBeVisible(LIVE);
    }
  });
});

/** Opens My Teams as the E2E admin and the penalty dialog of `team`. */
async function openPenalty(page: Page, team: E2ETeam) {
  await signInStaff(page, "e2e_admin");
  await page.goto("/admin/teams");
  const button = page.getByTestId(`team-${team.code}`);
  await expect(button).toBeVisible(LIVE);
  await button.click();
  const dialog = page.getByRole("dialog", { name: "Penalise this team" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(team.code);
  return dialog;
}

test.describe("UFM penalty (Penalise this team)", () => {
  test("No changes nothing at all", async ({ page }) => {
    const team = await startedTeam();
    const before = await inspect(team);
    const dialog = await openPenalty(page, team);
    await dialog.getByRole("button", { name: "No" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId(`ufm-${team.code}`)).toHaveCount(0);
    const after = await inspect(team);
    expect(after.penalizedAt).toBeNull();
    expect(after.status).toBe("RUNNING");
    expect(after.version).toBe(before.version);
    expect(after.audit).toEqual(before.audit);
    // and Escape is the same as No
    await page.getByTestId(`team-${team.code}`).click();
    await expect(page.getByRole("dialog", { name: "Penalise this team" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect((await inspect(team)).penalizedAt).toBeNull();
  });

  test("Yes zeroes the official score, freezes the team for good and keeps everything it did", async ({
    page,
    context,
  }) => {
    const team = await startedTeam();
    const a = player(await memberApi(team, 2)); // member 1 is the browser's, and one sign-in per member is allowed
    const { api: reviewerApi, review } = await adminReviewer();
    const admin = await adminCtx();
    try {
      expect((await a.hint(Q1, 1)).status).toBe(200);
      const id = await submitAnswer(team, a, Q1);
      expect((await review.approve(id)).status).toBe(200);
      const before = await inspect(team);
      expect(await scoreOnBoard(admin, team)).toBe(495);

      const dialog = await openPenalty(page, team);
      await dialog.getByRole("button", { name: "Yes" }).click();
      await expect(dialog).toBeHidden(LIVE);
      await expect(page.getByTestId(`ufm-${team.code}`)).toBeVisible(LIVE);

      const after = await inspect(team);
      expect(after.status).toBe("ENDED");
      expect(after.penalizedAt).not.toBeNull();
      expect(after.score).toBe(0);
      expect(after.audit.filter((t) => t === "UFM_PENALIZED")).toHaveLength(1);
      // history intact: the coins, the hint, the ledger, the approved submission and the unlocked theme are all still there
      expect(after.coins).toBe(before.coins);
      expect(after.hints).toEqual(before.hints);
      expect(after.ledger).toEqual(before.ledger);
      expect(after.themes).toEqual(before.themes);
      expect(after.submissions).toEqual(before.submissions);
      expect(after.final).toMatchObject({ solved: 1 }); // the gameplay score it had is kept as history

      // official score 0 on every board
      expect(await scoreOnBoard(admin, team)).toBe(0);
      await signInMember(context, team, 1);
      const view = await context.newPage();
      await view.goto("/participant");
      await expect(view.getByTestId("lb-me").getByLabel("Your score")).toHaveText("0", LIVE);

      // the team is frozen: every participant action is refused with the same code
      for (const r of [
        await a.unlock(2),
        await a.enter(2),
        await a.hint(Q1, 2),
        await a.finalSubmit(),
        await a.submit(2, "late"),
      ]) {
        expect(r.status).toBe(409);
        expect(r.body.error.code).toBe("TEAM_ENDED");
      }

      // reopening the dialog says so and offers nothing but Close
      await page.getByTestId(`team-${team.code}`).click();
      const again = page.getByRole("dialog", { name: "Penalise this team" });
      await expect(again).toContainText("already been penalised");
      await expect(again.getByRole("button", { name: "Yes" })).toHaveCount(0);
      await again.getByRole("button", { name: "Close" }).click();
    } finally {
      await reviewerApi.dispose();
      await admin.dispose();
    }
  });

  test("is idempotent: the same key replays, a second request changes nothing and writes no second audit row", async () => {
    const team = await startedTeam();
    const admin = await adminCtx();
    try {
      const id = await teamIdOf(admin, team);
      const key = randomUUID();
      const send = (k: string) =>
        admin.post(`/api/admin/teams/${id}/penalize`, {
          headers: { "Idempotency-Key": k },
          data: { confirm: true },
        });
      const first = await send(key);
      expect(first.status()).toBe(200);
      expect((await first.json()).data).toMatchObject({
        changed: true,
        team: { team_code: team.code, status: "ENDED", official_score: 0 },
      });
      const replay = await send(key);
      expect(replay.status()).toBe(200);
      expect(replay.headers()["idempotent-replay"]).toBe("true");
      const second = await send(randomUUID()); // a different intent on a team already penalised
      expect(second.status()).toBe(200);
      expect((await second.json()).data.changed).toBe(false);
      const t = await inspect(team);
      expect(t.audit.filter((x) => x === "UFM_PENALIZED")).toHaveLength(1);
      expect(t.score).toBe(0);
    } finally {
      await admin.dispose();
    }
  });

  test("only the Admin who owns the team may do it", async () => {
    const team = await startedTeam();
    const idle = await createPlayerTeam();
    const admin = await adminCtx();
    const sup = await superCtx();
    const member = await memberApi(team, 1);
    try {
      const id = await teamIdOf(admin, team);
      const idleId = await teamIdOf(admin, idle);
      const body = { confirm: true };
      const url = `/api/admin/teams/${id}/penalize`;
      const key = () => ({ "Idempotency-Key": randomUUID() });

      // a participant and the Super Admin are refused; nobody who is not signed in gets anywhere
      expect((await member.post(url, { headers: key(), data: body })).status()).toBe(403);
      expect((await sup.post(url, { headers: key(), data: body })).status()).toBe(403);
      const anon = await api();
      expect((await anon.post(url, { headers: key(), data: body })).status()).toBe(401);
      await anon.dispose();

      // another Admin gets "not found": the team is not theirs and its existence is not confirmed
      const name = `pen_${randomBytes(4).toString("hex")}`;
      const password = randomBytes(12).toString("base64url");
      const created = await sup.post("/api/super/admins", {
        headers: key(),
        data: { username: name, password, confirmPassword: password },
      });
      expect(created.status()).toBe(200);
      const other = await api(
        await loginForCookies("/api/auth/staff/login", { username: name, password }),
      );
      expect((await other.post(url, { headers: key(), data: body })).status()).toBe(404);
      await other.dispose();

      // a cross-site request, a missing key and a malformed body change nothing either
      const cross = await admin.post(url, {
        headers: { ...key(), Origin: "https://evil.example" },
        data: body,
      });
      expect(cross.status()).toBe(403);
      expect((await admin.post(url, { data: body })).status()).toBe(400);
      for (const bad of [
        {},
        { confirm: false },
        { confirm: "true" },
        { confirm: true, score: 9 },
      ]) {
        expect(
          (await admin.post(url, { headers: key(), data: bad })).status(),
          JSON.stringify(bad),
        ).toBe(400);
      }
      expect(
        (
          await admin.post("/api/admin/teams/not-a-uuid/penalize", { headers: key(), data: body })
        ).status(),
      ).toBe(404);

      // a team that has not started has nothing to penalise
      const early = await admin.post(`/api/admin/teams/${idleId}/penalize`, {
        headers: key(),
        data: body,
      });
      expect(early.status()).toBe(409);
      expect((await early.json()).error.code).toBe("TEAM_NOT_STARTED");

      expect((await inspect(team)).penalizedAt).toBeNull();
      expect((await inspect(idle)).penalizedAt ?? null).toBeNull();
    } finally {
      await member.dispose();
      await sup.dispose();
      await admin.dispose();
    }
  });
});
