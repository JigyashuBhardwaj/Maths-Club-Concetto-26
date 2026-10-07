import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { requireArea } from "@/lib/auth/guard";

export const metadata: Metadata = {
  title: "Superadmin",
  robots: { index: false, follow: false },
};

const NAV = [{ label: "Overview" }, { label: "Admins and teams" }, { label: "Audit log" }] as const;

export default async function Layout({ children }: { children: ReactNode }) {
  const principal = await requireArea("superadmin");
  const userName = principal.role === "PARTICIPANT" ? undefined : principal.staff.name;
  return (
    <AppShell role="superadmin" nav={NAV} userName={userName}>
      {children}
    </AppShell>
  );
}
