import { randomUUID } from "node:crypto";

import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";

import { SECRET_PREFIX } from "./support/fake-gameplay.mjs";
import {
  adminReviewer,
  api,
  createPlayerTeam,
  inspect,
  player,
  signInMember,
} from "./support/game";
import type { E2ETeam } from "./support/identities";
import { control } from "./support/session";

/**
 * The B13 vertical slice, played by two members of ONE team in two separate browser contexts (two cookie jars, two
 * pages, two poll loops), against the real Next.js routes and the server-authoritative game engine:
 *
 *   login (timer NOT started) -> first member enters (timer starts, once) -> theme unlock (team-wide, charged once)
 *   -> entering Q1 starts its timer (no Start button; both members get the same deadline) -> the draft survives a
 *   refresh -> submit -> PENDING_APPROVAL (question timer frozen, team timer running) -> controlled approval -> the
 *   reward once -> the next question ACTIVE with its own deadline -> the client cannot override any of it.
 *
 * The tests run in order and share the team and the two members (describe.serial). The browser-side engine is the
 * in-memory stand-in of tests/e2e/support/fake-gameplay.mjs, which mirrors the SQL; true row-level races are proven
 * against real PostgreSQL in supabase/tests/concurrency/team_play.concurrency.mjs.
 */

// Question ids: theme n, ordinal k  ->  (n - 1) * 5 + k.   A=1 B=2 C=3 D=4
const THEME_B = 2;
const THEME_C = 3;
const THEME_D = 4;
const B1 = 6;
const B2 = 7;
const C1 = 11;
const D1 = 16;
const UNLOCK_COST = 100;
const REWARD = 50;
/** A page load under software WebGL can take a while; this is a wait for the page, not for the engine. */
const LOAD = { timeout: 45_000 };

test.describe.configure({ mode: "serial", timeout: 120_000 });

test.describe("gameplay: two members of one team", () => {
  let team: E2ETeam;
  let ctx1: BrowserContext;
  let ctx2: BrowserContext;
  let one: Page;
  let two: Page;
  let api1: APIRequestContext;
  let api2: APIRequestContext;
  /** Every API response body either member's browser saw (to prove that no reference answer ever reaches a participant). */
  const seen: string[] = [];

  test.beforeAll(async ({ browser }, info) => {
    team = await createPlayerTeam();
    const use = info.project.use;
    const options = {
      baseURL: use.baseURL,
      viewport: use.viewport ?? undefined,
      userAgent: use.userAgent,
      isMobile: use.isMobile,
      hasTouch: use.hasTouch,
      deviceScaleFactor: use.deviceScaleFactor,
    };
    ctx1 = await browser.newContext(options);
    ctx2 = await browser.newContext(options);
    const c1 = await signInMember(ctx1, team, 1);
    const c2 = await signInMember(ctx2, team, 2);
    api1 = await api(c1);
    api2 = await api(c2);
    for (const ctx of [ctx1, ctx2]) {
      ctx.on("response", async (res) => {
        if (!res.url().includes("/api/")) return;
        try {
          seen.push(await res.text());
        } catch {
          /* a redirect or an aborted request has no body */
        }
      });
    }
    one = await ctx1.newPage();
    two = await ctx2.newPage();
  });

  test.afterAll(async () => {
    await api1?.dispose();
    await api2?.dispose();
    await ctx1?.close();
    await ctx2?.close();
  });

  const questionTimer = (page: Page) =>
    page.getByRole("group", { name: "Question timer" }).locator(".stat-value");
  const coinsOf = (page: Page) => page.locator(".home-stats .stat-value").nth(1);
  const toSeconds = (mmss: string) => {
    const [m, s] = mmss.split(":").map(Number);
    return m! * 60 + s!;
  };

  test("logging in does not start the team timer; the first member to enter starts it for everyone, once", async () => {
    await one.goto("/participant");
    await two.goto("/participant");
    const gate1 = one.getByRole("dialog", { name: "Enter the competition" });
    const gate2 = two.getByRole("dialog", { name: "Enter the competition" });
    await expect(gate1).toBeVisible();
    await expect(gate2).toBeVisible();
    let t = await inspect(team);
    expect(t.status).toBe("NOT_STARTED");
    expect(t.startedAt).toBeNull();

    await gate1.getByRole("button", { name: "Enter competition" }).click();
    await expect(gate1).toBeHidden();
    await expect(one.locator(".home-stats .stat-value").first()).toHaveText(/^0[34]:\d\d:\d\d$/);
    t = await inspect(team);
    expect(t.status).toBe("RUNNING");
    expect(t.endsAt! - t.startedAt!).toBe(14_400_000);

    // the second member never pressed anything: the next poll of the server removes their gate
    await expect(gate2).toBeHidden({ timeout: 20_000 });
    await expect(two.locator(".home-stats .stat-value").first()).toHaveText(/^0[34]:\d\d:\d\d$/);

    // a second entry (a retry, a teammate) neither restarts nor extends the timer
    const again = await player(api2).start();
    expect(again.body.data.started_now).toBe(false);
    const after = await inspect(team);
    expect(after.startedAt).toBe(t.startedAt);
    expect(after.endsAt).toBe(t.endsAt);
    expect(after.audit.filter((e) => e === "TEAM_STARTED")).toHaveLength(1);
  });

  test("a theme unlocked by one member is unlocked for the whole team and charged once", async () => {
    await expect(coinsOf(one)).toHaveText("500");
    await one.getByRole("button", { name: "THEME B" }).focus();
    await one.keyboard.press("Enter");
    const dialog = one.getByRole("dialog", { name: "THEME B" });
    await dialog.getByRole("button", { name: `Unlock with ${UNLOCK_COST} coins` }).click();
    await expect(dialog.getByRole("link", { name: "Let's solve" })).toBeVisible();
    await expect(coinsOf(one)).toHaveText("400");

    // member 2 did nothing: their next poll shows the theme as unlocked and the balance as 400, with no charge of their own
    await expect(coinsOf(two)).toHaveText("400", { timeout: 20_000 });
    await two.getByRole("button", { name: "THEME B" }).focus();
    await two.keyboard.press("Enter");
    await expect(
      two.getByRole("dialog", { name: "THEME B" }).getByRole("link", { name: "Let's solve" }),
    ).toBeVisible();
    await two.keyboard.press("Escape");
    await dialog.getByRole("button", { name: "Explore other themes" }).click();

    // unlocking it again is rejected without a second charge
    const second = await player(api2).unlock(THEME_B);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("THEME_ALREADY_UNLOCKED");
    expect((await inspect(team)).coins).toBe(400);

    // two members unlock the same theme at the same moment: exactly one unlock and one deduction
    const [a, b] = await Promise.all([player(api1).unlock(THEME_C), player(api2).unlock(THEME_C)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const t = await inspect(team);
    expect(t.coins).toBe(300);
    expect(t.themes.sort()).toEqual([THEME_B, THEME_C]);
    expect(t.audit.filter((e) => e === "THEME_UNLOCKED")).toHaveLength(2);
  });

  test("entering Q1 starts its timer on the server: no Start button, one deadline for both members", async () => {
    // Q1 of theme C starts through two simultaneous entries: one start, one deadline
    const [e1, e2] = await Promise.all([player(api1).enter(C1), player(api2).enter(C1)]);
    expect([e1.body.data.started_now, e2.body.data.started_now].sort()).toEqual([false, true]);
    expect(e1.body.data.question.deadline).toBe(e2.body.data.question.deadline);

    // Q1 of theme B: the page itself enters the question; before that the timer is NULL (AVAILABLE)
    expect((await inspect(team)).questions[String(B1)]).toMatchObject({
      state: "AVAILABLE",
      deadline: null,
    });
    await one.goto("/participant/theme/B/1");
    await expect(one.locator(".q-text")).toContainText("Body of question B1", LOAD);
    await expect(one.getByRole("button", { name: /start/i })).toHaveCount(0);
    await expect(questionTimer(one)).toHaveText(/0[34]:\d\d/);
    const started = (await inspect(team)).questions[String(B1)]!;
    expect(started.state).toBe("ACTIVE");
    expect(started.deadline).not.toBeNull();

    // the second member opens the same page later: same body, same deadline, no restart
    await two.goto("/participant/theme/B/1");
    await expect(two.locator(".q-text")).toContainText("Body of question B1", LOAD);
    await expect(questionTimer(two)).toHaveText(/0[34]:\d\d/);
    // both pages count down to the SAME server deadline (the browser, the app server and the stand-in share one clock;
    // a page that is busy rendering lags by a few ticks, never by a different deadline)
    for (const page of [one, two]) {
      await page.bringToFront(); // a page in the background renders its ticks late
      await expect
        .poll(
          async () =>
            Math.abs(
              toSeconds(await questionTimer(page).innerText()) -
                Math.round((started.deadline! - Date.now()) / 1000),
            ),
          { timeout: 20_000 },
        )
        .toBeLessThanOrEqual(3);
    }
    expect((await inspect(team)).questions[String(B1)]!.deadline).toBe(started.deadline);

    const rejoin = await player(api2).enter(B1);
    expect(rejoin.body.data.started_now).toBe(false);
    expect(rejoin.body.data.question.deadline).toBe(started.deadline);
    expect((await inspect(team)).audit.filter((e) => e === "QUESTION_STARTED")).toHaveLength(2);

    // the team timer and the question timer are independent: Q1's deadline is far inside the team's
    const t = await inspect(team);
    expect(started.deadline!).toBeLessThan(t.endsAt!);
  });

  test("the draft is stored on the server and survives a refresh, for either member", async () => {
    const box = one.getByRole("textbox");
    await box.fill("x = 4 because 2x = 8");
    await expect(
      one.getByRole("status").filter({ hasText: "Draft saved for your team" }),
    ).toBeVisible({ timeout: 15_000 });
    await one.reload();
    await expect(one.getByRole("textbox")).toHaveValue("x = 4 because 2x = 8", LOAD);
    await two.reload();
    await expect(two.getByRole("textbox")).toHaveValue("x = 4 because 2x = 8", LOAD);
    const stored = await player(api2).question(B1);
    expect(stored.body.data.question.draft.answer).toBe("x = 4 because 2x = 8");
  });

  test("submit freezes the question timer (the team timer keeps running) and waits for approval", async () => {
    const teamTimer = (page: Page) =>
      page.getByRole("group", { name: "Team timer" }).locator(".stat-value");
    const teamBefore = await teamTimer(one).innerText();
    await one.getByRole("button", { name: "Submit" }).click();
    await expect(one.getByRole("button", { name: "Pending for approval" })).toBeDisabled();
    // the other member's page learns it by polling and cannot submit again
    await expect(two.getByRole("button", { name: "Pending for approval" })).toBeDisabled({
      timeout: 20_000,
    });

    const t = await inspect(team);
    expect(t.questions[String(B1)]).toMatchObject({ state: "PENDING_APPROVAL", deadline: null });
    expect(t.questions[String(B1)]!.remaining).toBeGreaterThan(0);
    expect(t.submissions.filter((s) => s.qid === B1)).toHaveLength(1);

    const frozen = await questionTimer(one).innerText();
    await one.waitForTimeout(2500);
    expect(await questionTimer(one)).toHaveText(frozen);
    expect(await teamTimer(one).innerText()).not.toBe(teamBefore); // the team timer never stopped

    // a second submission while one is pending is refused
    const refused = await player(api2).submit(B1, "another answer");
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("SUBMISSION_PENDING");

    // a retried submit (same Idempotency-Key) is a replay, never a second submission
    const key = randomUUID();
    const first = await player(api1).submit(C1, "c answer", key);
    const replay = await player(api1).submit(C1, "c answer", key);
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect((await inspect(team)).submissions.filter((s) => s.qid === C1)).toHaveLength(1);
  });

  test("a controlled approval rewards exactly once and activates the next question with its own deadline", async () => {
    const before = await inspect(team);
    const submission = before.submissions.find((s) => s.qid === B1)!;
    expect(before.questions[String(B2)]).toMatchObject({ state: "LOCKED" });
    const admin = await adminReviewer();
    try {
      const key = randomUUID();
      const approved = await admin.review.approve(submission.id, key);
      expect(approved.body.data).toMatchObject({
        reward_awarded: REWARD,
        next_question_activated: true,
      });
      expect(approved.replayed).toBe(false);
      // the same request again, and a different request for the same submission: no second reward
      expect((await admin.review.approve(submission.id, key)).replayed).toBe(true);
      const other = await admin.review.approve(submission.id);
      expect(other.status).toBe(409);
      expect(other.body.error.code).toBe("SUBMISSION_NOT_PENDING");
    } finally {
      await admin.api.dispose();
    }
    const after = await inspect(team);
    expect(after.coins).toBe(before.coins + REWARD);
    expect(after.questions[String(B1)]!.state).toBe("APPROVED");
    expect(after.questions[String(B2)]!.state).toBe("ACTIVE");
    expect(after.questions[String(B2)]!.deadline).not.toBeNull();
    expect(after.submissions.find((s) => s.id === submission.id)).toMatchObject({
      status: "APPROVED",
      reward: REWARD,
    });

    // both members' pages show it after their next poll, and Q2 is playable
    for (const page of [one, two]) {
      await expect(page.getByRole("button", { name: "Approved" })).toBeDisabled({
        timeout: 20_000,
      });
      await expect(page.getByRole("group", { name: "Coins left" })).toContainText(
        String(after.coins),
      );
    }
    await one.getByRole("link", { name: "Next question" }).click();
    await one.waitForURL("**/theme/B/2");
    await expect(one.locator(".q-text")).toContainText("Body of question B2", LOAD);
    await expect(questionTimer(one)).toHaveText(/0[34]:\d\d/);
    await expect(one.getByRole("textbox")).toBeEditable();
  });

  test("the client cannot override the server", async () => {
    const before = await inspect(team);
    // forged fields are rejected, not trusted
    const forged = await api1.post(`/api/p/themes/${THEME_D}/unlock`, {
      headers: { "Idempotency-Key": randomUUID() },
      data: { coins: 99_999, team_id: randomUUID(), cost: 0 },
    });
    expect(forged.status()).toBe(400);
    const forgedSubmit = await api1.post(`/api/p/questions/${B2}/submit`, {
      headers: { "Idempotency-Key": randomUUID() },
      data: { answer: "42", state: "APPROVED", reward: 9999, teamId: randomUUID() },
    });
    expect(forgedSubmit.status()).toBe(400);

    // a locked theme's question is refused and carries no body
    const locked = await player(api1).question(D1);
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe("THEME_LOCKED");
    expect(JSON.stringify(locked.body)).not.toContain("Body of question");

    // browser storage is not an authority: doctored values change nothing on screen
    await one.goto("/participant");
    await one.evaluate(() => {
      for (const key of ["coins", "state", "timer", "questions"])
        localStorage.setItem(key, "99999");
      sessionStorage.setItem("coins", "99999");
    });
    await one.reload();
    await expect(coinsOf(one)).toHaveText(String(before.coins));

    // a member can only ever see their own team
    const stranger = await createPlayerTeam();
    const sctx = await api(
      await signInMember(await one.context().browser()!.newContext(), stranger, 1),
    );
    try {
      const view = await player(sctx).state();
      expect(view.body.data.me.team_code).toBe(stranger.code);
      expect(view.body.data.themes.every((th: { status: string }) => th.status === "LOCKED")).toBe(
        true,
      );
      expect((await player(sctx).question(B1)).body.error.code).toBe("THEME_LOCKED");
      expect((await inspect(team)).coins).toBe(before.coins);
    } finally {
      await sctx.dispose();
    }

    // the reference answer exists in the backend and never reached either browser or any page
    expect(seen.length).toBeGreaterThan(10);
    expect(seen.join("\n")).not.toContain(SECRET_PREFIX);
    for (const page of [one, two]) expect(await page.content()).not.toContain(SECRET_PREFIX);
  });

  test("refreshing and reconnecting create no duplicate state", async () => {
    await two.goto("/participant");
    await two.reload();
    await two.reload();
    await ctx2.setOffline(true);
    await expect(two.getByText(/Reconnecting/)).toBeVisible({ timeout: 20_000 });
    await ctx2.setOffline(false);
    await expect(two.getByText(/Reconnecting/)).toBeHidden({ timeout: 20_000 });

    const t = await inspect(team);
    expect(t.audit.filter((e) => e === "TEAM_STARTED")).toHaveLength(1);
    expect(t.audit.filter((e) => e === "THEME_UNLOCKED")).toHaveLength(2);
    expect(t.audit.filter((e) => e === "QUESTION_STARTED")).toHaveLength(2);
    expect(t.audit.filter((e) => e === "ANSWER_SUBMITTED")).toHaveLength(2);
    expect(t.audit.filter((e) => e === "SUBMISSION_APPROVED")).toHaveLength(1);
    expect(t.themes).toHaveLength(2);
    expect(t.coins).toBe(500 - 2 * UNLOCK_COST + REWARD);
    await control("inspect", { loginId: team.loginId }); // the control stays read-only
  });
});
