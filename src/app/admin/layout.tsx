import type { Metadata } from "next";
import type { ReactNode } from "react";

import { CreateTeamNav } from "@/components/provisioning/create-team-dialog";
import { AppShell } from "@/components/shell/app-shell";
import { requireStaffArea } from "@/lib/auth/guard";

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

export default async function Layout({ children }: { children: ReactNode }) {
  const principal = await requireStaffArea("admin");
  const nav = [
    { label: "Create a team", node: <CreateTeamNav /> },
    { label: "My teams", href: "/admin/teams" },
    { label: "Review queue", href: "/admin/review" },
  ];
  // The bottom line shows the Admin's user ID (the username they sign in with).
  return (
    <AppShell role="admin" nav={nav} userName={principal.staff.username}>
      {children}
    </AppShell>
  );
}
