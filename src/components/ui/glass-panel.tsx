import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/utils";

/** Frosted-glass surface using the landing page's panel tokens (blur, hairline border, orange glow). */
export function GlassPanel({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        "rounded-panel border border-line bg-glass p-2 shadow-panel backdrop-blur-[22px] backdrop-saturate-[1.25]",
        className,
      )}
      {...props}
    />
  );
}
