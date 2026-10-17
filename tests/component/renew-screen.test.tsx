// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RenewScreen } from "@/components/renewal/renew-screen";
import type { RenewalRead } from "@/lib/contracts/renewal";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const fetchMock = vi.fn();
// Opening the "Apply Changes" dialog re-reads the server (GET) so the number of discarded submissions it shows is current. A test arms
// that one read with armCheck(); every other request goes to fetchMock exactly as before.
let armed: (() => Promise<Response>) | null = null;
let checkCalls = 0;
beforeEach(() => {
  fetchMock.mockReset();
  push.mockReset();
  armed = null;
  checkCalls = 0;
});
const f = ((url: string, init?: RequestInit) => {
  const isGet = !init?.method || init.method === "GET";
  if (armed && isGet) {
    const respond = armed;
    armed = null;
    checkCalls += 1;
    return respond();
  }
  return fetchMock(url, init);
}) as unknown as typeof fetch;

const ok = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ ok: true, data, server_now: 1 }), { status: 200 }));
const err = (status: number, code: string, details?: unknown) =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        ok: false,
        error: { code, message: "SERVER TEXT", details },
        server_now: 1,
      }),
      { status },
    ),
  );

const TOKEN = "a".repeat(64);
const TOKEN2 = "b".repeat(64);
const readiness = (over: Record<string, unknown> = {}) => ({
  ready: true,
  blocked_count: 0,
  blockers: [],
  admins: 2,
  teams: 3,
  pending_submissions: 0,
  competition_status: "RUNNING",
  ...over,
});
function snapshot(token = TOKEN, over: Partial<RenewalRead> = {}): RenewalRead {
  return {
    content: {
      themes: [..."ABCDEFGHIJ"].map((code) => ({
        id: code,
        name: `Theme ${code}`,
        description: `Description of ${code}`,
        questions: [1, 2, 3, 4, 5].map((n) => ({
          id: `${code}.${n}`,
          question: `Question ${code}.${n}?\nSecond line.`,
          hint1: `Hint 1 of ${code}.${n}`,
          hint2: `Hint 2 of ${code}.${n}`,
          reward: 10 * n,
        })),
      })),
      rules: ["Rule one.", "Rule two.", "Rule three."],
    },
    token,
    readiness: readiness() as RenewalRead["readiness"],
    ...over,
  };
}
const result = (over: Record<string, unknown> = {}) => ({
  deleted: { admins: 2, teams: 3 },
  discarded: { pending_submissions: 0 },
  changed: { themes: 1, questions: 0, hints: 0 },
  competition: { from: "RUNNING", to: "SETUP" },
  token: TOKEN2,
  ...over,
});

const armCheck = (over: Partial<RenewalRead> = {}, token = TOKEN) => {
  armed = () => ok(snapshot(token, over));
};

const mount = (initial: RenewalRead | null = snapshot()) =>
  render(<RenewScreen initial={initial} fetchImpl={f} />);
// By aria-label: the editor has ~230 fields, and role queries over that many nodes are slow.
const box = (name: string) => {
  const el = document.querySelector(`[aria-label="${name}"]`);
  if (!el) throw new Error(`no field named "${name}"`);
  return el as HTMLTextAreaElement;
};
const fields = () => document.querySelectorAll("textarea, input[type='text']");
const type = (name: string, value: string) => fireEvent.change(box(name), { target: { value } });
const applyBtn = () => screen.getByRole("button", { name: "APPLY CHANGES" });
const resetBtn = () => screen.getByRole("button", { name: "RESET" });
// A closed <dialog> is hidden, so its accessible name is not computed: find it by its heading.
const dlg = (name: string) => {
  const d = screen
    .getAllByRole("dialog", { hidden: true })
    .find((x) => x.querySelector("h2")?.textContent === name);
  if (!d) throw new Error(`no dialog "${name}"`);
  return d;
};
const isOpen = (name: string) => dlg(name).hasAttribute("open");
const yesBtn = () =>
  within(dlg("Apply Changes")).getByRole("button", { name: "YES, APPLY CHANGES" });
/** Clicks APPLY CHANGES (the dialog re-reads the server first) and waits until YES, APPLY CHANGES is usable. */
const openApplyDialog = async (over: Partial<RenewalRead> = {}) => {
  armCheck(over);
  fireEvent.click(applyBtn());
  await waitFor(() => expect(yesBtn()).toBeEnabled());
  return yesBtn();
};
const bodyOf = (i: number) => JSON.parse(String((fetchMock.mock.calls[i]![1] as RequestInit).body));
const headerOf = (i: number, h: string) =>
  ((fetchMock.mock.calls[i]![1] as RequestInit).headers as Record<string, string>)[h];

describe("<RenewScreen /> layout and content", () => {
  it("has a Go back link at the top, the title, every theme, question, hint, reward and rule, and the two buttons", () => {
    mount();
    expect(screen.getByRole("link", { name: /Go back/ })).toHaveAttribute("href", "/superadmin");
    expect(
      screen.getByRole("heading", { level: 1, name: "Renew the Competition" }),
    ).toBeInTheDocument();
    for (const code of "ABCDEFGHIJ") {
      expect(box(`Theme ${code} name`).value).toBe(`Theme ${code}`);
      expect(box(`Theme ${code} description`).value).toBe(`Description of ${code}`);
      for (const n of [1, 2, 3, 4, 5]) {
        expect(box(`Question ${code}.${n}`).value).toBe(`Question ${code}.${n}?\nSecond line.`);
        expect(box(`Hint 1 of ${code}.${n}`).value).toBe(`Hint 1 of ${code}.${n}`);
        expect(box(`Hint 2 of ${code}.${n}`).value).toBe(`Hint 2 of ${code}.${n}`);
        expect(box(`Reward of ${code}.${n}`).value).toBe(String(10 * n));
      }
    }
    // 10 themes × (2 + 5 questions × 4) + 3 rules, in the fixed structure
    expect(fields()).toHaveLength(10 * (2 + 5 * 4) + 3);
    expect(box("Rule 1").value).toBe("Rule one.");
    expect(box("Rule 3").value).toBe("Rule three.");
    expect(screen.getByRole("heading", { name: "Rules and regulations" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add\+/ })).toBeInTheDocument();
    expect(applyBtn()).toBeEnabled();
    expect(resetBtn()).toBeDisabled(); // nothing to restore yet
    expect(fetchMock).not.toHaveBeenCalled();
  }, 15000);

  it("the badges and labels are plain text, only the values are editable fields", () => {
    mount();
    for (const label of [
      "Theme name",
      "Theme description",
      "Question",
      "Hint 1",
      "Hint 2",
      "Reward",
    ]) {
      expect(screen.getAllByText(label, { selector: "label" }).length).toBeGreaterThan(0);
    }
    expect(screen.getByText("A.1")).toBeInTheDocument();
    expect(screen.getByText("J.5")).toBeInTheDocument();
    expect(box("Theme A name").className).toMatch(/border-dashed/); // visibly an input, unlike its label
  });

  it("shows the readiness: how many admins and teams go, and which teams still block", () => {
    mount(
      snapshot(TOKEN, {
        readiness: readiness({
          ready: false,
          blocked_count: 2,
          blockers: [
            { team_code: "T1", name: "One", reason: "ACTIVE_QUESTION" },
            { team_code: "T2", name: "Two", reason: "TEAM_TIMER_RUNNING" },
          ],
        }) as RenewalRead["readiness"],
      }),
    );
    const s = screen.getByTestId("renew-readiness");
    expect(s).toHaveTextContent("Not ready: 2 teams are still playing");
    expect(s).toHaveTextContent("2 admins and 3 teams");
    expect(s).toHaveTextContent("T1 · One is solving a question right now");
    expect(s).toHaveTextContent("T2 · Two still has its competition timer running");
  });

  it("tells how many submissions still awaiting approval are discarded with the teams", () => {
    mount(
      snapshot(TOKEN, {
        readiness: readiness({ pending_submissions: 2 }) as RenewalRead["readiness"],
      }),
    );
    expect(screen.getByTestId("renew-readiness")).toHaveTextContent(
      "2 submissions still awaiting approval will be discarded",
    );
  });

  it("shows an error state with a retry when the content could not be loaded, never an empty editor", async () => {
    fetchMock.mockImplementationOnce(() => ok(snapshot()));
    mount(null);
    expect(screen.getByTestId("renew-load-error")).toHaveTextContent("could not be loaded");
    expect(screen.queryByRole("button", { name: "APPLY CHANGES" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(box("Theme A name").value).toBe("Theme A"));
  });
});

describe("editing and RESET", () => {
  it("edits every kind of field, keeping multiline text and punctuation exactly", () => {
    mount();
    const text = "Line 1\n\n  Line “2”, (x)! — ½ ≤ π 日本語 😀";
    type("Theme C name", "New name");
    type("Theme C description", text);
    type("Question C.2", text);
    type("Hint 1 of C.2", text);
    type("Hint 2 of C.2", "  padded  ");
    type("Reward of C.2", "250");
    type("Rule 2", text);
    expect(box("Theme C name").value).toBe("New name");
    expect(box("Theme C description").value).toBe(text);
    expect(box("Question C.2").value).toBe(text);
    expect(box("Hint 1 of C.2").value).toBe(text);
    expect(box("Hint 2 of C.2").value).toBe("  padded  ");
    expect(box("Reward of C.2").value).toBe("250");
    expect(box("Rule 2").value).toBe(text);
    expect(screen.getByTestId("renew-dirty")).toBeInTheDocument();
    expect(resetBtn()).toBeEnabled();
  });

  it("RESET restores everything that was loaded (text, rewards, added and removed rules) and sends nothing", () => {
    mount();
    type("Theme A name", "x");
    type("Question J.5", "y");
    type("Reward of B.3", "7");
    type("Rule 1", "z");
    fireEvent.click(screen.getByRole("button", { name: /Add\+/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove rule 2" }));
    expect(fields()).toHaveLength(10 * 22 + 3); // one added, one removed

    fireEvent.click(resetBtn());
    expect(box("Theme A name").value).toBe("Theme A");
    expect(box("Question J.5").value).toBe("Question J.5?\nSecond line.");
    expect(box("Reward of B.3").value).toBe("30");
    expect([1, 2, 3].map((n) => box(`Rule ${n}`).value)).toEqual([
      "Rule one.",
      "Rule two.",
      "Rule three.",
    ]);
    expect(fields()).toHaveLength(10 * 22 + 3);
    expect(screen.queryByTestId("renew-dirty")).toBeNull();
    expect(resetBtn()).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rules can be added and removed; the last one cannot be removed; there are at most 50", () => {
    mount(snapshot(TOKEN, { content: { ...snapshot().content, rules: ["only"] } }));
    expect(screen.getByRole("button", { name: "Remove rule 1" })).toBeDisabled();
    const add = screen.getByRole("button", { name: /Add\+/ });
    for (let i = 0; i < 49; i += 1) fireEvent.click(add);
    expect(box("Rule 50")).toBeInTheDocument();
    expect(add).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove rule 25" }));
    expect(add).toBeEnabled();
    expect(document.querySelector('[aria-label="Rule 50"]')).toBeNull();
  }, 15000);
});

describe("APPLY CHANGES: validation, the dialog, GO BACK", () => {
  it("does not open the dialog for incomplete content: it marks the fields and sends nothing", () => {
    mount();
    type("Theme A name", "   ");
    type("Reward of D.2", "0");
    type("Reward of D.3", "2.5");
    type("Hint 2 of J.5", "");
    type("Rule 3", "");
    fireEvent.click(applyBtn());
    expect(isOpen("Apply Changes")).toBe(false);
    expect(screen.getByTestId("renew-error")).toHaveTextContent("Fix 5 fields before applying");
    for (const name of [
      "Theme A name",
      "Reward of D.2",
      "Reward of D.3",
      "Hint 2 of J.5",
      "Rule 3",
    ]) {
      expect(box(name)).toHaveAttribute("aria-invalid", "true");
    }
    expect(box("Theme B name")).not.toHaveAttribute("aria-invalid");
    expect(document.activeElement).toBe(box("Theme A name")); // the first problem is focused
    expect(fetchMock).not.toHaveBeenCalled();
    // fixing one clears its mark
    type("Theme A name", "Fixed");
    expect(box("Theme A name")).not.toHaveAttribute("aria-invalid");
  });

  it("opens 'Apply Changes' with the exact message and buttons; GO BACK closes it, keeps every edit and sends nothing", async () => {
    mount();
    type("Theme B name", "Edited B");
    type("Rule 1", "Edited rule");
    await openApplyDialog();
    expect(isOpen("Apply Changes")).toBe(true);
    const d = dlg("Apply Changes");
    expect(within(d).getByRole("heading", { name: "Apply Changes" })).toBeInTheDocument();
    expect(d).toHaveTextContent(
      "Are you sure you want to apply the changes? Doing so will delete all admins created by the Superadmin and, consequently, all teams created by those admins. The edited competition content will also be applied.",
    );
    expect(within(d).getByRole("button", { name: "YES, APPLY CHANGES" })).toBeEnabled();
    fireEvent.click(within(d).getByRole("button", { name: "GO BACK" }));
    expect(isOpen("Apply Changes")).toBe(false);
    expect(box("Theme B name").value).toBe("Edited B");
    expect(box("Rule 1").value).toBe("Edited rule");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the Apply Changes dialog states how many pending submissions are discarded", () => {
  const warning = () => within(dlg("Apply Changes")).getByTestId("renew-pending-warning");
  const withPending = (n: number) =>
    ({ readiness: readiness({ pending_submissions: n }) }) as Partial<RenewalRead>;

  it("re-reads the server when it opens and shows the CURRENT number, explicitly, as a warning", async () => {
    mount(snapshot(TOKEN, withPending(0))); // the page was loaded when nothing was pending...
    type("Theme A name", "x");
    await openApplyDialog(withPending(2)); // ...two submissions arrived since
    expect(checkCalls).toBe(1);
    expect(warning()).toHaveTextContent(
      "Warning: 2 submissions still awaiting approval will be permanently discarded together with their teams. They will not be reviewed, scored or paid.",
    );
    expect(warning()).toHaveAttribute("role", "alert");
    expect(warning()).toHaveAttribute("data-pending", "2");
    // the number is stated once, in the warning (the readiness sentence of the dialog does not repeat it)
    expect(dlg("Apply Changes").textContent?.match(/awaiting approval/g)).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the singular for one submission", async () => {
    mount();
    type("Theme A name", "x");
    await openApplyDialog(withPending(1));
    expect(warning()).toHaveTextContent(
      "Warning: 1 submission still awaiting approval will be permanently discarded together with its team. It will not be reviewed, scored or paid.",
    );
  });

  it("says plainly when nothing is pending", async () => {
    mount();
    type("Theme A name", "x");
    await openApplyDialog(withPending(0));
    expect(warning()).toHaveTextContent(
      "No submissions are awaiting approval, so none will be discarded.",
    );
    expect(warning()).not.toHaveAttribute("role");
  });

  it("cannot be confirmed before the number is known", async () => {
    let release!: (r: Response) => void;
    armed = () => new Promise<Response>((r) => (release = r));
    mount();
    type("Theme A name", "x");
    fireEvent.click(applyBtn());
    expect(isOpen("Apply Changes")).toBe(true);
    expect(yesBtn()).toBeDisabled();
    expect(screen.getByTestId("renew-pending-checking")).toBeInTheDocument();
    fireEvent.click(yesBtn()); // a click on the disabled button sends nothing
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      release(
        new Response(
          JSON.stringify({ ok: true, data: snapshot(TOKEN, withPending(3)), server_now: 1 }),
          { status: 200 },
        ),
      );
    });
    await waitFor(() => expect(yesBtn()).toBeEnabled());
    expect(warning()).toHaveTextContent("Warning: 3 submissions");
  });

  it("if the state cannot be checked, nothing can be confirmed; GO BACK keeps every edit", async () => {
    armed = () => err(503, "SERVICE_UNAVAILABLE");
    mount();
    type("Theme A name", "kept");
    fireEvent.click(applyBtn());
    await waitFor(() =>
      expect(
        within(dlg("Apply Changes")).getByTestId("renew-pending-check-failed"),
      ).toBeInTheDocument(),
    );
    expect(yesBtn()).toBeDisabled();
    fireEvent.click(yesBtn());
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(within(dlg("Apply Changes")).getByRole("button", { name: "GO BACK" }));
    expect(isOpen("Apply Changes")).toBe(false);
    expect(box("Theme A name").value).toBe("kept");
  });

  it("if the content changed on the server meanwhile, the dialog closes and the stale notice takes over", async () => {
    mount();
    type("Theme A name", "mine");
    armCheck({}, TOKEN2);
    fireEvent.click(applyBtn());
    await waitFor(() => expect(screen.getByTestId("renew-stale")).toBeInTheDocument());
    await waitFor(() => expect(isOpen("Apply Changes")).toBe(false));
    expect(applyBtn()).toBeDisabled();
    expect(box("Theme A name").value).toBe("mine");
    expect(fetchMock).not.toHaveBeenCalled(); // nothing was sent
  });

  it("sends the renewal after confirmation and reports how many pending submissions were discarded", async () => {
    fetchMock
      .mockImplementationOnce(() => ok(result({ discarded: { pending_submissions: 2 } })))
      .mockImplementationOnce(() => ok(snapshot(TOKEN2)));
    mount();
    type("Theme A name", "x");
    fireEvent.click(await openApplyDialog(withPending(2)));
    await waitFor(() => expect(screen.getByTestId("renew-notice")).toBeInTheDocument());
    expect(screen.getByTestId("renew-notice")).toHaveTextContent(
      "Deleted 2 admins and 3 teams, and discarded 2 submissions still awaiting approval; the edited content is now live.",
    );
  });
});

describe("YES, APPLY CHANGES", () => {
  const openAndConfirm = async () => {
    fireEvent.click(await openApplyDialog());
  };

  it("sends the edited content once with the loaded token and an Idempotency-Key, shows progress, then the confirmed result", async () => {
    let release!: (r: Response) => void;
    fetchMock
      .mockImplementationOnce(() => new Promise<Response>((r) => (release = r)))
      .mockImplementationOnce(() =>
        ok(
          snapshot(TOKEN2, {
            readiness: readiness({ admins: 0, teams: 0 }) as RenewalRead["readiness"],
          }),
        ),
      );
    mount();
    type("Theme A name", "Renamed A");
    type("Reward of E.4", "999");
    type("Rule 3", "A new third rule\nwith two lines");
    const yes = await openApplyDialog();
    fireEvent.click(yes);
    fireEvent.click(yes); // a double click is one request

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("renew-progress")).toHaveTextContent("Applying changes");
    expect(applyBtn()).toBeDisabled();
    expect(resetBtn()).toBeDisabled();
    expect(box("Theme A name")).toBeDisabled();
    expect(screen.queryByTestId("renew-notice")).toBeNull(); // no success before the server says so

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/super/renew");
    expect((init as RequestInit).method).toBe("POST");
    expect(headerOf(0, "Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    const body = bodyOf(0);
    expect(Object.keys(body).sort()).toEqual(["content", "expectedToken"]);
    expect(body.expectedToken).toBe(TOKEN);
    expect(body.content.themes).toHaveLength(10);
    expect(body.content.themes[0].name).toBe("Renamed A");
    expect(body.content.themes[4].questions[3].reward).toBe(999); // a number, not the typed text
    expect(body.content.rules[2]).toBe("A new third rule\nwith two lines");
    expect(JSON.stringify(body)).not.toMatch(/staff|role/i);

    await act(async () => {
      release(
        new Response(JSON.stringify({ ok: true, data: result(), server_now: 1 }), { status: 200 }),
      );
    });
    await waitFor(() => expect(screen.getByTestId("renew-notice")).toBeInTheDocument());
    expect(screen.getByTestId("renew-notice")).toHaveTextContent(
      "The competition was renewed. Deleted 2 admins and 3 teams",
    );
    expect(isOpen("Apply Changes")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2); // the reload
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/super/renew");
    expect(screen.queryByTestId("renew-dirty")).toBeNull();
    expect(applyBtn()).toBeEnabled();
    expect(screen.getByTestId("renew-readiness")).toHaveTextContent("0 admins and 0 teams");
  });

  it("RENEWAL_BLOCKED: reports failure (never success), keeps the edits, and re-reads which teams block", async () => {
    fetchMock
      .mockImplementationOnce(() => err(409, "RENEWAL_BLOCKED", { blocked_count: 1 }))
      .mockImplementationOnce(() =>
        ok(
          snapshot(TOKEN, {
            readiness: readiness({
              ready: false,
              blocked_count: 1,
              blockers: [{ team_code: "T9", name: "Nine", reason: "ACTIVE_QUESTION" }],
            }) as RenewalRead["readiness"],
          }),
        ),
      );
    mount();
    type("Theme A name", "Keep me");
    await openAndConfirm();
    await waitFor(() => expect(screen.getByTestId("renew-error")).toBeInTheDocument());
    expect(screen.getByTestId("renew-error")).toHaveTextContent(
      "Nothing was changed. Some teams are still playing",
    );
    expect(screen.queryByTestId("renew-notice")).toBeNull();
    expect(screen.getByTestId("renew-error").textContent).not.toContain("SERVER TEXT");
    expect(isOpen("Apply Changes")).toBe(false);
    expect(box("Theme A name").value).toBe("Keep me");
    await waitFor(() =>
      expect(screen.getByTestId("renew-readiness")).toHaveTextContent(
        "T9 · Nine is solving a question right now",
      ),
    );
    expect(applyBtn()).toBeEnabled();
  });

  it("CONTENT_CHANGED: says so, blocks further applies, and 'load the latest' replaces the editor with the server's content", async () => {
    const latest = snapshot(TOKEN2);
    latest.content.themes[0]!.name = "Their name";
    fetchMock
      .mockImplementationOnce(() => err(409, "CONTENT_CHANGED"))
      .mockImplementationOnce(() => ok(latest))
      .mockImplementationOnce(() => ok(latest));
    mount();
    type("Theme A name", "My edit");
    await openAndConfirm();
    await waitFor(() => expect(screen.getByTestId("renew-stale")).toBeInTheDocument());
    expect(screen.getByTestId("renew-error")).toHaveTextContent("changed by someone else");
    expect(applyBtn()).toBeDisabled();
    expect(box("Theme A name").value).toBe("My edit"); // the edits are not silently lost
    fireEvent.click(screen.getByRole("button", { name: /Discard my edits and load the latest/ }));
    await waitFor(() => expect(box("Theme A name").value).toBe("Their name"));
    expect(screen.queryByTestId("renew-stale")).toBeNull();
    expect(applyBtn()).toBeEnabled();
  });

  it("a server VALIDATION_FAILED marks the fields it names", async () => {
    fetchMock.mockImplementationOnce(() =>
      err(400, "VALIDATION_FAILED", { fields: ["themes.B.name", "questions.C.2.reward"] }),
    );
    mount();
    type("Theme A name", "x");
    await openAndConfirm();
    await waitFor(() => expect(box("Theme B name")).toHaveAttribute("aria-invalid", "true"));
    expect(box("Reward of C.2")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByTestId("renew-error")).toHaveTextContent("Nothing was changed");
  });

  it("after an unknown outcome the retry reuses the Idempotency-Key; after a definite failure a new request gets a new one", async () => {
    fetchMock
      .mockImplementationOnce(() => Promise.reject(new TypeError("offline")))
      .mockImplementationOnce(() => err(409, "RENEWAL_BLOCKED"))
      .mockImplementation(() => ok(snapshot()));
    mount();
    type("Theme A name", "x");
    await openAndConfirm();
    await waitFor(() =>
      expect(screen.getByTestId("renew-error")).toHaveTextContent(
        "can't tell whether the renewal happened",
      ),
    );
    await openAndConfirm();
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(headerOf(1, "Idempotency-Key")).toBe(headerOf(0, "Idempotency-Key"));
    await waitFor(() =>
      expect(screen.getByTestId("renew-error")).toHaveTextContent("Some teams are still playing"),
    );
    await waitFor(() => expect(applyBtn()).toBeEnabled());
    const calls = fetchMock.mock.calls.length;
    await openAndConfirm();
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(calls));
    expect(headerOf(calls, "Idempotency-Key")).not.toBe(headerOf(0, "Idempotency-Key"));
  });

  it("a server error never shows server text", async () => {
    fetchMock.mockImplementationOnce(() => err(503, "SERVICE_UNAVAILABLE"));
    mount();
    type("Theme A name", "x");
    await openAndConfirm();
    await waitFor(() => expect(screen.getByTestId("renew-error")).toBeInTheDocument());
    expect(screen.getByTestId("renew-error")).toHaveTextContent("Nothing was reported as applied");
    expect(screen.getByTestId("renew-error").textContent).not.toContain("SERVER TEXT");
  });
});

describe("unsaved changes", () => {
  const beforeUnload = () => {
    const e = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  };
  const sidebarLink = () => {
    const a = document.createElement("a");
    a.href = "/superadmin/delete-teams";
    a.textContent = "Delete teams";
    document.body.appendChild(a);
    return a;
  };

  it("asks the browser to confirm closing or reloading only while there are edits", () => {
    mount();
    expect(beforeUnload()).toBe(false);
    type("Theme A name", "x");
    return waitFor(() => expect(beforeUnload()).toBe(true)).then(() => {
      fireEvent.click(resetBtn());
      return waitFor(() => expect(beforeUnload()).toBe(false));
    });
  });

  it("intercepts an in-app link with edits: 'Stay' keeps the page and edits, 'Leave and discard' navigates", async () => {
    mount();
    const link = sidebarLink();
    // no edits: the link is not intercepted
    const clean = fireEvent.click(link);
    expect(clean).toBe(true);
    expect(isOpen("Leave without applying?")).toBe(false);

    type("Theme A name", "x");
    await waitFor(() => expect(beforeUnload()).toBe(true));
    const intercepted = fireEvent.click(link);
    expect(intercepted).toBe(false); // default prevented
    expect(isOpen("Leave without applying?")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Stay on this page" }));
    expect(isOpen("Leave without applying?")).toBe(false);
    expect(box("Theme A name").value).toBe("x");
    expect(push).not.toHaveBeenCalled();

    fireEvent.click(link);
    fireEvent.click(screen.getByRole("button", { name: "Leave and discard" }));
    expect(push).toHaveBeenCalledWith("/superadmin/delete-teams");
  });

  it("the browser's Back button is guarded: Stay re-arms the guard, Leave goes back", async () => {
    const pushState = vi.spyOn(window.history, "pushState");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    mount();
    type("Theme A name", "x");
    await waitFor(() => expect(pushState).toHaveBeenCalledTimes(1)); // the guard entry
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(isOpen("Leave without applying?")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Stay on this page" }));
    expect(pushState).toHaveBeenCalledTimes(2);
    expect(box("Theme A name").value).toBe("x");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(isOpen("Leave without applying?")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Leave and discard" }));
    expect(back).toHaveBeenCalledTimes(1);
    pushState.mockRestore();
    back.mockRestore();
  });

  it("the Go back link is guarded too", async () => {
    mount();
    type("Theme A name", "x");
    await waitFor(() => expect(beforeUnload()).toBe(true));
    fireEvent.click(screen.getByRole("link", { name: /Go back/ }));
    expect(isOpen("Leave without applying?")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Leave and discard" }));
    expect(push).toHaveBeenCalledWith("/superadmin");
  });
});
