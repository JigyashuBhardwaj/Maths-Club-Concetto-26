import "server-only";

import { authDeps } from "@/lib/auth/routes";

import {
  createDeleteAdminsHandler,
  createDeleteTeamsHandler,
  createListDeletableAdminsHandler,
  createListDeletableTeamsHandler,
} from "./handlers";

/** Production wiring: the same lazily created service-role client and validated environment as the auth routes. */
export const listDeletableAdmins = createListDeletableAdminsHandler(authDeps);
export const listDeletableTeams = createListDeletableTeamsHandler(authDeps);
export const deleteAdmins = createDeleteAdminsHandler(authDeps);
export const deleteTeams = createDeleteTeamsHandler(authDeps);
