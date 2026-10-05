import { GlassPanel } from "@/components/ui/glass-panel";

/** Honest "not built yet" content for shell routes. Never implies working functionality. */
export function PlaceholderPage({ title, description }: { title: string; description: string }) {
  return (
    <GlassPanel className="max-w-xl p-8">
      <p className="text-[11px] font-semibold tracking-[0.3em] text-orange uppercase">
        Placeholder
      </p>
      <h1 className="mt-3 text-2xl font-semibold text-ink">{title}</h1>
      <p className="mt-3 text-sm leading-relaxed text-ink-dim">{description}</p>
    </GlassPanel>
  );
}
