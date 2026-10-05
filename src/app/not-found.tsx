import Link from "next/link";

import { GlassPanel } from "@/components/ui/glass-panel";

export default function NotFound() {
  return (
    <main className="grid min-h-svh place-items-center p-5">
      <GlassPanel className="w-full max-w-sm p-8 text-center">
        <p className="text-[11px] font-semibold tracking-[0.3em] text-orange uppercase">404</p>
        <h1 className="mt-3 text-xl font-semibold text-ink">Page not found</h1>
        <Link
          href="/"
          className="mt-6 inline-block text-xs font-semibold tracking-[0.26em] text-ink-dim uppercase hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-orange/70"
        >
          ← Back to portal
        </Link>
      </GlassPanel>
    </main>
  );
}
