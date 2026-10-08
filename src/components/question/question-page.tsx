"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

import {
  ClockIcon,
  CoinPileIcon,
  CoinsIcon,
  HourglassIcon,
  WalletIcon,
} from "@/components/home/icons";
import { HomeStage } from "@/components/home/home-stage";
import { useGame, useServerNow } from "@/components/game/game-provider";
import { submitAnswerCall } from "@/lib/gameplay/client";
import {
  clocksRunning,
  currentOrdinal,
  effectiveState,
  findTheme,
  isUnlocked,
  questionRemainingMs,
  teamRemainingSeconds,
} from "@/lib/gameplay/derive";
import { gameErrorText, isRetryable } from "@/lib/gameplay/messages";
import { formatDuration, formatMinSec } from "@/lib/home/format";
import type { ThemeId } from "@/lib/home/themes";
import { QUESTIONS_PER_THEME } from "@/lib/question/constants";
import { newIdempotencyKey } from "@/lib/provisioning/client";
import { cn } from "@/lib/utils";

import { ArrowButton } from "./arrow-button";
import { useDraft, type SaveStatus } from "./use-draft";
import { useQuestionDetail } from "./use-question-detail";

const base = (theme: ThemeId) => `/participant/theme/${theme}`;

interface QuestionPageProps {
  theme: ThemeId;
  n: number;
}

const SAVE_TEXT: Record<SaveStatus, string> = {
  idle: "",
  saving: "Saving…",
  saved: "Draft saved for your team",
  offline: "Offline — your draft will be saved when the connection returns",
};

/**
 * Question page. Everything on it is the server's: the question body (delivered only once the team has entered the
 * question), the deadline, the draft shared with teammates, the submission and its review, the coin balance and the
 * team timer. Opening an AVAILABLE question starts its timer once on the server (there is no Start button). The only
 * thing kept in the browser is the text being typed, which autosaves to the server after a pause. Hints and Buy Time
 * arrive in a later patch and are shown disabled.
 */
export function QuestionPage({ theme, n }: QuestionPageProps) {
  const { state, loadFailed, refresh } = useGame();
  const now = useServerNow();
  const answerId = useId();
  const titleLabel = `THEME ${theme}`;

  const themeView = state ? findTheme(state, theme) : undefined;
  const summary = themeView?.questions[n - 1];
  const unlocked = themeView ? isUnlocked(themeView) : false;
  const detail = useQuestionDetail(summary?.id, summary?.state);
  const q = detail.question;

  const running = state ? clocksRunning(state) : false;
  const shownState = summary && state ? effectiveState(summary, state, now) : undefined;
  const isActive = shownState === "ACTIVE" && running;
  const serverDraft = q?.draft;
  const draft = useDraft(summary?.id, serverDraft, isActive);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submitKey = useRef<{ text: string; key: string } | null>(null);

  // The effective state flipped to TIMED_OUT locally: ask the server for its own view straight away.
  const flipped = useRef(false);
  useEffect(() => {
    if (shownState === "TIMED_OUT" && summary?.state === "ACTIVE" && !flipped.current) {
      flipped.current = true;
      void refresh();
      detail.reload();
    }
    if (summary?.state !== "ACTIVE") flipped.current = false;
  }, [shownState, summary?.state, refresh, detail]);

  if (!state || !themeView) {
    return (
      <HomeStage>
        <main className="q-page" aria-busy={!loadFailed}>
          <h1 className="q-title">{titleLabel}</h1>
        </main>
      </HomeStage>
    );
  }

  const blocked = !unlocked || !summary || summary.state === "LOCKED";
  if (blocked) {
    const resume = `${base(theme)}/${currentOrdinal(themeView)}`;
    const toQuestion = unlocked && currentOrdinal(themeView) !== n;
    return (
      <HomeStage>
        <main className="q-page q-page-blocked">
          <h1 className="q-title">{titleLabel}</h1>
          <div className="q-notice" role="status">
            <p>
              {unlocked
                ? "This question is locked until the previous one is approved."
                : "This theme is locked. Unlock it from the home page first."}
            </p>
            <Link className="btn btn-primary" href={toQuestion ? resume : "/participant"}>
              {toQuestion ? "Go to the open question" : "Back to home"}
            </Link>
          </div>
        </main>
      </HomeStage>
    );
  }

  if (!summary) return null; // unreachable: `blocked` covers a missing question
  const status = shownState ?? summary.state;
  const text = isActive ? draft.text : (q?.submission?.answer ?? q?.draft?.answer ?? "");
  const leftMs = questionRemainingMs(summary, state, now);
  const canSubmit = isActive && draft.text.trim() !== "" && !submitting && !draft.conflict;
  const nextSummary = themeView.questions[n];
  const nextOpen =
    status === "APPROVED" && nextSummary !== undefined && nextSummary.state !== "LOCKED";
  const done = status === "APPROVED" && n === QUESTIONS_PER_THEME;
  const reward = q?.reward_coins ?? summary.reward_coins;

  const submit = async () => {
    if (!canSubmit || !summary) return;
    setSubmitting(true);
    setSubmitError(null);
    draft.pause();
    const sent = draft.text;
    // one click = one key; a retry of the same text after a lost response reuses it, so it cannot submit twice
    if (submitKey.current?.text !== sent)
      submitKey.current = { text: sent, key: newIdempotencyKey() };
    const r = await submitAnswerCall(summary.id, sent, submitKey.current.key);
    setSubmitting(false);
    if (r.ok) {
      submitKey.current = null;
      detail.adopt(r.data);
      await refresh();
      return;
    }
    if (!isRetryable(r.code)) submitKey.current = null;
    setSubmitError(gameErrorText(r.code));
    draft.resume();
    void refresh();
    detail.reload();
  };

  const submitUi = {
    ACTIVE: { label: submitting ? "Submitting…" : "Submit", cls: "q-submit-red" },
    PENDING_APPROVAL: { label: "Pending for approval", cls: "q-submit-grey" },
    APPROVED: { label: "Approved", cls: "q-submit-green" },
    TIMED_OUT: { label: "Time's up", cls: "q-submit-grey" },
  }[
    (status === "AVAILABLE" ? "ACTIVE" : status) as
      "ACTIVE" | "PENDING_APPROVAL" | "APPROVED" | "TIMED_OUT"
  ];

  const note =
    submitError ??
    detail.error ??
    (status === "TIMED_OUT"
      ? "Time is up for this question."
      : status === "PENDING_APPROVAL"
        ? "Your team's answer is waiting for review."
        : done
          ? "Theme complete."
          : status === "APPROVED"
            ? `Approved. +${q?.submission?.reward_awarded ?? reward ?? 0} coins`
            : !running && status === "ACTIVE"
              ? "The competition is paused."
              : q?.last_rejection
                ? `Not approved${q.last_rejection.note ? `: ${q.last_rejection.note}` : "."} You can edit and submit again.`
                : SAVE_TEXT[draft.status]);

  return (
    <HomeStage>
      <main className="q-page">
        <header className="q-header">
          <ArrowButton
            direction="back"
            label="Back to home"
            href="/participant"
            className="q-home"
          />
          <h1 className="q-title">{titleLabel}</h1>
          <div className="q-stats">
            <div className="stat" role="group" aria-label="Team timer">
              <HourglassIcon className="stat-icon stat-icon-hourglass" />
              <span className="stat-text">
                <span className="stat-label">time left</span>
                <span className="stat-value">
                  {formatDuration(teamRemainingSeconds(state, now))}
                </span>
              </span>
            </div>
            <div
              className="stat"
              role="group"
              aria-label="Question timer"
              data-low={isActive && leftMs <= 30_000}
            >
              <ClockIcon className="stat-icon stat-icon-clock" />
              <span className="stat-text">
                <span className="stat-label">time left</span>
                <span className="stat-value">
                  {status === "APPROVED" || status === "AVAILABLE"
                    ? "--:--"
                    : formatMinSec(Math.ceil(leftMs / 1000))}
                </span>
              </span>
            </div>
            <button
              type="button"
              className="stat stat-button"
              aria-haspopup="dialog"
              disabled
              title="Coming soon"
            >
              <WalletIcon className="stat-icon stat-icon-wallet" />
              <span className="stat-text">
                <span className="stat-label">buy time</span>
              </span>
            </button>
            <div className="stat" role="group" aria-label="Coins left">
              <CoinsIcon className="stat-icon stat-icon-coins" />
              <span className="stat-text">
                <span className="stat-label">coins left</span>
                <span className="stat-value">{state.team.coins}</span>
              </span>
            </div>
            <div className="stat" role="group" aria-label="Reward for an approved answer">
              <CoinPileIcon className="stat-icon stat-icon-reward" />
              <span className="stat-text">
                <span className="stat-value">{reward ?? "—"} coins++</span>
              </span>
            </div>
          </div>
        </header>

        <section
          className="q-frame"
          aria-label={`Question ${n} of ${QUESTIONS_PER_THEME}`}
          aria-busy={!q}
        >
          <div className="q-top">
            <div className="q-question" role="region" aria-label="Question" tabIndex={0}>
              <p className="q-number">Q{n}.</p>
              <p className="q-text">
                {q?.body_md ?? (detail.error ? "" : "Loading the question…")}
              </p>
            </div>
            <div className="q-hints" role="group" aria-label="Hints">
              {([1, 2] as const).map((tier) => (
                <button key={tier} type="button" className="q-hint" disabled aria-haspopup="dialog">
                  <span className="q-hint-name">Hint {tier}</span>
                  <span className="q-hint-sub">coming soon</span>
                </button>
              ))}
            </div>
          </div>

          <div className="q-answer">
            <div className="q-arrows">
              <ArrowButton
                direction="back"
                label="Previous question"
                href={n > 1 ? `${base(theme)}/${n - 1}` : undefined}
                disabled={n === 1}
              />
              <ArrowButton
                direction="next"
                label={
                  nextOpen
                    ? "Next question"
                    : "Next question (locked until this answer is approved)"
                }
                href={nextOpen ? `${base(theme)}/${n + 1}` : undefined}
                disabled={!nextOpen}
              />
            </div>
            <label htmlFor={answerId} className="sr-only">
              Your answer with explanation
            </label>
            <textarea
              id={answerId}
              className="q-input"
              placeholder="write your answer here with explanation"
              value={text}
              readOnly={!isActive}
              maxLength={10000}
              onChange={(e) => draft.setText(e.target.value)}
            />
          </div>

          {draft.conflict ? (
            <div className="q-conflict" role="alert">
              <span>A teammate saved a different draft.</span>
              <button type="button" className="q-clear" onClick={draft.useTheirs}>
                Use theirs
              </button>
              <button type="button" className="q-clear" onClick={draft.keepMine}>
                Keep mine
              </button>
            </div>
          ) : null}

          <div className="q-footer">
            <button
              type="button"
              className="q-clear"
              disabled={!isActive || draft.text === ""}
              onClick={() => draft.setText("")}
            >
              Clear all
            </button>
            <p className="q-status" role="status">
              {note}
            </p>
            <button
              type="button"
              className={cn("q-submit", submitUi.cls)}
              disabled={!canSubmit}
              onClick={() => void submit()}
            >
              {submitUi.label}
            </button>
          </div>
        </section>
      </main>
    </HomeStage>
  );
}
