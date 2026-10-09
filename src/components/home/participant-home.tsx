"use client";

import { SignOutButton } from "@/components/auth/sign-out-button";
import { useGame } from "@/components/game/game-provider";

import { participantBoardSource } from "@/lib/scoring/client";

import { HomeHeader } from "./home-header";
import { HomeStage } from "./home-stage";
import { Leaderboard } from "./leaderboard";
import { TicketSpiral } from "./ticket-spiral";

/**
 * Participant home page. The time left, the coins and which themes are unlocked all come from the authoritative
 * snapshot of the signed-in team (`GameProvider`, fed by `GET /api/p/state`); nothing here is computed from local
 * state. The leaderboard (rank, Team ID, score of every team, plus this team's own line) is the server's ranking from
 * `GET /api/p/leaderboard`; it is view-only, and it refreshes when this team's state version changes.
 */
export function ParticipantHome() {
  const { state } = useGame();
  return (
    <HomeStage>
      <SignOutButton redirectTo="/login/participant" className="home-signout" />
      <div className="home-layout">
        <main className="home-main" aria-busy={state === null}>
          <HomeHeader />
          <TicketSpiral />
        </main>
        <Leaderboard
          me={{ rank: null, teamId: state?.me.team_code ?? "—", score: null }}
          source={participantBoardSource}
          refreshKey={state?.state_version ?? null}
        />
      </div>
    </HomeStage>
  );
}
