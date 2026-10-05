import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AppShell } from "@/components/shell/app-shell";

export const metadata: Metadata = {
  title: "Participant",
  robots: { index: false, follow: false },
};

const NAV = [
  { label: "Competition" },
  { label: "Leaderboard" },
  { label: "Previous questions" },
] as const;

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <AppShell role="participant" nav={NAV}>
      {children}
    </AppShell>
  );
}
