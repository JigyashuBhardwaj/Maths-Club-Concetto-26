import "server-only";

import { authDeps } from "@/lib/auth/routes";

import {
  createCreateAdminHandler,
  createCreateTeamHandler,
  createLeaderboardHandler,
  createListTeamsHandler,
} from "./handlers";

/** Production wiring: the same lazily created service-role client and validated environment as the auth routes. */
export const createAdmin = createCreateAdminHandler(authDeps);
export const createTeam = createCreateTeamHandler(authDeps);
export const listTeams = createListTeamsHandler(authDeps);
export const leaderboard = createLeaderboardHandler(authDeps);
