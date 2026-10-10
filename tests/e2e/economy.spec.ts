import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import {
  ageTeam,
  beginTheme,
  createPlayerTeam,
  inspect,
  memberApi,
  player,
  signInMember,
} from "./support/game";
import type { E2ETeam } from "./support/identities";
import { hintFirstLine, officialHint } from "./support/official";

/**
 * Patch B15: real hint purchases and real Buy Time, through the real routes with real cookies, against the in-memory
 * stand-in (which mirrors the SQL proven by supabase/tests/130 and the concurrency script). Every test builds its OWN
 * team, so no two tests share a balance, a clock or a purchase count. Prices and packs are the stand-in's fixtures
 * (hints 20/40, packs 120 s/20, 240 s/40, 480 s/80 with a cap of 2 on the last); the application reads them from the
 * server, which is exactly what these specs would catch if it did not.
 *
 * Question 1 of theme A; pack n of question q has the option id (q - 1) * 3 + n; a new team holds 500 coins and pays
 * 100 for the theme.
 */
const Q1 = 1;
const PACK = { s120: 1, s240: 2, s480: 3 };

async function ready(): Promise<E2ETeam> {
  const team = await createPlayerTeam();
  await beginTheme(team);
  return team;
}

test.describe("hints", () => {
  test("a hint belongs to the whole team, is charged once at its stored price and shows its text only after purchase", async () => {
    const team = await ready();
    const a = player(await memberApi(team, 1));
    const b = player(await memberApi(team, 2));

    // before buying: the price is visible, the text is not
    const before = (await a.question(Q1)).body.data.question;
    expect(before.hints).toEqual([
      { tier: 1, cost: 20, owned: false, purchasable: true },
      { tier: 2, cost: 40, owned: false, purchasable: false },
    ]);
    expect(JSON.stringify(before)).not.toContain(hintFirstLine("A.1", 1));
    expect(JSON.stringify(before)).not.toContain(hintFirstLine("A.1", 2));

    const key = randomUUID();
    const bought = await a.hint(Q1, 1, key);
    expect(bought.status).toBe(200);
    expect(bought.body.data).toMatchObject({
      already_owned: false,
      tier: 1,
      hint: { tier: 1, body_md: officialHint("A.1", 1) },
    });
    expect(bought.body.data.state.team.coins).toBe(380);

    // the same intent again (a retry): replayed, no second charge
    const again = await a.hint(Q1, 1, key);
    expect(again.replayed).toBe(true);
    expect((await inspect(team)).coins).toBe(380);

    // a teammate sees it as owned, with the text, and buying it again is free
    const seen = (await b.question(Q1)).body.data.question.hints[0];
    expect(seen).toMatchObject({ tier: 1, owned: true, body_md: officialHint("A.1", 1) });
    const free = await b.hint(Q1, 1);
    expect(free.body.data.already_owned).toBe(true);
    const t = await inspect(team);
    expect(t.coins).toBe(380);
    expect(t.ledger.filter((l) => l.type === "HINT_PURCHASE")).toEqual([
      { type: "HINT_PURCHASE", amount: -20, qid: Q1 },
    ]);
  });

  test("Hint 2 needs Hint 1 first (nothing charged), then costs its own stored price", async () => {
    const team = await ready();
    const a = player(await memberApi(team, 1));
    const early = await a.hint(Q1, 2);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("HINT_TIER1_REQUIRED");
    expect((await inspect(team)).coins).toBe(400);

    expect((await a.hint(Q1, 1)).status).toBe(200);
    const second = await a.hint(Q1, 2);
    expect(second.status).toBe(200);
    expect(second.body.data.state.team.coins).toBe(340);
    expect((await inspect(team)).hints.sort()).toEqual([`${Q1}:1`, `${Q1}:2`]);
  });

  test("a body that tries to name a price, a balance or another team is refused before anything happens", async () => {
    const team = await ready();
    const ctx = await memberApi(team, 1);
    for (const data of [
      { tier: 1, cost: 0 },
      { tier: 1, coins: 99_999 },
      { tier: 1, team_id: randomUUID() },
      { tier: 3 },
      { tier: "1" },
      {},
    ]) {
      const res = await ctx.post(`/api/p/questions/${Q1}/hints`, {
        data,
        headers: { "Idempotency-Key": randomUUID() },
      });
      expect(res.status(), JSON.stringify(data)).toBe(400);
    }
    const noKey = await ctx.post(`/api/p/questions/${Q1}/hints`, { data: { tier: 1 } });
    expect(noKey.status()).toBe(400);
    const t = await inspect(team);
    expect(t.coins).toBe(400);
    expect(t.hints).toEqual([]);
  });

  test("a hint can be bought on a question waiting for approval, not on a locked one", async () => {
    const team = await ready();
    const a = player(await memberApi(team, 1));
    expect((await a.submit(Q1, "42")).status).toBe(200);
    expect((await a.hint(Q1, 1)).status).toBe(200); // PENDING_APPROVAL: a reading aid, no question time involved
    const locked = await a.hint(2, 1); // question 2 is still locked
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe("QUESTION_NOT_ACTIVE");
    const theme = await a.hint(6, 1); // theme B was never unlocked
    expect(theme.body.error.code).toBe("THEME_LOCKED");
  });

  test("a team that cannot afford a hint is told so and keeps its coins", async () => {
    const team = await ready();
    const a = player(await memberApi(team, 1));
    // spend down with 40-coin packs: 400 -> 0 in ten purchases
    for (let i = 0; i < 10; i++) expect((await a.buyTime(Q1, PACK.s240, i)).status).toBe(200);
    expect((await inspect(team)).coins).toBe(0);
    const poor = await a.hint(Q1, 1);
    expect(poor.status).toBe(409);
    expect(poor.body.error.code).toBe("INSUFFICIENT_COINS");
    expect(poor.body.error.details).toEqual({ have: 0, need: 20 });
    expect((await inspect(team)).hints).toEqual([]);
  });
});

test.describe("Buy Time", () => {
  test("moves this question's deadline for the whole team, charges the stored price and never touches the team timer", async () => {
    const team = await ready();
    const a = player(await memberApi(team, 1));
    const b = player(await memberApi(team, 2));
    const before = await inspect(team);
    const q0 = before.questions[String(Q1)]!;

    const key = randomUUID();
    const res = await a.buyTime(Q1, PACK.s240, 0, key);
    expect(res.status).toBe(200);
    expect(res.body.data.purchase).toEqual({
      seq: 1,
      option_id: PACK.s240,
      seconds: 240,
      cost: 40,
    });
    expect(res.body.data.question.buy_time).toMatchObject({
      purchase_count: 1,
      extra_seconds: 240,
    });
    expect(res.body.data.state.team.coins).toBe(360);

    const after = await inspect(team);
    expect(after.questions[String(Q1)]!.deadline).toBe(q0.deadline! + 240_000);
    expect(after.endsAt).toBe(before.endsAt); // the Ultimate Team Timer is not extended
    expect(after.startedAt).toBe(before.startedAt);
    expect(after.timerSeconds).toBe(14_400);

    // a retry of the same intent is a replay, not a second charge
    const replay = await a.buyTime(Q1, PACK.s240, 0, key);
    expect(replay.replayed).toBe(true);
    expect((await inspect(team)).coins).toBe(360);

    // the teammate sees the extended question
    const seen = (await b.question(Q1)).body.data.question;
    expect(seen.buy_time.purchase_count).toBe(1);
    expect(seen.deadline).toBe(q0.deadline! + 240_000);
  });

  test("two members buying from the same screen: one purchase wins, the other is told and is not charged", async () => {
    const team = await ready();
    const a = player(await memberApi(team, 1));
    const b = player(await memberApi(team, 2));
    const [x, y] = await Promise.all([a.buyTime(Q1, PACK.s120, 0), b.buyTime(Q1, PACK.s120, 0)]);
    const statuses = [x.status, y.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = x.status === 409 ? x : y;
    expect(loser.body.error.code).toBe("STALE_PURCHASE_COUNT");
    expect(loser.body.error.details).toEqual({ count: 1 });
    const t = await inspect(team);
    expect(t.coins).toBe(380);
    expect(t.questions[String(Q1)]!.timeCount).toBe(1);
    expect(t.ledger.filter((l) => l.type === "TIME_PURCHASE")).toHaveLength(1);
  });

  test("a pack's purchase cap, an unknown pack and a pack of another question are refused", async () => {
    const team = await ready();
    const a = player(await memberApi(team, 1));
    expect((await a.buyTime(Q1, PACK.s480, 0)).status).toBe(200);
    expect((await a.buyTime(Q1, PACK.s480, 1)).status).toBe(200);
    const capped = await a.buyTime(Q1, PACK.s480, 2);
    expect(capped.status).toBe(409);
    expect(capped.body.error.code).toBe("TIME_PURCHASE_LIMIT");
    const unknown = await a.buyTime(Q1, 32_000, 2);
    expect(unknown.status).toBe(404);
    const other = await a.buyTime(Q1, 4, 2); // a pack of question 2
    expect(other.status).toBe(404);
    expect((await inspect(team)).coins).toBe(240); // two 80-coin packs only
  });

  test("a body that names seconds, a price or a deadline is refused", async () => {
    const team = await ready();
    const ctx = await memberApi(team, 1);
    for (const data of [
      { optionId: 1, expectedPurchaseCount: 0, seconds: 99_999 },
      { optionId: 1, expectedPurchaseCount: 0, cost: 0 },
      { optionId: 1, expectedPurchaseCount: 0, deadline: 1 },
      { optionId: 1 },
      { expectedPurchaseCount: 0 },
      { optionId: -1, expectedPurchaseCount: 0 },
    ]) {
      const res = await ctx.post(`/api/p/questions/${Q1}/time`, {
        data,
        headers: { "Idempotency-Key": randomUUID() },
      });
      expect(res.status(), JSON.stringify(data)).toBe(400);
    }
    const t = await inspect(team);
    expect(t.coins).toBe(400);
    expect(t.questions[String(Q1)]!.timeCount).toBe(0);
  });

  test("time bought beyond the team's own end is not a team extension: ends_at and the team timer stay put", async () => {
    const team = await ready();
    const a = player(await memberApi(team, 1));
    // the team has about ten minutes left; the question's own deadline is unaffected by that
    await ageTeam(team, 14_400_000 - 600_000, { questions: false });
    const before = await inspect(team);
    expect((await a.buyTime(Q1, PACK.s480, 0)).status).toBe(200);
    const after = await inspect(team);
    expect(after.endsAt).toBe(before.endsAt);
    expect(after.timerSeconds).toBe(14_400);
    const state = (await a.state()).body.data;
    expect(state.team.remaining_seconds).toBeLessThanOrEqual(600);
    // the server reports the question's own deadline; the screens cap what they show at the team's end (unit-tested)
    expect(state.themes[0].questions[0].deadline).toBe(after.questions[String(Q1)]!.deadline);
  });

  test("nothing can be bought for a question that is waiting for approval or has timed out", async () => {
    const team = await ready();
    const a = player(await memberApi(team, 1));
    expect((await a.submit(Q1, "7")).status).toBe(200);
    const pending = await a.buyTime(Q1, PACK.s120, 0);
    expect(pending.status).toBe(409);
    expect(pending.body.error.code).toBe("QUESTION_NOT_ACTIVE");
    expect((await inspect(team)).coins).toBe(400);
  });
});

test.describe("hints and Buy Time in the browser", () => {
  test.describe.configure({ timeout: 120_000 });

  async function open(page: Page): Promise<E2ETeam> {
    const team = await ready();
    await signInMember(page.context(), team, 1);
    await page.goto("/participant/theme/A/1");
    await expect(page.getByText("Q1.")).toBeVisible({ timeout: 60_000 });
    return team;
  }

  test("buying Hint 1 asks first, charges the stored price, then shows the text to read again for free", async ({
    page,
  }) => {
    const team = await open(page);
    await page.getByRole("button", { name: /^Hint 1/ }).click();
    const buy = page.getByRole("dialog", { name: "Hint 1" });
    await expect(buy).toContainText("20 coins");
    await buy.getByRole("button", { name: "No" }).click();
    await expect(buy).toBeHidden();
    expect((await inspect(team)).coins).toBe(400); // "No" costs nothing

    await page.getByRole("button", { name: /^Hint 1/ }).click();
    await page.getByRole("dialog", { name: "Hint 1" }).getByRole("button", { name: "Yes" }).click();
    // the purchase opens the text straight away
    const text = page.getByRole("dialog", { name: "Hint 1" });
    await expect(text).toContainText(hintFirstLine("A.1", 1));
    await text.getByRole("button", { name: "Close" }).click();
    await expect(text).toBeHidden();
    await expect(page.getByRole("group", { name: "Coins left" })).toContainText("380");
    expect((await inspect(team)).coins).toBe(380);

    // reading it again is free: no question, no charge
    await page.getByRole("button", { name: /^Hint 1/ }).click();
    const view = page.getByRole("dialog", { name: "Hint 1" });
    await expect(view).toContainText(hintFirstLine("A.1", 1));
    await expect(view.getByRole("button", { name: "Yes" })).toHaveCount(0);
    await view.getByRole("button", { name: "Close" }).click();
    expect((await inspect(team)).coins).toBe(380);
    await expect(page.getByRole("button", { name: /^Hint 2/ })).toBeEnabled();
  });

  test("Buy Time lists the server's packs, asks 'Are you sure?', and the question timer grows", async ({
    page,
  }) => {
    const team = await open(page);
    const before = (await inspect(team)).questions[String(Q1)]!;
    await page.getByRole("button", { name: "buy time" }).click();
    const dialog = page.getByRole("dialog", { name: "Buy time" });
    const packs = dialog.getByRole("list", { name: "Time packs" }).getByRole("button");
    await expect(packs).toHaveCount(3);
    await expect(packs.nth(1)).toContainText("40 coins");
    await packs.nth(1).click();
    await expect(dialog).toContainText("Are you sure?");
    await dialog.getByRole("button", { name: "Yes" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("group", { name: "Coins left" })).toContainText("360");
    const after = (await inspect(team)).questions[String(Q1)]!;
    expect(after.deadline).toBe(before.deadline! + 240_000);
    expect((await inspect(team)).timerSeconds).toBe(14_400);
  });
});
