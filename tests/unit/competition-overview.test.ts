import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/lib/auth/routes", () => ({ authDeps: { db: () => ({ rpc }) } }));

import { loadCompetitionOverview } from "@/lib/runtime/server-data";

beforeEach(() => rpc.mockReset());

const STAFF = "00000000-0000-4000-8000-0000000000a1";

describe("loadCompetitionOverview (first paint of the Super Admin's lifecycle control)", () => {
  it.each(["SETUP", "RUNNING", "PAUSED", "ENDED"] as const)(
    "reads %s and the team count for the SESSION's staff id",
    async (status) => {
      rpc.mockResolvedValueOnce({
        content: { themes: "irrelevant here", rules: null },
        token: "x",
        readiness: { competition_status: status, teams: 4, admins: 1, anything: "else" },
      });
      await expect(loadCompetitionOverview(STAFF)).resolves.toEqual({ status, teams: 4 });
      expect(rpc).toHaveBeenCalledWith("get_renewal_content", { p_staff_id: STAFF });
    },
  );

  it("does not depend on the rest of the renewal content being well-formed", async () => {
    rpc.mockResolvedValueOnce({ readiness: { competition_status: "SETUP", teams: 0 } });
    await expect(loadCompetitionOverview(STAFF)).resolves.toEqual({ status: "SETUP", teams: 0 });
  });

  it.each([
    ["a status it does not know", { readiness: { competition_status: "OPEN", teams: 1 } }],
    ["no readiness block", { content: {} }],
    ["a negative team count", { readiness: { competition_status: "SETUP", teams: -1 } }],
    ["not an object", "SETUP"],
  ])("returns null (never a guess) for %s", async (_n, payload) => {
    rpc.mockResolvedValueOnce(payload);
    await expect(loadCompetitionOverview(STAFF)).resolves.toBeNull();
  });

  it("returns null when the database call fails (e.g. FORBIDDEN or unavailable)", async () => {
    rpc.mockRejectedValueOnce(new Error("boom"));
    await expect(loadCompetitionOverview(STAFF)).resolves.toBeNull();
  });
});
