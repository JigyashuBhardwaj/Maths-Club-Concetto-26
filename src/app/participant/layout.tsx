import type { Metadata } from "next";
import type { ReactNode } from "react";

import { EntryGate } from "@/components/game/entry-gate";
import { GameBanner } from "@/components/game/game-banner";
import { GameProvider } from "@/components/game/game-provider";
import { requireArea } from "@/lib/auth/guard";
import { loadTeamState } from "@/lib/gameplay/server-data";

export const metadata: Metadata = {
  title: "Escape Room",
  robots: { index: false, follow: false },
};

export default async function Layout({ children }: { children: ReactNode }) {
  const principal = await requireArea("participant");
  // The first paint already carries the authoritative snapshot; the provider keeps it in sync from then on.
  const initial =
    principal.role === "PARTICIPANT"
      ? await loadTeamState(principal.team.id, principal.member.id)
      : null;
  return (
    <GameProvider initial={initial}>
      <GameBanner />
      {children}
      <EntryGate />
    </GameProvider>
  );
}
