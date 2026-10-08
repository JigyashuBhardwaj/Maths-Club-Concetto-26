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
import { QUESTIONS_PER_THEME } from "@/lib/contracts/competition";
import type { BuyTimeOption } from "@/lib/contracts/gameplay";
import { buyHintCall, buyTimeCall } from "@/lib/economy/client";
import { submitAnswerCall } from "@/lib/gameplay/client";
import {
  canPlay,
  clocksRunning,
  currentOrdinal,
  effectiveState,
  findTheme,
  isUnlocked,
  questionRemainingMs,
  teamFrozen,
  teamRemainingSeconds,
} from "@/lib/gameplay/derive";
import { gameErrorText, isRetryable } from "@/lib/gameplay/messages";
import { formatDuration, formatMinSec } from "@/lib/home/format";
import type { ThemeId } from "@/lib/home/themes";
import { newIdempotencyKey } from "@/lib/provisioning/client";
import { cn } from "@/lib/utils";

import { ArrowButton } from "./arrow-button";
import { BuyTimeDialog } from "./buy-time-dialog";
import { HintDialogs } from "./hint-dialogs";
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
 * (Patch B15) are team-wide purchases whose prices, packs and texts all come from the server; once the team is frozen
 * (time up or final submission) every control here is read-only.
 */
export function QuestionPage({ theme, n }: QuestionPageProps) {
  const { state, loadFailed, refresh, apply } = useGame();
  const now = useServerNow();
  const answerId = useId();
  const titleLabel = `THEME ${theme}`;

  const themeView = state ? findTheme(state, theme) : undefined;
  const summary = themeView?.questions[n - 1];
  const unlocked = themeView ? isUnlocked(themeView) : false;
  const detail = useQuestionDetail(summary?.id, summary?.state);
  const q = detail.question;

  const running = state ? clocksRunning(state) : false;
  const frozen = state ? teamFrozen(state, now) : false;
  const playable = state ? canPlay(state, now) : false;
  const shownState = summary && state ? effectiveState(summary, state, now) : undefined;
  const isActive = shownState === "ACTIVE" && playable;
  const serverDraft = q?.draft;
  const draft = useDraft(summary?.id, serverDraft, isActive);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submitKey = useRef<{ text: string; key: string } | null>(null);

  // Hints (team-wide) and Buy Time. One idempotency key per user intent, kept until the server answers definitively.
  const [hintUi, setHintUi] = useState<{ tier: 1 | 2; mode: "buy" | "view" } | null>(null);
  const [hintBusy, setHintBusy] = useState(false);
  const [hintError, setHintError] = useState<string | null>(null);
  const hintKey = useRef<{ id: number; tier: number; key: string } | null>(null);
  const [buyOpen, setBuyOpen] = useState(false);
  const [buyBusy, setBuyBusy] = useState(false);
  const [buyError, setBuyError] = useState<string | null>(null);
  const timeKey = useRef<{ id: number; option: number; count: number; key: string } | null>(null);

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

  const buyHint = async (tier: 1 | 2) => {
    if (hintBusy) return;
    setHintBusy(true);
    setHintError(null);
    if (hintKey.current?.id !== summary.id || hintKey.current.tier !== tier) {
      hintKey.current = { id: summary.id, tier, key: newIdempotencyKey() };
    }
    const r = await buyHintCall(summary.id, tier, hintKey.current.key);
    setHintBusy(false);
    if (r.ok) {
      hintKey.current = null;
      detail.adopt(r.data.question);
      apply(r.data.state);
      setHintUi({ tier, mode: "view" });
      return;
    }
    if (!isRetryable(r.code)) hintKey.current = null;
    setHintError(gameErrorText(r.code));
    void refresh();
    detail.reload();
  };

  const buyTime = async (option: BuyTimeOption) => {
    if (buyBusy || !q) return;
    const expected = q.buy_time.purchase_count;
    setBuyBusy(true);
    setBuyError(null);
    const k = timeKey.current;
    if (k?.id !== summary.id || k.option !== option.id || k.count !== expected) {
      timeKey.current = {
        id: summary.id,
        option: option.id,
        count: expected,
        key: newIdempotencyKey(),
      };
    }
    const r = await buyTimeCall(summary.id, option.id, expected, timeKey.current!.key);
    setBuyBusy(false);
    if (r.ok) {
      timeKey.current = null;
      detail.adopt(r.data.question);
      apply(r.data.state);
      setBuyOpen(false);
      return;
    }
    if (!isRetryable(r.code)) timeKey.current = null;
    setBuyError(gameErrorText(r.code));
    void refresh();
    detail.reload();
  };

  const canBuyTime = isActive && (q?.buy_time.can_buy ?? false);
  const hintButtons = ([1, 2] as const).map((tier) => {
    const h = q?.hints.find((x) => x.tier === tier);
    const owned = h?.owned ?? false;
    const buyable = h !== undefined && h.purchasable && playable;
    const sub = !h
      ? ""
      : owned
        ? "unlocked"
        : buyable
          ? `${h.cost} coins`
          : tier === 2 && !q?.hints.find((x) => x.tier === 1)?.owned
            ? "after Hint 1"
            : "unavailable";
    return { tier, owned, buyable, sub, disabled: !h || (!owned && !buyable) };
  });

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
    (frozen && (status === "ACTIVE" || status === "TIMED_OUT" || status === "AVAILABLE")
      ? state.team.status === "FINAL_SUBMITTED"
        ? "Your team has made its final submission."
        : "Your team's time is up."
      : status === "TIMED_OUT"
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
              disabled={!canBuyTime}
              onClick={() => {
                setBuyError(null);
                setBuyOpen(true);
              }}
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
              {hintButtons.map((h) => (
                <button
                  key={h.tier}
                  type="button"
                  className="q-hint"
                  disabled={h.disabled}
                  aria-haspopup="dialog"
                  onClick={() => {
                    setHintError(null);
                    setHintUi({ tier: h.tier, mode: h.owned ? "view" : "buy" });
                  }}
                >
                  <span className="q-hint-name">Hint {h.tier}</span>
                  <span className="q-hint-sub">{h.sub}</span>
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

        <BuyTimeDialog
          open={buyOpen}
          options={q?.buy_time.options ?? []}
          coins={state.team.coins}
          canBuy={canBuyTime}
          teamRemainingSeconds={teamRemainingSeconds(state, now)}
          questionRemainingSeconds={Math.ceil(leftMs / 1000)}
          busy={buyBusy}
          error={buyError}
          onClose={() => setBuyOpen(false)}
          onConfirm={(option) => void buyTime(option)}
        />
        <HintDialogs
          active={hintUi}
          hints={q?.hints ?? []}
          coins={state.team.coins}
          busy={hintBusy}
          error={hintError}
          onClose={(mode) => setHintUi((cur) => (cur?.mode === mode ? null : cur))}
          onBuy={(tier) => void buyHint(tier)}
        />
      </main>
    </HomeStage>
  );
}
