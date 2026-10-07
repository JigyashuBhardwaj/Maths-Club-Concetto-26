import { z } from "zod";

import { teamStatusSchema } from "./auth";

/**
 * Request and result shapes of provisioning (docs/API_SPEC.md §5–§6, Patch B12): the Super Admin creates Admins, an
 * Admin creates Teams.
 *
 * Request schemas are STRICT: an unknown field is a 400. There is deliberately no `adminId`, `role`, `coins`, `status`
 * or `isActive` field anywhere: the owner of a team is the authenticated caller, and the role, the initial balance and
 * the account state are decided by the database (SEC-03). The database validates every value again (these rules mirror
 * migration 13) and the unique constraints are the final protection against a race.
 *
 * Result schemas are WHITELISTS (zod strips unknown keys), so a hash or token added to a database result later cannot
 * reach a client by accident.
 */

/** The same shape as a staff username in migration 11 (`provision_superadmin`) and 13. */
export const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,64}$/;
export const TEAM_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/;
export const ADMISSION_NO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/._-]{0,31}$/;

export const ADMIN_PASSWORD_MIN = 10;
export const TEAM_PASSWORD_MIN = 8;
/** bcrypt reads at most 72 BYTES; nothing longer can be right (migration 11). */
export const PASSWORD_MAX_BYTES = 72;
export const TEAM_NAME_MAX = 100;
/** A team has exactly four members, M1–M4, in B12 (all four admission numbers are required). */
export const MEMBER_SLOTS = 4;

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

const passwordWith = (min: number) =>
  z
    .string()
    .min(min)
    .refine((s) => utf8Bytes(s) <= PASSWORD_MAX_BYTES);

/** `POST /api/super/admins` */
export const createAdminSchema = z
  .strictObject({
    username: z.string().trim().regex(USERNAME_PATTERN),
    password: passwordWith(ADMIN_PASSWORD_MIN),
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, { path: ["confirmPassword"] });
export type CreateAdminInput = z.infer<typeof createAdminSchema>;

/**
 * `POST /api/admin/teams`. Field-error paths are `admissionNos.<slot>` with the SLOT 1–4 (the same numbering the
 * database uses), not the array index.
 */
export const createTeamSchema = z
  .strictObject({
    teamCode: z.string().trim().regex(TEAM_CODE_PATTERN),
    name: z
      .string()
      .trim()
      .min(1)
      .max(TEAM_NAME_MAX)
      .refine((s) => !/[\u0000-\u001f\u007f]/.test(s)),
    loginId: z.string().trim().regex(USERNAME_PATTERN),
    password: passwordWith(TEAM_PASSWORD_MIN),
    confirmPassword: z.string(),
    admissionNos: z.array(z.string()).length(MEMBER_SLOTS),
  })
  .superRefine((v, ctx) => {
    if (v.password !== v.confirmPassword) {
      ctx.addIssue({ code: "custom", path: ["confirmPassword"] });
    }
    const pw = v.password.toLowerCase();
    if (pw === v.teamCode.toLowerCase() || pw === v.loginId.toLowerCase()) {
      ctx.addIssue({ code: "custom", path: ["password"] });
    }
    const seen = new Set<string>();
    v.admissionNos.forEach((raw, i) => {
      const normalised = raw.trim().toUpperCase();
      if (!ADMISSION_NO_PATTERN.test(normalised) || seen.has(normalised)) {
        ctx.addIssue({ code: "custom", path: ["admissionNos", String(i + 1)] });
      }
      seen.add(normalised);
    });
  });
export type CreateTeamInput = z.infer<typeof createTeamSchema>;

const epochMs = z.number().int().nonnegative();

/** `create_admin` result. */
export const createAdminResultSchema = z.object({
  replayed: z.boolean(),
  admin: z.object({
    id: z.uuid(),
    username: z.string(),
    role: z.literal("ADMIN"),
    is_active: z.boolean(),
    created_at: epochMs,
  }),
});

const teamRowSchema = z.object({
  id: z.uuid(),
  team_code: z.string(),
  name: z.string(),
  login_id: z.string(),
  status: teamStatusSchema,
  member_count: z.number().int().min(0).max(MEMBER_SLOTS),
  created_at: epochMs,
});
export type AdminTeamRow = z.infer<typeof teamRowSchema>;

/** `create_team` result. */
export const createTeamResultSchema = z.object({
  replayed: z.boolean(),
  team: teamRowSchema.extend({ coins: z.number().int().nonnegative() }),
});

/** `list_admin_teams` result ("My Teams"). */
export const adminTeamsResultSchema = z.object({ teams: z.array(teamRowSchema) });
export type AdminTeamsResult = z.infer<typeof adminTeamsResultSchema>;

/** `get_leaderboard` result: rank, team code and score only. */
export const leaderboardResultSchema = z.object({
  rows: z.array(
    z.object({
      rank: z.number().int().min(1),
      team_id: z.string(),
      score: z.number().int(),
    }),
  ),
});
export type LeaderboardResult = z.infer<typeof leaderboardResultSchema>;
