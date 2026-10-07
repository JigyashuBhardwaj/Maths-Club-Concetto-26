import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { LoginForm } from "@/components/auth/login-form";
import { GlassPanel } from "@/components/ui/glass-panel";
import { getRole, isRoleId, ROLE_IDS } from "@/lib/roles";

export function generateStaticParams() {
  return ROLE_IDS.map((role) => ({ role }));
}

type Props = { params: Promise<{ role: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { role } = await params;
  return {
    title: isRoleId(role) ? `${getRole(role).label} sign-in` : "Sign-in",
    robots: { index: false },
  };
}

/**
 * Sign-in page of one role. Deliberately static: it reads no cookie and calls no API when it loads, so it renders
 * (and the landing page can prefetch it) even when the database is down. Everything dynamic happens in `LoginForm`,
 * which talks to the B9 endpoints; whether someone is allowed anywhere is decided by the protected pages, never here.
 */
export default async function LoginPage({ params }: Props) {
  const { role } = await params;
  if (!isRoleId(role)) notFound();
  const { label } = getRole(role);

  return (
    <main className="grid min-h-svh place-items-center p-5">
      <GlassPanel className="w-full max-w-sm p-8 text-center">
        <p className="text-[11px] font-semibold tracking-[0.3em] text-orange uppercase">{label}</p>
        <h1 className="mt-3 text-xl font-semibold text-ink">Sign-in</h1>
        <LoginForm role={role} />
        <Link
          href="/"
          className="mt-6 inline-block text-xs font-semibold tracking-[0.26em] text-ink-dim uppercase hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-orange/70"
        >
          ← Back
        </Link>
      </GlassPanel>
    </main>
  );
}
