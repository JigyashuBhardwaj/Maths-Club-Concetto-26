import { describe, expect, it } from "vitest";

import { QUESTION_SECONDS, REWARD_COINS } from "@/lib/question/constants";
import {
  approve,
  buyHint,
  buyTime,
  canBuyHint,
  clearAnswer,
  currentQuestionNumber,
  disapprove,
  enterQuestion,
  initialState,
  remainingMs,
  setAnswer,
  settle,
  submitAnswer,
  themeProgress,
  unlockTheme,
  viewStatus,
  type DemoState,
} from "@/lib/question/engine";

const T0 = 1_000_000;
const Q = QUESTION_SECONDS * 1000;

function started(): DemoState {
  return enterQuestion(unlockTheme(initialState(T0), "A"), "A", 1, T0);
}
function withAnswer(s: DemoState, text = "my answer", now = T0) {
  return setAnswer(s, "A", 1, text, now);
}

describe("start of a question (locked rules)", () => {
  it("Q1 is AVAILABLE until entered, then ACTIVE with a 4 minute timer", () => {
    const s = unlockTheme(initialState(T0), "A");
    expect(viewStatus(s, "A", 1)).toBe("AVAILABLE");
    const e = enterQuestion(s, "A", 1, T0 + 5);
    expect(viewStatus(e, "A", 1)).toBe("ACTIVE");
    expect(themeProgress(e, "A")[0]!.deadline).toBe(T0 + 5 + Q);
  });
  it("entering again does not restart the timer", () => {
    const s = started();
    expect(enterQuestion(s, "A", 1, T0 + 50_000)).toBe(s);
  });
  it("entering a locked theme or a later question does nothing", () => {
    const s = initialState(T0);
    expect(enterQuestion(s, "A", 1, T0)).toBe(s);
    const u = unlockTheme(s, "A");
    expect(enterQuestion(u, "A", 2, T0)).toBe(u);
  });
  it("later questions are LOCKED until the previous one is approved", () => {
    expect(viewStatus(started(), "A", 2)).toBe("LOCKED");
  });
});

describe("answer, submit, approve, disapprove", () => {
  it("cannot submit a blank answer", () => {
    const s = started();
    expect(submitAnswer(withAnswer(s, "   "), "A", 1, T0)).toEqual(withAnswer(s, "   "));
    expect(viewStatus(submitAnswer(withAnswer(s, "  "), "A", 1, T0), "A", 1)).toBe("ACTIVE");
  });
  it("submit freezes the question timer; the answer is kept", () => {
    const s = submitAnswer(withAnswer(started()), "A", 1, T0 + 60_000);
    const q = themeProgress(s, "A")[0]!;
    expect(q.status).toBe("PENDING_APPROVAL");
    expect(remainingMs(q, T0 + 999_999)).toBe(Q - 60_000);
    expect(q.submittedAnswer).toBe("my answer");
  });
  it("no editing, buying or second submit while pending", () => {
    const s = submitAnswer(withAnswer(started()), "A", 1, T0);
    expect(setAnswer(s, "A", 1, "other", T0)).toBe(s);
    expect(buyTime(s, "A", 1, 2, T0)).toBe(s);
    expect(buyHint(s, "A", 1, 1, T0)).toBe(s);
    expect(submitAnswer(s, "A", 1, T0)).toBe(s);
  });
  it("approve pays the reward once and activates the next question with a fresh timer", () => {
    const pending = submitAnswer(withAnswer(started()), "A", 1, T0 + 1000);
    const a = approve(pending, "A", 1, T0 + 9000);
    expect(a.coins).toBe(pending.coins + REWARD_COINS);
    expect(viewStatus(a, "A", 1)).toBe("APPROVED");
    expect(viewStatus(a, "A", 2)).toBe("ACTIVE");
    expect(themeProgress(a, "A")[1]!.deadline).toBe(T0 + 9000 + Q);
    expect(approve(a, "A", 1, T0 + 9500)).toBe(a);
  });
  it("disapprove resumes the paused timer and keeps the answer text", () => {
    const pending = submitAnswer(withAnswer(started()), "A", 1, T0 + 60_000);
    const d = disapprove(pending, "A", 1, T0 + 500_000);
    const q = themeProgress(d, "A")[0]!;
    expect(q.status).toBe("ACTIVE");
    expect(q.answer).toBe("my answer");
    expect(remainingMs(q, T0 + 500_000)).toBe(Q - 60_000);
    expect(d.coins).toBe(pending.coins);
  });
  it("approve/disapprove only apply to a pending submission", () => {
    const s = started();
    expect(approve(s, "A", 1, T0)).toBe(s);
    expect(disapprove(s, "A", 1, T0)).toBe(s);
  });
  it("clear all empties the draft", () => {
    expect(themeProgress(clearAnswer(withAnswer(started()), "A", 1, T0), "A")[0]!.answer).toBe("");
  });
});

describe("timeout", () => {
  it("an expired ACTIVE question becomes TIMED_OUT and blocks the next one", () => {
    const s = settle(started(), T0 + Q);
    expect(viewStatus(s, "A", 1)).toBe("TIMED_OUT");
    expect(viewStatus(s, "A", 2)).toBe("LOCKED");
    expect(remainingMs(themeProgress(s, "A")[0]!, T0 + Q * 2)).toBe(0);
  });
  it("nothing can be submitted, edited or bought at zero", () => {
    const s = withAnswer(started());
    const late = T0 + Q;
    expect(submitAnswer(s, "A", 1, late)).toBe(s);
    expect(setAnswer(s, "A", 1, "x", late)).toBe(s);
    expect(buyTime(s, "A", 1, 2, late)).toBe(s);
    expect(buyHint(s, "A", 1, 1, late)).toBe(s);
  });
  it("settle keeps the same object when nothing expired", () => {
    const s = started();
    expect(settle(s, T0 + 1000)).toBe(s);
  });
});

describe("buy time", () => {
  it.each([
    [2, 20],
    [4, 40],
    [8, 80],
  ])("%i minutes cost %i coins and extend the deadline", (minutes, cost) => {
    const s = started();
    const b = buyTime(s, "A", 1, minutes, T0 + 1000);
    expect(b.coins).toBe(s.coins - cost);
    expect(themeProgress(b, "A")[0]!.deadline).toBe(T0 + Q + minutes * 60_000);
  });
  it("is refused for unknown packs or too few coins", () => {
    const s = started();
    expect(buyTime(s, "A", 1, 3, T0)).toBe(s);
    expect(buyTime({ ...s, coins: 79 }, "A", 1, 8, T0)).toEqual({ ...s, coins: 79 });
  });
});

describe("hints", () => {
  it("cost 40 and 80, Tier 2 needs Tier 1, never paid twice", () => {
    const s = started();
    expect(canBuyHint(s, "A", 1, 2, T0)).toBe(false);
    expect(buyHint(s, "A", 1, 2, T0)).toBe(s);
    const h1 = buyHint(s, "A", 1, 1, T0);
    expect(h1.coins).toBe(s.coins - 40);
    expect(buyHint(h1, "A", 1, 1, T0)).toBe(h1);
    const h2 = buyHint(h1, "A", 1, 2, T0);
    expect(h2.coins).toBe(s.coins - 120);
    expect(themeProgress(h2, "A")[0]!.hints).toEqual([true, true]);
  });
  it("needs enough coins", () => {
    const s = { ...started(), coins: 39 };
    expect(buyHint(s, "A", 1, 1, T0)).toBe(s);
  });
});

describe("navigation helper", () => {
  it("currentQuestionNumber is the first question not yet approved", () => {
    const s = started();
    expect(currentQuestionNumber(s, "A")).toBe(1);
    const a = approve(submitAnswer(withAnswer(s), "A", 1, T0), "A", 1, T0);
    expect(currentQuestionNumber(a, "A")).toBe(2);
    expect(currentQuestionNumber(initialState(T0), "B")).toBe(1);
  });
});
