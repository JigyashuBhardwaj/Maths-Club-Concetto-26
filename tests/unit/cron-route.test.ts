import { describe, expect, it, vi } from "vitest";

import { createExpireTeamsHandler, methodNotAllowed, SWEEP_LIMIT } from "@/lib/cron/handlers";
import { cronEnvSchema, parseCronSecret } from "@/lib/env/cron";
import type { Db } from "@/lib/db/adapter";

const SECRET = "s".repeat(32) + "-cron-secret";
const NOW = 1_760_000_000_000;

function make(result: unknown, secret: string | undefined = SECRET) {
  const rpc = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  const db: Db = { rpc };
  const handler = createExpireTeamsHandler({ db: () => db, secret: () => secret, now: () => NOW });
  return { rpc, handler };
}
const req = (auth?: string) =>
  new Request("https://concetto.example/api/cron/expire-teams", {
    headers: auth === undefined ? {} : { authorization: auth },
  });

describe("GET /api/cron/expire-teams", () => {
  it("rejects a missing, malformed or wrong secret with 401 before any database call", async () => {
    const { rpc, handler } = make(3);
    for (const auth of [
      undefined,
      "",
      SECRET,
      `Basic ${SECRET}`,
      `Bearer`,
      `Bearer ${SECRET}x`,
      `Bearer ${SECRET.slice(0, -1)}`,
      `Bearer ${"a".repeat(SECRET.length)}`,
      `bearer ${SECRET}`,
    ]) {
      const res = await handler(req(auth));
      expect(res.status, String(auth)).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
      expect(JSON.stringify(await res.json())).not.toContain(SECRET);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails closed when no secret is configured", async () => {
    const { rpc, handler } = make(3, undefined);
    expect((await handler(req("Bearer undefined"))).status).toBe(401);
    expect((await handler(req("Bearer "))).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("runs one bounded sweep with a fixed argument and returns only the count", async () => {
    const { rpc, handler } = make(2);
    const res = await handler(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("expire_due_teams", { p_limit: SWEEP_LIMIT });
    expect(await res.json()).toMatchObject({ ok: true, data: { finalized: 2 } });
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("returns 503 without detail when the database fails or answers nonsense", async () => {
    for (const bad of [new Error("connection refused: db.internal:5432"), "many", -1, 1.5, null]) {
      const { handler } = make(bad);
      const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const res = await handler(req(`Bearer ${SECRET}`));
      quiet.mockRestore();
      expect(res.status).toBe(503);
      const text = JSON.stringify(await res.json());
      expect(text).not.toContain("db.internal");
      expect(text).not.toContain(SECRET);
    }
  });

  it("every other method is 405 with Allow: GET and no body", async () => {
    const res = methodNotAllowed();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
    expect(await res.text()).toBe("");
  });
});

describe("CRON_SECRET environment", () => {
  it("accepts only a secret of at least 32 characters and never throws", () => {
    expect(parseCronSecret({ CRON_SECRET: SECRET })).toBe(SECRET);
    expect(parseCronSecret({})).toBeUndefined();
    expect(parseCronSecret({ CRON_SECRET: "" })).toBeUndefined();
    expect(parseCronSecret({ CRON_SECRET: "short" })).toBeUndefined();
    expect(cronEnvSchema.safeParse({ CRON_SECRET: "x".repeat(31) }).success).toBe(false);
    expect(cronEnvSchema.safeParse({ CRON_SECRET: "x".repeat(32) }).success).toBe(true);
  });
});

describe("deployment wiring", () => {
  it("vercel.json registers exactly the sweep route, once a day (the Hobby-plan limit)", async () => {
    const { readFileSync } = await import("node:fs");
    const cfg = JSON.parse(readFileSync("vercel.json", "utf8")) as {
      crons: { path: string; schedule: string }[];
    };
    expect(cfg.crons).toHaveLength(1);
    expect(cfg.crons[0]!.path).toBe("/api/cron/expire-teams");
    // five fields, a fixed minute and hour, every day: not more often than daily
    expect(cfg.crons[0]!.schedule).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
  });

  it(".env.example names CRON_SECRET and gives it no value", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(".env.example", "utf8")).toMatch(/^CRON_SECRET=$/m);
  });
});
