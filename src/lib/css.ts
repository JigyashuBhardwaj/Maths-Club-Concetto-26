import type { CSSProperties } from "react";

type CssVarName = `--${string}`;

/** Type-safe inline custom properties, e.g. `style={cssVars({ "--rd": "0.5s" })}`. */
export function cssVars(vars: Record<CssVarName, string | number>): CSSProperties {
  return vars as CSSProperties;
}
