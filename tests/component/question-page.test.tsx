// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QuestionPage } from "@/components/question/question-page";
import { DRAFT_DEBOUNCE_MS } from "@/components/question/use-draft";

import { Game, makeClient, NOW, question, snapshot, type QState } from "./support/game";
import content from "../../content/concetto26/official-content.json";

// The WebGL background is not what is under test (and jsdom has no WebGL).
vi.mock("@/components/home/home-stage", () => ({
  HomeStage: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
const client = vi.hoisted(() => ({}) as Record<string, ReturnType<typeof vi.fn>>);
vi.mock("@/lib/gameplay/client", () => client);
const c = makeClient();

let current = snapshot();
const states = (...q: QState[]) => snapshot({ themes: { A: { q } } });

function mount(initial = current, n = 1) {
  current = initial;
  return render(
    <Game initial={initial}>
      <QuestionPage theme="A" n={n} />
    </Game>,
  );
}

beforeEach(() => {
  Object.assign(client, {
    fetchTeamState: c.fetchTeamState,
    sendHeartbeat: c.sendHeartbeat,
    fetchQuestion: c.fetchQuestion,
    enterQuestionCall: c.enterQuestionCall,
    saveDraftCall: c.saveDraftCall,
    submitAnswerCall: c.submitAnswerCall,
  });
  for (const f of [
    c.fetchTeamState,
    c.fetchQuestion,
    c.enterQuestionCall,
    c.saveDraftCall,
    c.submitAnswerCall,
  ])
    f.mockReset();
  c.fetchTeamState.mockImplementation(async () => c.ok(current));
  c.saveDraftCall.mockResolvedValue(c.ok({ version: 1, updated_by_slot: 1, updated_at: NOW }));
});
afterEach(() => vi.useRealTimers());

describe("opening a question", () => {
  it("an AVAILABLE question is entered automatically, once; there is no Start button; the body appears from the server's answer", async () => {
    c.enterQuestionCall.mockResolvedValue(c.ok(question({ state: "ACTIVE" })));
    mount(states("AVAILABLE", "LOCKED", "LOCKED", "LOCKED", "LOCKED"));
    expect(await screen.findByText("Find the value of x.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /start/i })).toBeNull();
    expect(c.enterQuestionCall).toHaveBeenCalledTimes(1);
    expect(c.enterQuestionCall.mock.calls[0]![0]).toBe(1);
    expect(c.enterQuestionCall.mock.calls[0]![1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.fetchQuestion).not.toHaveBeenCalled();
  });

  it("an AVAILABLE question shows no text before the server has delivered it", async () => {
    let release!: (v: unknown) => void;
    c.enterQuestionCall.mockReturnValue(new Promise((r) => (release = r)));
    mount(states("AVAILABLE", "LOCKED", "LOCKED", "LOCKED", "LOCKED"));
    expect(screen.getByText("Loading the question…")).toBeInTheDocument();
    expect(screen.queryByText("Find the value of x.")).toBeNull();
    await act(async () => release(c.ok(question())));
    expect(await screen.findByText("Find the value of x.")).toBeInTheDocument();
  });

  it("B17: a multi-line official question keeps its line breaks, its math symbols and its aligned table", async () => {
    const body = content.questions.find((x) => x.id === "E.3")!.question;
    c.fetchQuestion.mockResolvedValue(c.ok(question({ body_md: body })));
    mount(states("ACTIVE", "LOCKED", "LOCKED", "LOCKED", "LOCKED"));
    const text = await screen.findByText(/Two poker players/);
    const root = text.closest(".q-text")!;
    expect(root.querySelector("pre.content-pre")!.textContent).toContain(
      "Play Safe (S)   3          −2",
    );
    expect(root.textContent).toContain("−4");
    expect(root.querySelector("script, img, a")).toBeNull();
  });

  it("an ACTIVE question is read, not re-entered; the page shows the five stats from the server", async () => {
    c.fetchQuestion.mockResolvedValue(c.ok(question()));
    mount(states("ACTIVE", "LOCKED", "LOCKED", "LOCKED", "LOCKED"));
    expect(await screen.findByText("Find the value of x.")).toBeInTheDocument();
    expect(c.enterQuestionCall).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { level: 1, name: content.themes[0]!.name }),
    ).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Team timer" })).toHaveTextContent(
      /03:(58:5\d|59:\d\d)/,
    );
    expect(screen.getByRole("group", { name: "Question timer" })).toHaveTextContent(
      /0[23]:[0-5]\d/,
    );
    expect(screen.getByRole("group", { name: "Coins left" })).toHaveTextContent("400");
    expect(screen.getByRole("group", { name: /Reward/ })).toHaveTextContent("50 coins++");
  });

  it("Buy Time and Hint 1 are available on an ACTIVE question; Hint 2 waits for Hint 1 (details: economy.test.tsx)", async () => {
    c.fetchQuestion.mockResolvedValue(c.ok(question()));
    mount(states("ACTIVE", "LOCKED", "LOCKED", "LOCKED", "LOCKED"));
    await screen.findByText("Find the value of x.");
    expect(screen.getByRole("button", { name: "buy time" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Hint 1/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Hint 2/ })).toBeDisabled();
  });

  it("a LOCKED question shows only a notice and never asks the server for its body", async () => {
    mount(states("ACTIVE", "LOCKED", "LOCKED", "LOCKED", "LOCKED"), 2);
    expect(
      await screen.findByText(/locked until the previous one is approved/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to the open question" })).toHaveAttribute(
      "href",
      "/participant/theme/A/1",
    );
    expect(c.fetchQuestion).not.toHaveBeenCalled();
    expect(c.enterQuestionCall).not.toHaveBeenCalled();
  });

  it("a theme the team has not unlocked is a notice that links home", async () => {
    mount(snapshot());
    expect(await screen.findByText(/This theme is locked/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to home" })).toHaveAttribute(
      "href",
      "/participant",
    );
    expect(c.fetchQuestion).not.toHaveBeenCalled();
  });

  it("an entry refused by the server shows fixed wording, not server text", async () => {
    c.enterQuestionCall.mockResolvedValue(c.fail("QUESTION_NOT_AVAILABLE"));
    mount(states("AVAILABLE", "LOCKED", "LOCKED", "LOCKED", "LOCKED"));
    expect(
      await screen.findByText("This question can't be started right now."),
    ).toBeInTheDocument();
  });
});

describe("the shared draft", () => {
  it("shows the draft the server holds (so a refresh or a teammate's device sees the same text)", async () => {
    c.fetchQuestion.mockResolvedValue(
      c.ok(
        question({
          draft: {
            answer: "x = 4",
            explanation: "",
            version: 3,
            updated_by_slot: 2,
            updated_at: NOW,
          },
        }),
      ),
    );
    mount(states("ACTIVE", "LOCKED", "LOCKED", "LOCKED", "LOCKED"));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("x = 4"));
  });

  it("autosaves after a pause with the version it last saw; typing never calls the server on every keystroke", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
      now: NOW,
    });
    c.fetchQuestion.mockResolvedValue(c.ok(question()));
    c.saveDraftCall.mockResolvedValue(c.ok({ version: 1, updated_by_slot: 1, updated_at: NOW }));
    mount(states("ACTIVE", "LOCKED", "LOCKED", "LOCKED", "LOCKED"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "x" } });
    fireEvent.change(box, { target: { value: "x =" } });
    fireEvent.change(box, { target: { value: "x = 4" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS - 100);
    });
    expect(c.saveDraftCall).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(c.saveDraftCall).toHaveBeenCalledTimes(1);
    expect(c.saveDraftCall).toHaveBeenCalledWith(1, "x = 4", 0);
    expect(screen.getByRole("status")).toHaveTextContent("Draft saved for your team");
    // the next save builds on the version the server returned
    fireEvent.change(box, { target: { value: "x = 4, y" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS + 50);
    });
    expect(c.saveDraftCall).toHaveBeenLastCalledWith(1, "x = 4, y", 1);
  });

  it("a teammate's newer draft is never overwritten silently: the member chooses", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
      now: NOW,
    });
    c.fetchQuestion.mockResolvedValue(c.ok(question()));
    mount(states("ACTIVE", "LOCKED", "LOCKED", "LOCKED", "LOCKED"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    c.saveDraftCall.mockResolvedValue(c.fail("STALE_DRAFT", 409, { version: 4 }));
    // the stale answer triggers a read of the server copy
    c.fetchQuestion.mockResolvedValue(
      c.ok(
        question({
          draft: {
            answer: "teammate's text",
            explanation: "",
            version: 4,
            updated_by_slot: 3,
            updated_at: NOW,
          },
        }),
      ),
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "my text" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS + 50);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("A teammate saved a different draft");
    expect(screen.getByRole("textbox")).toHaveValue("my text");
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Use theirs" }));
    expect(screen.getByRole("textbox")).toHaveValue("teammate's text");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeping mine saves on top of the teammate's version", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
      now: NOW,
    });
    c.fetchQuestion.mockResolvedValue(c.ok(question()));
    mount(states("ACTIVE", "LOCKED", "LOCKED", "LOCKED", "LOCKED"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    c.saveDraftCall.mockResolvedValueOnce(c.fail("STALE_DRAFT", 409, { version: 4 }));
    c.fetchQuestion.mockResolvedValue(
      c.ok(
        question({
          draft: {
            answer: "theirs",
            explanation: "",
            version: 4,
            updated_by_slot: 3,
            updated_at: NOW,
          },
        }),
      ),
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "mine" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS + 50);
    });
    c.saveDraftCall.mockResolvedValue(c.ok({ version: 5, updated_by_slot: 1, updated_at: NOW }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(c.saveDraftCall).toHaveBeenLastCalledWith(1, "mine", 4);
  });

  it("Clear all empties the text and is itself autosaved", async () => {
    c.fetchQuestion.mockResolvedValue(
      c.ok(
        question({
          draft: {
            answer: "abc",
            explanation: "",
            version: 1,
            updated_by_slot: 1,
            updated_at: NOW,
          },
        }),
      ),
    );
    mount(states("ACTIVE", "LOCKED", "LOCKED", "LOCKED", "LOCKED"));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("abc"));
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
  });
});

describe("submitting", () => {
  it("Submit sends the typed text with an idempotency key and then shows the pending state with the frozen timer", async () => {
    c.fetchQuestion.mockResolvedValue(
      c.ok(
        question({
          draft: { answer: "42", explanation: "", version: 2, updated_by_slot: 1, updated_at: NOW },
        }),
      ),
    );
    mount(states("ACTIVE", "LOCKED", "LOCKED", "LOCKED", "LOCKED"));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("42"));
    const pending = question({
      state: "PENDING_APPROVAL",
      deadline: undefined,
      remaining_seconds: 150,
      submission: {
        id: "2a8f4c1e-6b3d-4e7a-9c50-1d2e3f4a5b6c",
        status: "PENDING",
        answer: "42",
        explanation: "",
        submitted_by_slot: 1,
        submitted_at: NOW,
        reviewed_at: null,
        review_note: null,
        reward_awarded: null,
      },
    });
    c.submitAnswerCall.mockResolvedValue(c.ok(pending));
    current = snapshot({
      version: 2,
      themes: { A: { q: ["PENDING_APPROVAL", "LOCKED", "LOCKED", "LOCKED", "LOCKED"] } },
    });
    const submit = screen.getByRole("button", { name: "Submit" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(await screen.findByRole("button", { name: "Pending for approval" })).toBeDisabled();
    expect(c.submitAnswerCall).toHaveBeenCalledTimes(1);
    expect(c.submitAnswerCall.mock.calls[0]!.slice(0, 2)).toEqual([1, "42"]);
    expect(c.submitAnswerCall.mock.calls[0]![2]).toMatch(/^[0-9a-f-]{36}$/);
    expect(screen.getByRole("textbox")).toHaveAttribute("readonly");
    expect(screen.getByRole("group", { name: "Question timer" })).toHaveTextContent("02:00");
    expect(screen.getByRole("status")).toHaveTextContent("waiting for review");
  });

  it("a lost connection keeps the key for the retry; the text stays editable", async () => {
    c.fetchQuestion.mockResolvedValue(
      c.ok(
        question({
          draft: { answer: "42", explanation: "", version: 2, updated_by_slot: 1, updated_at: NOW },
        }),
      ),
    );
    mount(states("ACTIVE", "LOCKED", "LOCKED", "LOCKED", "LOCKED"));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("42"));
    c.submitAnswerCall.mockResolvedValueOnce(c.fail("NETWORK_ERROR", 0));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText(/Can't reach the server/)).toBeInTheDocument();
    c.submitAnswerCall.mockResolvedValueOnce(c.fail("SUBMISSION_PENDING"));
    fireEvent.click(await screen.findByRole("button", { name: "Submit" }));
    await waitFor(() => expect(c.submitAnswerCall).toHaveBeenCalledTimes(2));
    expect(c.submitAnswerCall.mock.calls[1]![2]).toBe(c.submitAnswerCall.mock.calls[0]![2]);
  });

  it("a refused submit shows fixed wording", async () => {
    c.fetchQuestion.mockResolvedValue(
      c.ok(
        question({
          draft: { answer: "42", explanation: "", version: 2, updated_by_slot: 1, updated_at: NOW },
        }),
      ),
    );
    mount(states("ACTIVE", "LOCKED", "LOCKED", "LOCKED", "LOCKED"));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("42"));
    c.submitAnswerCall.mockResolvedValue(c.fail("QUESTION_TIMED_OUT"));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText("Time is up for this question.")).toBeInTheDocument();
  });

  it("Submit needs text", async () => {
    c.fetchQuestion.mockResolvedValue(c.ok(question()));
    mount(states("ACTIVE", "LOCKED", "LOCKED", "LOCKED", "LOCKED"));
    await screen.findByText("Find the value of x.");
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
  });
});

describe("the other states, as the server reports them", () => {
  it("PENDING_APPROVAL: read-only, the team's submitted answer, the frozen timer", async () => {
    c.fetchQuestion.mockResolvedValue(
      c.ok(
        question({
          state: "PENDING_APPROVAL",
          deadline: undefined,
          remaining_seconds: 120,
          submission: {
            id: "2a8f4c1e-6b3d-4e7a-9c50-1d2e3f4a5b6c",
            status: "PENDING",
            answer: "the submitted answer",
            explanation: "",
            submitted_by_slot: 2,
            submitted_at: NOW,
            reviewed_at: null,
            review_note: null,
            reward_awarded: null,
          },
        }),
      ),
    );
    mount(states("PENDING_APPROVAL", "LOCKED", "LOCKED", "LOCKED", "LOCKED"));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("the submitted answer"));
    expect(screen.getByRole("textbox")).toHaveAttribute("readonly");
    expect(screen.getByRole("group", { name: "Question timer" })).toHaveTextContent("02:00");
    expect(screen.getByRole("button", { name: "Pending for approval" })).toBeDisabled();
  });

  it("APPROVED: green Approved, the reward, and the next arrow opens the now-active question", async () => {
    c.fetchQuestion.mockResolvedValue(
      c.ok(
        question({
          state: "APPROVED",
          deadline: undefined,
          remaining_seconds: undefined,
          submission: {
            id: "2a8f4c1e-6b3d-4e7a-9c50-1d2e3f4a5b6c",
            status: "APPROVED",
            answer: "42",
            explanation: "",
            submitted_by_slot: 2,
            submitted_at: NOW,
            reviewed_at: NOW,
            review_note: null,
            reward_awarded: 50,
          },
        }),
      ),
    );
    mount(states("APPROVED", "ACTIVE", "LOCKED", "LOCKED", "LOCKED"));
    expect(await screen.findByRole("button", { name: "Approved" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Approved. +50 coins");
    expect(screen.getByRole("link", { name: "Next question" })).toHaveAttribute(
      "href",
      "/participant/theme/A/2",
    );
  });

  it("a disapproved answer is ACTIVE again with the reviewer's note and the draft kept", async () => {
    c.fetchQuestion.mockResolvedValue(
      c.ok(
        question({
          draft: {
            answer: "my old answer",
            explanation: "",
            version: 5,
            updated_by_slot: 1,
            updated_at: NOW,
          },
          last_rejection: { note: "Check the units", reviewed_at: NOW },
        }),
      ),
    );
    mount(states("ACTIVE", "LOCKED", "LOCKED", "LOCKED", "LOCKED"));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("my old answer"));
    expect(screen.getByRole("status")).toHaveTextContent("Not approved: Check the units");
    expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled();
  });

  it("TIMED_OUT: read-only 'Time's up'", async () => {
    c.fetchQuestion.mockResolvedValue(
      c.ok(question({ state: "TIMED_OUT", deadline: undefined, remaining_seconds: undefined })),
    );
    mount(states("TIMED_OUT", "LOCKED", "LOCKED", "LOCKED", "LOCKED"));
    expect(await screen.findByRole("button", { name: "Time's up" })).toBeDisabled();
    expect(screen.getByRole("textbox")).toHaveAttribute("readonly");
    expect(screen.getByRole("status")).toHaveTextContent("Time is up for this question.");
  });

  it("a paused competition freezes editing and says so", async () => {
    c.fetchQuestion.mockResolvedValue(c.ok(question()));
    mount(
      snapshot({
        competition: "PAUSED",
        themes: { A: { q: ["ACTIVE", "LOCKED", "LOCKED", "LOCKED", "LOCKED"] } },
      }),
    );
    await screen.findByText("Find the value of x.");
    expect(screen.getByRole("textbox")).toHaveAttribute("readonly");
    expect(screen.getByRole("status")).toHaveTextContent("The competition is paused.");
  });

  it("an ACTIVE question whose server deadline has passed is shown as timed out at once", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
      now: NOW,
    });
    c.fetchQuestion.mockResolvedValue(c.ok(question()));
    mount(states("ACTIVE", "LOCKED", "LOCKED", "LOCKED", "LOCKED"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    // a server whose clock advances with the (fake) time: its polls keep reporting the same absolute deadline
    c.fetchTeamState.mockImplementation(async () => c.ok({ ...current, server_now: Date.now() }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(201_000);
    });
    expect(screen.getByRole("button", { name: "Time's up" })).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveAttribute("readonly");
  });
});
