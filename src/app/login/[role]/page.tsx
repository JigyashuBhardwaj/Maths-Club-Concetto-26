import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

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

/** PLACEHOLDER: proves each landing role routes somewhere. No sign-in form or auth exists yet. */
export default async function LoginPlaceholderPage({ params }: Props) {
  const { role } = await params;
  if (!isRoleId(role)) notFound();
  const { label } = getRole(role);

  return (
    <main className="grid min-h-svh place-items-center p-5">
      <GlassPanel className="w-full max-w-sm p-8 text-center">
        <p className="text-[11px] font-semibold tracking-[0.3em] text-orange uppercase">{label}</p>
        <h1 className="mt-3 text-xl font-semibold text-ink">Sign-in</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-dim">
          Authentication is not implemented yet. This page is a routing placeholder.
        </p>
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
