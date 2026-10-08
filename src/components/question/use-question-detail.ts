"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { Question } from "@/lib/contracts/gameplay";
import { enterQuestionCall, fetchQuestion } from "@/lib/gameplay/client";
import { gameErrorText, isRetryable } from "@/lib/gameplay/messages";
import { newIdempotencyKey } from "@/lib/provisioning/client";

import { useGame } from "@/components/game/game-provider";

export interface QuestionDetail {
  /** The latest question the server returned for this team; `null` until the first read. */
  question: Question | null;
  /** A fixed-wording message when the last read/enter failed. */
  error: string | null;
  /** Replace the held question with a newer server answer (e.g. the result of a submit). */
  adopt: (q: Question) => void;
  reload: () => void;
}

/**
 * Loads one question for the signed-in team. An AVAILABLE question is ENTERED (there is no Start button: opening the
 * page starts its timer, once, on the server; a second member opening it gets the same deadline). Every other
 * non-LOCKED state is simply read. The question is read again whenever the team snapshot changes (a teammate's draft,
 * an approval, a timeout), and responses that arrive out of order are dropped.
 */
export function useQuestionDetail(
  questionId: number | undefined,
  summaryState: string | undefined,
): QuestionDetail {
  const { state, refresh } = useGame();
  const [question, setQuestion] = useState<Question | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const enterKey = useRef<{ id: number; key: string } | null>(null);
  const [nonce, setNonce] = useState(0);
  const version = state?.state_version ?? -1;

  useEffect(() => {
    if (questionId === undefined || !summaryState || summaryState === "LOCKED") return;
    const mine = ++seq.current;
    let cancelled = false;
    void (async () => {
      let r;
      if (summaryState === "AVAILABLE") {
        if (enterKey.current?.id !== questionId) {
          enterKey.current = { id: questionId, key: newIdempotencyKey() };
        }
        r = await enterQuestionCall(questionId, enterKey.current.key);
        if (r.ok) enterKey.current = null;
        else if (!isRetryable(r.code)) enterKey.current = null;
      } else {
        r = await fetchQuestion(questionId);
      }
      if (cancelled || mine !== seq.current) return;
      if (r.ok) {
        setQuestion(r.data);
        setError(null);
        if (summaryState === "AVAILABLE") void refresh();
      } else {
        setError(gameErrorText(r.code));
        // the server's picture decides what to show next (e.g. it was started by a teammate meanwhile)
        void refresh();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [questionId, summaryState, version, nonce, refresh]);

  const adopt = useCallback((q: Question) => {
    seq.current += 1;
    setQuestion(q);
    setError(null);
  }, []);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // Never show another question's content while a new one loads.
  const current = question && question.id === questionId ? question : null;
  return { question: current, error, adopt, reload };
}
