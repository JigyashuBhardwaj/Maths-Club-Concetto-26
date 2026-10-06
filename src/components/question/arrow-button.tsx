import Link from "next/link";

import { cn } from "@/lib/utils";
import { ArrowIcon } from "@/components/home/icons";

interface ArrowButtonProps {
  direction: "back" | "next";
  label: string;
  /** Link target; omit (or set `disabled`) for a locked/unavailable arrow. */
  href?: string;
  disabled?: boolean;
  className?: string;
}

/** Round navigation arrow. When unavailable it is a real disabled button, never a dead link. */
export function ArrowButton({ direction, label, href, disabled, className }: ArrowButtonProps) {
  const cls = cn("q-arrow", direction === "back" ? "q-arrow-back" : "q-arrow-next", className);
  if (disabled || !href) {
    return (
      <button type="button" className={cls} disabled aria-label={label}>
        <ArrowIcon className="q-arrow-icon" />
      </button>
    );
  }
  return (
    <Link href={href} className={cls} aria-label={label}>
      <ArrowIcon className="q-arrow-icon" />
    </Link>
  );
}
