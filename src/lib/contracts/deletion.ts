import { z } from "zod";

import { teamStatusSchema } from "./auth";

/**
 * Request and result shapes of the Super Admin's permanent deletion of Admins and Teams (Patch B18, migration 20).
 *
 * Request schemas are STRICT and carry ids only: no role, no staff id, no owner, no count. Who is asking is the verified
 * session; what may be deleted is decided by the database inside its transaction. A selection is 1–100 DISTINCT ids
 * (the same limits the database enforces again).
 *
 * Result schemas are WHITELISTS (zod strips unknown keys): a hash or a token added to a database result later cannot
 * reach the browser by accident. They carry the identifying text a person needs to pick a row, and nothing secret.
 */

/** The most records one request may delete (one transaction). The database enforces the same number. */
export const MAX_DELETE_SELECTION = 100;

/** Any 8-4-4-4-12 hex id (the database is the judge of what exists); normalised to lower case. */
const idSchema = z.guid().transform((s) => s.toLowerCase());

const selection = z
  .array(idSchema)
  .min(1)
  .max(MAX_DELETE_SELECTION)
  .refine((ids) => new Set(ids).size === ids.length, { message: "duplicate ids" });

/** `POST /api/super/admins/delete` */
export const deleteAdminsSchema = z.strictObject({ adminIds: selection });
export type DeleteAdminsInput = z.infer<typeof deleteAdminsSchema>;

/** `POST /api/super/teams/delete` */
export const deleteTeamsSchema = z.strictObject({ teamIds: selection });
export type DeleteTeamsInput = z.infer<typeof deleteTeamsSchema>;

const epochMs = z.number().int().nonnegative();

/** `GET /api/super/admins` (`list_deletable_admins`): every ADMIN, never the Super Admin. */
export const deletableAdminSchema = z.object({
  id: z.uuid(),
  username: z.string(),
  is_active: z.boolean(),
  team_count: z.number().int().nonnegative(),
  created_at: epochMs,
});
export const deletableAdminsResultSchema = z.object({ admins: z.array(deletableAdminSchema) });
export type DeletableAdmin = z.infer<typeof deletableAdminSchema>;

/** `GET /api/super/teams` (`list_deletable_teams`): every team of every admin. */
export const deletableTeamSchema = z.object({
  id: z.uuid(),
  team_code: z.string(),
  name: z.string(),
  login_id: z.string(),
  status: teamStatusSchema,
  admin_username: z.string(),
  member_count: z.number().int().min(0).max(4),
  created_at: epochMs,
});
export const deletableTeamsResultSchema = z.object({ teams: z.array(deletableTeamSchema) });
export type DeletableTeam = z.infer<typeof deletableTeamSchema>;

/** `delete_admins` result: how many went, and which ids (never anything else). */
export const deleteAdminsResultSchema = z.object({
  replayed: z.boolean(),
  deleted: z.object({
    admins: z.number().int().nonnegative(),
    teams: z.number().int().nonnegative(),
  }),
  admin_ids: z.array(z.uuid()),
});
export type DeleteAdminsResult = z.infer<typeof deleteAdminsResultSchema>;

/** `delete_teams` result. */
export const deleteTeamsResultSchema = z.object({
  replayed: z.boolean(),
  deleted: z.object({ teams: z.number().int().nonnegative() }),
  team_ids: z.array(z.uuid()),
});
export type DeleteTeamsResult = z.infer<typeof deleteTeamsResultSchema>;
