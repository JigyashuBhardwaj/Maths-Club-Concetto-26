import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

import { getRole, type RoleId } from "@/lib/roles";

export interface ShellNavItem {
  label: string;
  /** Present only once the destination exists. Items without it render as disabled placeholders. */
  href?: string;
}

interface AppShellProps {
  role: RoleId;
  nav: readonly ShellNavItem[];
  children: ReactNode;
}

/**
 * Structural frame for the future participant / admin / super-admin interfaces:
 * brand header, role-specific navigation, content area. PLACEHOLDER — it performs no
 * authentication or authorization; a later patch must guard these routes server-side.
 */
export function AppShell({ role, nav, children }: AppShellProps) {
  const { label } = getRole(role);

  return (
    <div className="flex min-h-svh flex-col bg-bg md:flex-row">
      <aside className="flex shrink-0 flex-col gap-6 border-b border-line p-5 md:w-64 md:border-r md:border-b-0">
        <Link href="/" className="flex items-center gap-3" aria-label="Back to portal home">
          <Image src="/brand/event-mark.webp" alt="" width={36} height={37} unoptimized />
          <span className="text-xs font-semibold tracking-[0.3em] text-ink uppercase">{label}</span>
        </Link>
        <nav aria-label={`${label} navigation`}>
          <ul className="grid gap-1">
            {nav.map((item) => (
              <li key={item.label}>
                {item.href ? (
                  <Link
                    href={item.href}
                    className="block rounded-row px-3 py-2.5 text-sm text-ink-dim hover:text-ink"
                  >
                    {item.label}
                  </Link>
                ) : (
                  <span
                    aria-disabled="true"
                    className="block cursor-not-allowed rounded-row px-3 py-2.5 text-sm text-ink-dim/50"
                  >
                    {item.label}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <main className="flex-1 p-6 md:p-10">{children}</main>
    </div>
  );
}
