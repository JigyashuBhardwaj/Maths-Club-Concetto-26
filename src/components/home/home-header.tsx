"use client";

import { useGame, useServerNow } from "@/components/game/game-provider";
import { formatDuration } from "@/lib/home/format";
import { teamRemainingSeconds } from "@/lib/gameplay/derive";

import { CoinsIcon, HourglassIcon } from "./icons";
import { LogoBadges } from "./logo-badges";
import { RulesButton } from "./rules-dialog";

/** The team timer and the coin balance, both from the server snapshot (the timer counts down to the server deadline). */
export function HomeHeader() {
  const { state } = useGame();
  const now = useServerNow();
  const timeLeftSeconds = state ? teamRemainingSeconds(state, now) : null;
  const coinsLeft = state?.team.coins ?? null;
  return (
    <header className="home-header">
      <LogoBadges />
      <div className="home-heading">
        <h1 className="home-title">WELCOME TO THE ESCAPE ROOM ISMites</h1>
        <div className="home-stats">
          <div className="stat">
            <HourglassIcon className="stat-icon stat-icon-hourglass" />
            <span className="stat-text">
              <span className="stat-label">time left</span>
              <span className="stat-value">
                {timeLeftSeconds === null ? "--:--:--" : formatDuration(timeLeftSeconds)}
              </span>
            </span>
          </div>
          <div className="stat">
            <CoinsIcon className="stat-icon stat-icon-coins" />
            <span className="stat-text">
              <span className="stat-label">coins left</span>
              <span className="stat-value">{coinsLeft ?? "—"}</span>
            </span>
          </div>
          <RulesButton />
        </div>
      </div>
    </header>
  );
}
