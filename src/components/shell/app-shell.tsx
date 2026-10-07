import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

import { SignOutButton } from "@/components/auth/sign-out-button";
import { NAV_ITEM_CLASS } from "@/components/shell/nav-item-class";
import { getRole, loginPath, type RoleId } from "@/lib/roles";

export interface ShellNavItem {
  label: string;
  /** Present only once the destination exists. Items without it (and without `node`) render as disabled placeholders. */
  href?: string;
  /** A ready-made entry (a client component such as a dialog trigger) rendered in place of the link. */
  node?: ReactNode;
}

interface AppShellProps {
  role: RoleId;
  nav: readonly ShellNavItem[];
  /** Display name of the signed-in staff member (from the server-side session), shown above the sign-out button. */
  userName?: string;
  children: ReactNode;
}

/**
 * Structural frame for the future participant / admin / super-admin interfaces:
 * brand header, role-specific navigation, content area, sign-out. It performs no authorization itself: the layouts
 * that render it call `requireArea` on the server first (B11), so it is only ever rendered for the matching role.
 */
export function AppShell({ role, nav, userName, children }: AppShellProps) {
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
                {item.node ? (
                  item.node
                ) : item.href ? (
                  <Link href={item.href} className={NAV_ITEM_CLASS}>
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
        <div className="mt-auto grid gap-3">
          {userName ? (
            <p className="text-xs text-ink-dim">
              Signed in as <span className="font-semibold text-ink">{userName}</span>
            </p>
          ) : null}
          <SignOutButton redirectTo={loginPath(role)} />
        </div>
      </aside>
      <main className="flex-1 p-6 md:p-10">{children}</main>
    </div>
  );
}
