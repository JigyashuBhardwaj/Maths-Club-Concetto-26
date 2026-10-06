import { MOCK_COINS_LEFT, MOCK_TEAM, MOCK_TIME_LEFT_SECONDS } from "@/lib/home/mock";

import { HomeHeader } from "./home-header";
import { HomeStage } from "./home-stage";
import { Leaderboard } from "./leaderboard";
import { TicketSpiral } from "./ticket-spiral";

/**
 * Participant home page (UI foundation). All numbers shown here are static DEMO DATA from the
 * supplied layout mock-up; nothing ticks, persists or talks to a server yet.
 */
export function ParticipantHome() {
  return (
    <HomeStage>
      <div className="home-layout">
        <main className="home-main">
          <HomeHeader timeLeftSeconds={MOCK_TIME_LEFT_SECONDS} coinsLeft={MOCK_COINS_LEFT} />
          <TicketSpiral />
        </main>
        <Leaderboard me={MOCK_TEAM} />
      </div>
    </HomeStage>
  );
}
