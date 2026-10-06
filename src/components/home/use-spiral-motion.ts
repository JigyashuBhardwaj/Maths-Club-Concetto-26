"use client";

import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  type WheelEvent,
} from "react";

import { frontIndex, rotationToFront, STEP_DEG, TICKET_COUNT } from "@/lib/home/spiral";

/** Idle drift of the ring, in degrees per second. */
export const AUTO_DEG_PER_S = 5;
const DRAG_THRESHOLD_PX = 5;
const DEG_PER_PX = 0.25;
const WHEEL_GAIN = 0.06;

interface MotionState {
  rot: number;
  vel: number;
  target: number | null;
  /** 1 = full idle drift, 0 = stopped; eased so pauses never jerk. */
  speed: number;
  hover: boolean;
  focus: boolean;
  dragging: boolean;
}

/**
 * Drives the ticket ring. The rotation lives in a ref and is written to the ring element's `--rot`
 * custom property every frame, so React never re-renders while the spiral moves.
 * Auto-rotates slowly; pauses on hover, keyboard focus, drag and while a dialog is open; responds to
 * drag, wheel and arrow keys. With prefers-reduced-motion there is no loop: every change is instant.
 */
export function useSpiralMotion(ringRef: RefObject<HTMLElement | null>, paused: boolean) {
  const state = useRef<MotionState>({
    rot: 0,
    vel: 0,
    target: null,
    speed: 1,
    hover: false,
    focus: false,
    dragging: false,
  });
  const pausedRef = useRef(paused);
  const reducedRef = useRef(false);
  const drag = useRef({ startX: 0, startRot: 0, lastX: 0, lastT: 0, moved: false, active: false });
  const suppressClick = useRef(false);
  const startLoopRef = useRef<() => void>(() => {});

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const apply = useCallback(() => {
    ringRef.current?.style.setProperty("--rot", state.current.rot.toFixed(3));
  }, [ringRef]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    let raf = 0;
    let last = 0;

    const tick = (t: number) => {
      const dt = Math.min(0.05, Math.max(0, (t - last) / 1000));
      last = t;
      const s = state.current;
      if (s.target !== null) {
        const d = s.target - s.rot;
        s.rot += d * (1 - Math.exp(-6 * dt));
        if (Math.abs(d) < 0.05) {
          s.rot = s.target;
          s.target = null;
        }
      } else if (!s.dragging) {
        s.rot += s.vel * dt;
        s.vel *= Math.exp(-3 * dt);
        if (Math.abs(s.vel) < 0.01) s.vel = 0;
        const goal = s.hover || s.focus || pausedRef.current ? 0 : 1;
        s.speed += (goal - s.speed) * (1 - Math.exp(-4 * dt));
        s.rot += AUTO_DEG_PER_S * s.speed * dt;
      }
      apply();
      raf = requestAnimationFrame(tick);
    };

    const start = () => {
      cancelAnimationFrame(raf);
      reducedRef.current = mq.matches;
      if (mq.matches) {
        state.current.target = null;
        state.current.vel = 0;
        apply();
        return;
      }
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };
    startLoopRef.current = start;
    start();
    mq.addEventListener("change", start);
    return () => {
      cancelAnimationFrame(raf);
      mq.removeEventListener("change", start);
    };
  }, [apply]);

  const goTo = useCallback(
    (index: number) => {
      const s = state.current;
      const wanted = rotationToFront(index, s.rot);
      if (reducedRef.current) {
        s.rot = wanted;
        s.target = null;
        apply();
      } else {
        s.target = wanted;
      }
    },
    [apply],
  );

  const onPointerDown = useCallback((e: PointerEvent<HTMLElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const d = drag.current;
    d.active = true;
    d.moved = false;
    d.startX = d.lastX = e.clientX;
    d.startRot = state.current.rot;
    d.lastT = performance.now();
  }, []);

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d.active) return;
      const s = state.current;
      if (!d.moved) {
        if (Math.abs(e.clientX - d.startX) < DRAG_THRESHOLD_PX) return;
        d.moved = true;
        s.dragging = true;
        s.target = null;
        s.vel = 0;
        // Capture only once it is clearly a drag, so a plain click still reaches the ticket button.
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      const now = performance.now();
      const dt = Math.max(1, now - d.lastT) / 1000;
      const nextRot = d.startRot + (e.clientX - d.startX) * DEG_PER_PX;
      s.vel = (nextRot - s.rot) / dt;
      s.rot = nextRot;
      d.lastX = e.clientX;
      d.lastT = now;
      apply();
    },
    [apply],
  );

  const endDrag = useCallback((e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d.active) return;
    d.active = false;
    const s = state.current;
    if (d.moved) {
      s.dragging = false;
      if (performance.now() - d.lastT > 80) s.vel = 0;
      if (reducedRef.current) s.vel = 0;
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      if (e.currentTarget.hasPointerCapture(e.pointerId))
        e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  const onWheel = useCallback(
    (e: WheelEvent<HTMLElement>) => {
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      const s = state.current;
      if (reducedRef.current) {
        s.rot += delta * WHEEL_GAIN * 4;
        apply();
      } else {
        s.target = null;
        s.vel += delta * WHEEL_GAIN * 12;
      }
    },
    [apply],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const cur = frontIndex(state.current.rot);
      let next: number | null = null;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (cur + 1) % TICKET_COUNT;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
        next = (cur - 1 + TICKET_COUNT) % TICKET_COUNT;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = TICKET_COUNT - 1;
      if (next === null) return;
      e.preventDefault();
      goTo(next);
      e.currentTarget
        .querySelector<HTMLElement>(`[data-index="${next}"]`)
        ?.focus({ preventScroll: true });
    },
    [goTo],
  );

  const setHover = useCallback((v: boolean) => {
    state.current.hover = v;
  }, []);

  const onFocusCapture = useCallback(
    (e: React.FocusEvent<HTMLElement>) => {
      const t = e.target as HTMLElement;
      if (!t.matches(":focus-visible")) return;
      state.current.focus = true;
      const idx = Number(t.dataset.index);
      if (Number.isInteger(idx)) goTo(idx);
    },
    [goTo],
  );
  const onBlurCapture = useCallback(() => {
    state.current.focus = false;
  }, []);

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onWheel,
      onKeyDown,
      onPointerEnter: () => setHover(true),
      onPointerLeave: () => setHover(false),
      onFocusCapture,
      onBlurCapture,
    },
    /** True right after a drag ended, so the click that follows it must not open a ticket. */
    consumeDragClick: () => {
      const v = suppressClick.current;
      suppressClick.current = false;
      return v;
    },
    /** Read the current rotation (tests / debugging). */
    getRotation: () => state.current.rot,
    stepDeg: STEP_DEG,
  };
}
