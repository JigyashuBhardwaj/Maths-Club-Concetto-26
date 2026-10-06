/**
 * Pure geometry for the ticket spiral. Ticket `i` sits at angle `i * STEP + rotation` (degrees)
 * around a vertical axis; angle 0 is the front (closest to the viewer).
 */

import { TOTAL_TICKETS } from "@/lib/contracts/competition";

export const TICKET_COUNT = TOTAL_TICKETS;
export const STEP_DEG = 360 / TICKET_COUNT;

/** Wraps any angle into [-180, 180). */
export function normalizeAngle(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

export function ticketAngle(index: number, rotation: number): number {
  return normalizeAngle(index * STEP_DEG + rotation);
}

/** 1 at the front, 0 at the very back. Used for fading distant tickets. */
export function depth(angleDeg: number): number {
  return (1 + Math.cos((angleDeg * Math.PI) / 180)) / 2;
}

/** Index of the ticket currently closest to the front. */
export function frontIndex(rotation: number, count = TICKET_COUNT): number {
  let best = 0;
  let bestAbs = Infinity;
  for (let i = 0; i < count; i++) {
    const a = Math.abs(ticketAngle(i, rotation));
    if (a < bestAbs) {
      bestAbs = a;
      best = i;
    }
  }
  return best;
}

/** Rotation value (nearest to `current`) that brings ticket `index` to the front. */
export function rotationToFront(index: number, current: number): number {
  const wanted = -index * STEP_DEG;
  return current + normalizeAngle(wanted - current);
}
