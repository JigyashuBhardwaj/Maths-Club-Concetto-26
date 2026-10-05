import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-3 rounded-row border font-semibold uppercase",
    "tracking-[0.26em] transition-[background,border-color,box-shadow,transform] duration-[350ms]",
    "ease-portal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange/70",
    "active:scale-[0.985] disabled:pointer-events-none disabled:opacity-50",
  ],
  {
    variants: {
      variant: {
        // Same treatment as a landing role row in its hover state.
        primary:
          "border-[rgb(255_130_60/0.32)] bg-gradient-to-r from-orange/15 to-orange/5 text-ink shadow-[0_0_28px_-8px_rgb(255_106_26/0.55)] hover:border-[rgb(255_130_60/0.5)]",
        ghost: "border-transparent text-ink-dim hover:border-line hover:text-ink",
      },
      size: {
        md: "h-12 px-5 text-xs",
        lg: "h-14 px-6 text-[13px]",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export type ButtonProps = ComponentPropsWithoutRef<"button"> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return (
    <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
}
