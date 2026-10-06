"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";

import {
  ClockIcon,
  CoinPileIcon,
  CoinsIcon,
  HourglassIcon,
  WalletIcon,
} from "@/components/home/icons";
import { HomeStage } from "@/components/home/home-stage";
import { cn } from "@/lib/utils";
import { formatDuration, formatMinSec } from "@/lib/home/format";
import type { ThemeId } from "@/lib/home/themes";
import {
  HINT_COSTS,
  PLACEHOLDER_QUESTION,
  QUESTIONS_PER_THEME,
  REWARD_COINS,
} from "@/lib/question/constants";
import {
  approve,
  buyHint,
  buyTime,
  canBuyHint,
  clearAnswer,
  currentQuestionNumber,
  disapprove,
  enterQuestion,
  isUnlocked,
  remainingMs,
  setAnswer,
  submitAnswer,
  themeProgress,
  ultimateRemainingSeconds,
  viewStatus,
} from "@/lib/question/engine";
import { dispatch, resetDemo, useClock, useDemoState } from "@/lib/question/store";

import { ArrowButton } from "./arrow-button";
import { BuyTimeDialog } from "./buy-time-dialog";
import { DemoBar } from "./demo-bar";
import { HintDialogs } from "./hint-dialogs";

const base = (theme: ThemeId) => `/participant/theme/${theme}`;

interface QuestionPageProps {
  theme: ThemeId;
  n: number;
}

/**
 * Question page (UI foundation). Runs on the local demo engine: timers, coins, hints and the
 * admin's decision are simulated in this browser tab only; nothing is sent anywhere.
 */
export function QuestionPage({ theme, n }: QuestionPageProps) {
  const demo = useDemoState();
  const now = useClock();
  const ready = demo !== null && now !== null;
  const unlocked = demo ? isUnlocked(demo, theme) : false;

  // Q1 becomes ACTIVE (its timer starts) the moment the member enters it.
  useEffect(() => {
    if (ready && unlocked) dispatch((s, t) => enterQuestion(s, theme, n, t));
  }, [ready, unlocked, theme, n]);

  const [buyTimeOpen, setBuyTimeOpen] = useState(false);
  const [hint, setHint] = useState<{ tier: 1 | 2; mode: "buy" | "view" } | null>(null);
  const titleLabel = `THEME ${theme}`;
  const answerId = useId();

  if (!ready) {
    return (
      <HomeStage>
        <main className="q-page" aria-busy="true">
          <h1 className="q-title">{titleLabel}</h1>
        </main>
      </HomeStage>
    );
  }

  const status = viewStatus(demo, theme, n);
  const blocked = !unlocked || status === "LOCKED";

  if (blocked) {
    const resume = `${base(theme)}/${currentQuestionNumber(demo, theme)}`;
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
            <Link className="btn btn-primary" href={unlocked ? resume : "/participant"}>
              {unlocked ? "Go to the open question" : "Back to home"}
            </Link>
          </div>
        </main>
      </HomeStage>
    );
  }

  const list = themeProgress(demo, theme);
  const q = list[n - 1]!;
  if (status === "AVAILABLE") {
    // First render before the "enter" effect has run; show the frame title only (body stays hidden).
    return (
      <HomeStage>
        <main className="q-page" aria-busy="true">
          <h1 className="q-title">{titleLabel}</h1>
        </main>
      </HomeStage>
    );
  }

  const left = remainingMs(q, now);
  const isActive = status === "ACTIVE" && left > 0;
  const shownAnswer = isActive ? q.answer : (q.submittedAnswer ?? q.answer);
  const canSubmit = isActive && q.answer.trim() !== "";
  const nextOpen = status === "APPROVED" && n < QUESTIONS_PER_THEME;
  const done = status === "APPROVED" && n === QUESTIONS_PER_THEME;

  const hintLabel = (tier: 1 | 2) => {
    if (q.hints[tier - 1]) return "unlocked · view";
    if (tier === 2 && !q.hints[0]) return "buy hint 1 first";
    return `buy with ${HINT_COSTS[tier - 1]} coins`;
  };
  const openHint = (tier: 1 | 2) => {
    if (q.hints[tier - 1]) setHint({ tier, mode: "view" });
    else if (canBuyHint(demo, theme, n, tier, now)) setHint({ tier, mode: "buy" });
    else if (isActive && (tier === 1 || q.hints[0])) setHint({ tier, mode: "buy" }); // opens with "not enough coins"
  };
  const hintDisabled = (tier: 1 | 2) =>
    !q.hints[tier - 1] && (!isActive || (tier === 2 && !q.hints[0]));

  const submit = {
    ACTIVE: { label: "Submit", cls: "q-submit-red" },
    PENDING_APPROVAL: { label: "Pending for approval", cls: "q-submit-grey" },
    APPROVED: { label: "Approved", cls: "q-submit-green" },
    TIMED_OUT: { label: "Time's up", cls: "q-submit-grey" },
  }[
    status === "ACTIVE" && !isActive
      ? "TIMED_OUT"
      : (status as "ACTIVE" | "PENDING_APPROVAL" | "APPROVED" | "TIMED_OUT")
  ];

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
            <div className="stat" role="group" aria-label="Ultimate timer">
              <HourglassIcon className="stat-icon stat-icon-hourglass" />
              <span className="stat-text">
                <span className="stat-label">time left</span>
                <span className="stat-value">
                  {formatDuration(ultimateRemainingSeconds(demo, now))}
                </span>
              </span>
            </div>
            <div
              className="stat"
              role="group"
              aria-label="Question timer"
              data-low={isActive && left <= 30_000}
            >
              <ClockIcon className="stat-icon stat-icon-clock" />
              <span className="stat-text">
                <span className="stat-label">time left</span>
                <span className="stat-value">{formatMinSec(Math.ceil(left / 1000))}</span>
              </span>
            </div>
            <button
              type="button"
              className="stat stat-button"
              aria-haspopup="dialog"
              disabled={!isActive}
              onClick={() => setBuyTimeOpen(true)}
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
                <span className="stat-value">{demo.coins}</span>
              </span>
            </div>
            <div className="stat" role="group" aria-label="Reward for an approved answer">
              <CoinPileIcon className="stat-icon stat-icon-reward" />
              <span className="stat-text">
                <span className="stat-value">{REWARD_COINS} coins++</span>
              </span>
            </div>
          </div>
        </header>

        <section className="q-frame" aria-label={`Question ${n} of ${QUESTIONS_PER_THEME}`}>
          <div className="q-top">
            <div className="q-question" role="region" aria-label="Question" tabIndex={0}>
              <p className="q-number">Q{n}.</p>
              <p className="q-text">{PLACEHOLDER_QUESTION}</p>
            </div>
            <div className="q-hints" role="group" aria-label="Hints">
              {([1, 2] as const).map((tier) => (
                <button
                  key={tier}
                  type="button"
                  className={cn("q-hint", q.hints[tier - 1] && "is-owned")}
                  disabled={hintDisabled(tier)}
                  aria-haspopup="dialog"
                  onClick={() => openHint(tier)}
                >
                  <span className="q-hint-name">Hint {tier}</span>
                  <span className="q-hint-sub">{hintLabel(tier)}</span>
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
              value={shownAnswer}
              readOnly={!isActive}
              onChange={(e) => {
                const v = e.target.value;
                dispatch((s, t) => setAnswer(s, theme, n, v, t));
              }}
            />
          </div>

          <div className="q-footer">
            <button
              type="button"
              className="q-clear"
              disabled={!isActive || q.answer === ""}
              onClick={() => dispatch((s, t) => clearAnswer(s, theme, n, t))}
            >
              Clear all
            </button>
            <p className="q-status" role="status">
              {status === "TIMED_OUT" || (status === "ACTIVE" && !isActive)
                ? "Time is up for this question."
                : done
                  ? "Theme complete."
                  : ""}
            </p>
            <button
              type="button"
              className={cn("q-submit", submit.cls)}
              disabled={!canSubmit}
              onClick={() => dispatch((s, t) => submitAnswer(s, theme, n, t))}
            >
              {submit.label}
            </button>
          </div>
        </section>

        <DemoBar
          canDecide={status === "PENDING_APPROVAL"}
          onApprove={() => dispatch((s, t) => approve(s, theme, n, t))}
          onDisapprove={() => dispatch((s, t) => disapprove(s, theme, n, t))}
          onReset={() => resetDemo()}
        />
      </main>

      <BuyTimeDialog
        open={buyTimeOpen}
        coins={demo.coins}
        onClose={() => setBuyTimeOpen(false)}
        onConfirm={(minutes) => dispatch((s, t) => buyTime(s, theme, n, minutes, t))}
      />
      <HintDialogs
        active={hint}
        coins={demo.coins}
        onClose={(mode) => setHint((h) => (h?.mode === mode ? null : h))}
        onBuy={(tier) => {
          dispatch((s, t) => buyHint(s, theme, n, tier, t));
          setHint({ tier, mode: "view" });
        }}
      />
    </HomeStage>
  );
}
