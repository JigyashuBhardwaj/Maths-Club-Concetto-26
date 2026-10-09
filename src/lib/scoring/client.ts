/**
 * Browser-side calls of the scoring API (Phase B16): the participant leaderboard (view only) and the Admin's UFM penalty.
 * Same rules as the other clients: the session is the HttpOnly cookie, nothing is persisted in the browser (no
 * localStorage / sessionStorage), every number on screen comes back from the server, and every function returns a result
 * instead of throwing. The caller owns the `Idempotency-Key` of the penalty: one per user intent, reused on a retry.
 */
import {
  participantBoardSchema,
  penalizeResultSchema,
  type ParticipantBoard,
  type PenalizeResult,
} from "@/lib/contracts/scoring";
import { call, checked, type CallResult } from "@/lib/gameplay/client";
import type { LeaderboardSnapshot, LeaderboardSource } from "@/lib/home/leaderboard";

/** `GET /api/p/leaderboard` — the ranking the database computed, and this team's own line from the same snapshot. */
export async function fetchParticipantBoard(
  fetchImpl?: typeof fetch,
): Promise<CallResult<ParticipantBoard>> {
  return checked(await call("GET", "/api/p/leaderboard", { fetchImpl }), (d) => {
    const p = participantBoardSchema.safeParse(d);
    return p.success ? p.data : null;
  });
}

/** The production source of the participant board: server ranks as they are (no re-sorting), failures throw. */
export const participantBoardSource: LeaderboardSource = async (): Promise<LeaderboardSnapshot> => {
  const r = await fetchParticipantBoard();
  if (!r.ok) throw new Error(r.code);
  return {
    rows: r.data.rows.map((row) => ({ rank: row.rank, teamId: row.team_id, score: row.score })),
    me: r.data.me
      ? { rank: r.data.me.rank, teamId: r.data.me.team_id, score: r.data.me.score }
      : null,
  };
};

/** `POST /api/admin/teams/:teamId/penalize` — the dialog's "Yes". Official score 0 + frozen; history is kept. */
export async function penalizeTeamCall(
  teamId: string,
  opts: { key: string; fetchImpl?: typeof fetch },
): Promise<CallResult<Omit<PenalizeResult, "replayed">>> {
  const r = await call("POST", `/api/admin/teams/${encodeURIComponent(teamId)}/penalize`, {
    body: { confirm: true },
    key: opts.key,
    fetchImpl: opts.fetchImpl,
  });
  return checked(r, (d) => {
    const p = penalizeResultSchema.omit({ replayed: true }).safeParse(d);
    return p.success ? p.data : null;
  });
}
