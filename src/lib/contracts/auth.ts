import { z } from "zod";

import type { TeamStatus } from "./competition";

/**
 * Request and result shapes for the authentication endpoints (docs/API_SPEC.md §3). Request schemas are strict:
 * an unknown field is a 400, because no endpoint may accept a client-supplied role, team, score or time (SEC-03).
 * Lengths mirror the database: bcrypt reads at most 72 bytes of a password, so nothing longer can be right.
 */
export const participantLoginSchema = z.strictObject({
  teamLoginId: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(72),
  admissionNo: z.string().trim().min(1).max(32),
});
export type ParticipantLoginInput = z.infer<typeof participantLoginSchema>;

export const staffLoginSchema = z.strictObject({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(72),
});
export type StaffLoginInput = z.infer<typeof staffLoginSchema>;

export const teamStatusSchema = z.enum([
  "NOT_STARTED",
  "RUNNING",
  "FINAL_SUBMITTED",
  "ENDED",
  "DISQUALIFIED",
]);

const sessionSchema = z.object({ id: z.uuid(), expires_at: z.string() });

/** What `resolve_session`, `participant_login` and `staff_login` return on success. */
export const dbPrincipalSchema = z.discriminatedUnion("role", [
  z.object({
    ok: z.literal(true),
    role: z.literal("PARTICIPANT"),
    session: sessionSchema,
    member: z.object({ id: z.uuid(), slot: z.number().int().min(1).max(4) }),
    team: z.object({
      id: z.uuid(),
      code: z.string(),
      name: z.string(),
      status: teamStatusSchema,
    }),
  }),
  z.object({
    ok: z.literal(true),
    role: z.literal("ADMIN"),
    session: sessionSchema,
    staff: z.object({ id: z.uuid(), username: z.string(), display_name: z.string() }),
  }),
  z.object({
    ok: z.literal(true),
    role: z.literal("SUPER_ADMIN"),
    session: sessionSchema,
    staff: z.object({ id: z.uuid(), username: z.string(), display_name: z.string() }),
  }),
]);

export const dbFailureSchema = z.object({
  ok: z.literal(false),
  code: z.string(),
  retry_after_seconds: z.number().optional(),
});

/** `data` of a successful login / `GET /api/auth/me`. Never contains a password, hash, token or admission number. */
export type AuthPrincipalData =
  | {
      role: "PARTICIPANT";
      member: { id: string; slot: number };
      team: { id: string; code: string; name: string; status: TeamStatus };
      session: { expires_at: number };
    }
  | {
      role: "ADMIN" | "SUPER_ADMIN";
      staff: { id: string; name: string };
      session: { expires_at: number };
    };
