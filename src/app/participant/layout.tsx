import type { Metadata } from "next";
import type { ReactNode } from "react";

import { requireArea } from "@/lib/auth/guard";

export const metadata: Metadata = {
  title: "Escape Room",
  robots: { index: false, follow: false },
};

export default async function Layout({ children }: { children: ReactNode }) {
  await requireArea("participant");
  return children;
}
