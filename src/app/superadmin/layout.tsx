import type { Metadata } from "next";
import type { ReactNode } from "react";

import { CreateAdminNav } from "@/components/provisioning/create-admin-dialog";
import { AppShell } from "@/components/shell/app-shell";
import { requireStaffArea } from "@/lib/auth/guard";

export const metadata: Metadata = {
  title: "Superadmin",
  robots: { index: false, follow: false },
};

export default async function Layout({ children }: { children: ReactNode }) {
  const principal = await requireStaffArea("superadmin");
  const nav = [{ label: "Create admin", node: <CreateAdminNav /> }];
  return (
    <AppShell role="superadmin" nav={nav} userName={principal.staff.name}>
      {children}
    </AppShell>
  );
}
