"use client";

import { Button } from "@/components/ui/button";
import { GlassPanel } from "@/components/ui/glass-panel";

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="grid min-h-svh place-items-center p-5">
      <GlassPanel className="w-full max-w-sm p-8 text-center">
        <h1 className="text-xl font-semibold text-ink">Something went wrong</h1>
        <p className="mt-3 text-sm text-ink-dim">Please try again.</p>
        <Button className="mt-6" onClick={reset}>
          Retry
        </Button>
      </GlassPanel>
    </main>
  );
}
