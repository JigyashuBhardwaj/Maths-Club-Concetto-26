"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { Question } from "@/lib/contracts/gameplay";
import { fetchQuestion, saveDraftCall } from "@/lib/gameplay/client";

/** Autosave cadence: at most one save per 1.5 s of typing (API_SPEC §8). */
export const DRAFT_DEBOUNCE_MS = 1500;
const RETRY_MS = 3000;

export type SaveStatus = "idle" | "saving" | "saved" | "offline";

export interface Conflict {
  answer: string;
  version: number;
}

export interface DraftControls {
  text: string;
  setText: (v: string) => void;
  status: SaveStatus;
  /** A teammate saved a different draft while this member was typing. */
  conflict: Conflict | null;
  useTheirs: () => void;
  keepMine: () => void;
  /** Stop autosaving while the answer is being submitted; `resume` if the submit did not go through. */
  pause: () => void;
  resume: () => void;
}

/**
 * The team's shared draft, edited by this member. The server holds the draft (a refresh, another device or another
 * teammate sees it); the browser only keeps what is being typed, saves it after a pause with compare-and-set
 * (`expectedVersion`), and never overwrites a teammate silently: on STALE_DRAFT it reads the server copy, and when that
 * differs from what is typed it asks which to keep. Nothing is stored in the browser. The page remounts this hook
 * (`key`) for every question, so a draft never leaks from one question to the next.
 */
export function useDraft(
  questionId: number | undefined,
  server: Question["draft"] | undefined,
  editable: boolean,
): DraftControls {
  const [text, setTextState] = useState(server?.answer ?? "");
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const base = useRef(server?.version ?? 0);
  const dirty = useRef(false);
  const latest = useRef(text);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef(false);
  const qid = useRef(questionId);
  const saveAgain = useRef<() => void>(() => {});
  const stopped = useRef(false);

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  // The server's draft moved on (a teammate typed, or this member's own save was echoed back).
  useEffect(() => {
    if (!server) return;
    if (!dirty.current) {
      if (
        server.version >= base.current &&
        (server.version !== base.current || server.answer !== latest.current)
      ) {
        base.current = server.version;
        latest.current = server.answer;
        setTextState(server.answer);
      }
    } else if (server.version > base.current && server.answer !== latest.current) {
      setConflict({ answer: server.answer, version: server.version });
    }
  }, [server]);

  const save = useCallback(async () => {
    clearTimer();
    const id = qid.current;
    if (id === undefined || saving.current || stopped.current || !dirty.current) return;
    saving.current = true;
    setStatus("saving");
    const sent = latest.current;
    const r = await saveDraftCall(id, sent, base.current);
    saving.current = false;
    if (id !== qid.current || stopped.current) return;
    if (r.ok) {
      base.current = r.data.version;
      if (latest.current === sent) {
        dirty.current = false;
        setStatus("saved");
      } else {
        setStatus("saving");
        timer.current = setTimeout(() => saveAgain.current(), DRAFT_DEBOUNCE_MS);
      }
      return;
    }
    if (r.code === "STALE_DRAFT") {
      const q = await fetchQuestion(id);
      if (id !== qid.current) return;
      if (q.ok && q.data.draft) {
        if (q.data.draft.answer === latest.current) {
          base.current = q.data.draft.version;
          dirty.current = false;
          setStatus("saved");
        } else {
          setConflict({ answer: q.data.draft.answer, version: q.data.draft.version });
          setStatus("idle");
        }
        return;
      }
    }
    if (
      r.code === "NETWORK_ERROR" ||
      r.code === "SERVICE_UNAVAILABLE" ||
      r.code === "BAD_RESPONSE"
    ) {
      setStatus("offline");
      timer.current = setTimeout(() => saveAgain.current(), RETRY_MS);
      return;
    }
    // not editable any more (timed out / pending / paused): stop; the page will show the server's state
    stopped.current = true;
    setStatus("idle");
  }, []);

  useEffect(() => {
    saveAgain.current = () => void save();
  }, [save]);

  const setText = useCallback(
    (v: string) => {
      latest.current = v;
      setTextState(v);
      dirty.current = true;
      if (!editable || conflict) return;
      clearTimer();
      timer.current = setTimeout(() => void save(), DRAFT_DEBOUNCE_MS);
    },
    [editable, conflict, save],
  );

  // flush what is typed when the member leaves the tab or the page (reads the latest flags through a ref, so a change
  // of `editable` or `conflict` never triggers a save of its own)
  const live = useRef({ editable, conflict });
  useEffect(() => {
    live.current = { editable, conflict };
  }, [editable, conflict]);
  useEffect(() => {
    const flush = () => {
      if (dirty.current && live.current.editable && !live.current.conflict) void save();
    };
    const onHide = () => {
      if (document.hidden) flush();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
      flush();
      clearTimer();
    };
  }, [save]);

  const useTheirs = useCallback(() => {
    if (!conflict) return;
    base.current = conflict.version;
    latest.current = conflict.answer;
    setTextState(conflict.answer);
    dirty.current = false;
    setConflict(null);
    setStatus("saved");
  }, [conflict]);

  const keepMine = useCallback(() => {
    if (!conflict) return;
    base.current = conflict.version;
    setConflict(null);
    dirty.current = true;
    void save();
  }, [conflict, save]);

  const pause = useCallback(() => {
    stopped.current = true;
    clearTimer();
  }, []);
  const resume = useCallback(() => {
    stopped.current = false;
  }, []);

  return { text, setText, status, conflict, useTheirs, keepMine, pause, resume };
}
