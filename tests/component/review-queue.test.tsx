// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ReviewQueue } from "@/components/admin/review-queue";

const SUB = "2a8f4c1e-6b3d-4e7a-9c50-1d2e3f4a5b6c";
const row = (over: Record<string, unknown> = {}) => ({
  id: SUB,
  team_code: "T17",
  team_name: "Team Seventeen",
  theme_code: "A",
  ordinal: 1,
  question_id: 1,
  body_md: "Find x.",
  answer: "x = 4",
  explanation: "",
  submitted_by_slot: 2,
  submitted_at: 1_760_000_000_000,
  ...over,
});
const envelope = (data: unknown) => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: true, data, server_now: 1 }),
});

/** A fake server: the queue it returns, and what it answers to a review. */
function server(initial: unknown[], review: () => unknown) {
  let queue = initial;
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === "/api/admin/queue") return envelope({ server_now: 1, submissions: queue });
    const out = review();
    if ((out as { ok: boolean }).ok) queue = [];
    return out;
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe("ReviewQueue (thin B13 testing surface)", () => {
  it("lists the pending submissions and opens one to show the answer", async () => {
    const s = server([row()], () => envelope({}));
    render(<ReviewQueue fetchImpl={s.fetchImpl} intervalMs={60_000} />);
    expect(await screen.findByText(/Theme A · Q1/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByTestId("review-answer").textContent).toBe("x = 4");
    expect(screen.getByText("Find x.")).toBeTruthy();
  });

  it("says so when nothing is waiting", async () => {
    const s = server([], () => envelope({}));
    render(<ReviewQueue fetchImpl={s.fetchImpl} intervalMs={60_000} />);
    expect(await screen.findByText(/No submissions are waiting/)).toBeTruthy();
  });

  it("Approve calls the real approve endpoint with an Idempotency-Key, then re-reads the queue", async () => {
    const s = server([row()], () => envelope({ submission: { id: SUB, status: "APPROVED" } }));
    render(<ReviewQueue fetchImpl={s.fetchImpl} intervalMs={60_000} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByText(/No submissions are waiting/)).toBeTruthy());
    const post = s.calls.find((c) => c.url.endsWith("/approve"))!;
    expect(post.url).toBe(`/api/admin/submissions/${SUB}/approve`);
    expect(post.init?.method).toBe("POST");
    expect((post.init?.headers as Record<string, string>)["Idempotency-Key"]).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect(screen.getByText("Approved.")).toBeTruthy();
  });

  it("Disapprove sends the optional note to the real disapprove endpoint", async () => {
    const s = server([row()], () => envelope({ submission: { id: SUB, status: "REJECTED" } }));
    render(<ReviewQueue fetchImpl={s.fetchImpl} intervalMs={60_000} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    fireEvent.change(screen.getByLabelText(/Note for the team/), {
      target: { value: " Check the sign. " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Disapprove" }));
    await waitFor(() => expect(s.calls.some((c) => c.url.endsWith("/disapprove"))).toBe(true));
    const post = s.calls.find((c) => c.url.endsWith("/disapprove"))!;
    expect(JSON.parse(String(post.init?.body))).toEqual({ note: "Check the sign." });
  });
});
