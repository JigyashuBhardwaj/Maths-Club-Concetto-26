import { formatDuration } from "@/lib/home/format";

import { CoinsIcon, HourglassIcon } from "./icons";
import { LogoBadges } from "./logo-badges";
import { RulesButton } from "./rules-dialog";

interface HomeHeaderProps {
  /** Static for now: the timer is not running in the background yet. */
  timeLeftSeconds: number;
  coinsLeft: number;
}

export function HomeHeader({ timeLeftSeconds, coinsLeft }: HomeHeaderProps) {
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
              <span className="stat-value">{formatDuration(timeLeftSeconds)}</span>
            </span>
          </div>
          <div className="stat">
            <CoinsIcon className="stat-icon stat-icon-coins" />
            <span className="stat-text">
              <span className="stat-label">coins left</span>
              <span className="stat-value">{coinsLeft}</span>
            </span>
          </div>
          <RulesButton />
        </div>
      </div>
    </header>
  );
}
