import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AppShell } from "@/components/shell/app-shell";

export const metadata: Metadata = {
  title: "Superadmin",
  robots: { index: false, follow: false },
};

const NAV = [{ label: "Overview" }, { label: "Admins and teams" }, { label: "Audit log" }] as const;

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <AppShell role="superadmin" nav={NAV}>
      {children}
    </AppShell>
  );
}
