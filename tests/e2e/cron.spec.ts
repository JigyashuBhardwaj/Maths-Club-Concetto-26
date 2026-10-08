import { expect, test } from "@playwright/test";

import { ageTeam, beginTheme, createPlayerTeam, inspect } from "./support/game";

/**
 * Patch B15: the scheduled safety net, GET /api/cron/expire-teams. It persists ENDED for a team that nobody reads
 * again. Authentication is a bearer secret only (the run's random CRON_SECRET), and nothing else about the request
 * matters: no cookie, no Origin, no body.
 *
 * The sweep finalizes EVERY due team of the shared stand-in, so these tests run in their own Playwright project
 * ("sweep"), after the desktop and mobile projects have finished: no other spec can have a team that is due, or be
 * surprised by one.
 */
const url = () => `http://localhost:${process.env.PORT ?? 3100}/api/cron/expire-teams`;
const secret = () => process.env.E2E_CRON_SECRET!;

test.describe("expire-teams sweep", () => {
  test("rejects a missing or wrong secret and every method but GET, changing nothing", async () => {
    const team = await createPlayerTeam();
    await beginTheme(team);
    await ageTeam(team, 14_400_000 + 1_000);

    for (const headers of [
      {} as Record<string, string>,
      { authorization: "Bearer wrong" },
      { authorization: `Bearer ${secret()}x` },
      { authorization: secret() },
      { authorization: `Basic ${secret()}` },
    ]) {
      const res = await fetch(url(), { headers });
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(await res.text()).not.toContain(secret());
    }
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await fetch(url(), {
        method,
        headers: { authorization: `Bearer ${secret()}` },
      });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
    }
    expect((await inspect(team)).status).toBe("RUNNING"); // the sweep never ran
  });

  test("with the secret it finalizes every due team once and leaves running teams alone", async () => {
    const due = await createPlayerTeam();
    const live = await createPlayerTeam();
    await beginTheme(due);
    await beginTheme(live);
    await ageTeam(due, 14_400_000 + 2_000);
    await ageTeam(live, 60_000);

    const res = await fetch(url(), { headers: { authorization: `Bearer ${secret()}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.finalized).toBeGreaterThanOrEqual(1);
    expect(Object.keys(body.data)).toEqual(["finalized"]); // a count, nothing else

    const t = await inspect(due);
    expect(t.status).toBe("ENDED");
    expect(t.endedAt).toBe(t.endsAt);
    expect(t.questions["1"]!.state).toBe("TIMED_OUT");
    expect((await inspect(live)).status).toBe("RUNNING");

    // a second sweep finds nothing more to do for this team
    await fetch(url(), { headers: { authorization: `Bearer ${secret()}` } });
    expect((await inspect(due)).audit.filter((e) => e === "TEAM_ENDED")).toHaveLength(1);
  });
});
