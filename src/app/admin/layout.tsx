import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { requireArea } from "@/lib/auth/guard";

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

const NAV = [{ label: "My teams" }, { label: "Review queue" }, { label: "Hints" }] as const;

export default async function Layout({ children }: { children: ReactNode }) {
  const principal = await requireArea("admin");
  const userName = principal.role === "PARTICIPANT" ? undefined : principal.staff.name;
  return (
    <AppShell role="admin" nav={NAV} userName={userName}>
      {children}
    </AppShell>
  );
}
