import { afterEach, describe, expect, it, vi } from "vitest";

import { buyHintCall, buyTimeCall, finalSubmitCall } from "@/lib/economy/client";
import { question, snapshot } from "../component/support/game";

const KEY = "5d6f1c1a-3b8e-4f0a-9c21-7e4d2a9b8c10";
const ok = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, data, server_now: 123 }), { status: 200 });
const fail = (code: string, status: number, details?: unknown) =>
  new Response(
    JSON.stringify({ ok: false, error: { code, message: "m", details }, server_now: 1 }),
    { status },
  );

function stub(res: Response | Error) {
  const f = vi.fn(async () => {
    if (res instanceof Error) throw res;
    return res;
  });
  vi.stubGlobal("fetch", f);
  return f;
}
afterEach(() => vi.unstubAllGlobals());

const hintBody = {
  replayed: false,
  already_owned: false,
  tier: 1,
  hint: { tier: 1, body_md: "Think small." },
  question: question(),
  state: snapshot(),
};

describe("economy client", () => {
  it("buyHintCall sends only the tier and the idempotency key, and no browser storage is involved", async () => {
    const f = stub(ok(hintBody));
    const r = await buyHintCall(7, 1, KEY);
    expect(r.ok).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/p/questions/7/hints");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.headers).toMatchObject({ "Idempotency-Key": KEY });
    expect(JSON.parse(init.body as string)).toEqual({ tier: 1 });
    if (r.ok) expect(r.data.hint.body_md).toBe("Think small.");
  });

  it("buyTimeCall sends the pack id and the expected purchase count, nothing priced", async () => {
    const f = stub(
      ok({
        replayed: false,
        purchase: { seq: 1, option_id: 2, seconds: 240, cost: 40 },
        question: question(),
        state: snapshot(),
      }),
    );
    const r = await buyTimeCall(7, 2, 0, KEY);
    expect(r.ok).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/p/questions/7/time");
    expect(JSON.parse(init.body as string)).toEqual({ optionId: 2, expectedPurchaseCount: 0 });
  });

  it("finalSubmitCall confirms explicitly and returns the snapshot", async () => {
    const f = stub(ok(snapshot({ team: { status: "FINAL_SUBMITTED" } })));
    const r = await finalSubmitCall(KEY);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/p/final-submit");
    expect(JSON.parse(init.body as string)).toEqual({ confirm: true });
    expect(r.ok).toBe(true);
  });

  it("returns a typed failure for refusals, with details for a stale count", async () => {
    stub(fail("STALE_PURCHASE_COUNT", 409, { expected: 0, actual: 1 }));
    const r = await buyTimeCall(7, 2, 0, KEY);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("STALE_PURCHASE_COUNT");
      expect(r.status).toBe(409);
      expect(r.details).toEqual({ expected: 0, actual: 1 });
    }
  });

  it("reports a network failure and a malformed success body as NETWORK_ERROR / BAD_RESPONSE, never throwing", async () => {
    stub(new Error("offline"));
    const a = await buyHintCall(7, 1, KEY);
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.code).toBe("NETWORK_ERROR");
    stub(ok({ nonsense: true }));
    const b = await finalSubmitCall(KEY);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.code).toBe("BAD_RESPONSE");
  });
});
