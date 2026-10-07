import type { ReactNode } from "react";

import { StaffLeaderboard } from "@/components/provisioning/staff-leaderboard";
import { GlassPanel } from "@/components/ui/glass-panel";
import type { LeaderboardResult } from "@/lib/contracts/provisioning";

interface StaffHomeProps {
  title: string;
  description: string;
  rows: LeaderboardResult["rows"] | null;
  children?: ReactNode;
}

/** The Admin / Super Admin home: the existing glass card on the left and the live leaderboard on the right. */
export function StaffHome({ title, description, rows, children }: StaffHomeProps) {
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(300px,28.7%)]">
      <GlassPanel className="max-w-xl p-8">
        <h1 className="text-2xl font-semibold text-ink">{title}</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-dim">{description}</p>
        {children}
      </GlassPanel>
      <div className="lg:sticky lg:top-6 lg:h-[calc(100svh-3rem)] md:lg:top-10">
        <StaffLeaderboard initialRows={rows} />
      </div>
    </div>
  );
}
