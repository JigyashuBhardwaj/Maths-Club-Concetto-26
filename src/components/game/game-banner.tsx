"use client";

import { useGame } from "./game-provider";

/** A thin status line above the page: connection trouble and the states in which the clocks are not running. */
export function GameBanner() {
  const { state, reconnecting, loadFailed, refresh } = useGame();
  let text: string | null = null;
  if (loadFailed) text = "Can't load your team right now.";
  else if (reconnecting) text = "Reconnecting… what you see may be a few seconds old.";
  else if (state?.team.status === "RUNNING" && state.competition.status === "PAUSED")
    text = "The competition is paused. All timers are stopped.";
  else if (state?.team.status === "RUNNING" && state.competition.status === "ENDED")
    text = "The competition has ended.";
  else if (state?.team.status === "ENDED") text = "Your team's time is up.";
  else if (state?.team.status === "FINAL_SUBMITTED")
    text = "Your team has made its final submission.";
  else if (state?.team.status === "DISQUALIFIED") text = "Your team has been disqualified.";
  if (!text) return null;
  return (
    <div className="game-banner" role="status">
      <span>{text}</span>
      {loadFailed ? (
        <button type="button" className="game-banner-retry" onClick={() => void refresh()}>
          Retry
        </button>
      ) : null}
    </div>
  );
}
