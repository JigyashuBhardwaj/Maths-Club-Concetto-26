# Visual foundation

Source of truth: the supplied _Mathematics Club Portal_ landing page. It was ported, not redesigned.

## Tokens (`src/styles/tokens.css`)

bg `#050507` · orange `#ff6a1a` (soft `rgb(255 106 26 / .55)`) · ink `#f4eee8` (dim `/ .62`) · glass `rgb(16 16 22 / .46)` ·
line `rgb(255 255 255 / .09)` · ease `cubic-bezier(.22,.8,.24,1)` · panel radius 18px · row radius 12px · Manrope.

## Where things live

- `components/landing/landing.css` — the prototype's CSS with values unchanged, scoped under `.landing-stage`.
- `lib/webgl/liquid-background.ts` — the prototype's shader and render loop unchanged (0.62 scale, 0.5 ≤ 640px,
  pointer parallax, pause on hidden tab, static frame at t=14 under reduced motion, CSS fallback on failure).
- Logos: `public/brand/*.webp` (pre-optimised from the supplied images), served as-is.
- Font: self-hosted Manrope variable (latin subset, SIL OFL; licence in `src/assets/fonts`).

## Intentional differences from the prototype

1. Roles are real routes (`/login/<role>`) instead of `#/login/<role>` hash links.
2. Logos are downscaled WebP (480/320 px wide) rather than the original PNGs; visually the same at displayed size
   (max 156 CSS px).
3. Font is self-hosted instead of Google Fonts (Latin subset only).
4. Parallax variables are set on the stage element instead of `<html>`.
5. Canvas is hidden via `[data-fallback]` rather than removed from the DOM (React owns the node).

Measured against the prototype (same fonts, reduced motion, software WebGL): mean absolute pixel difference
0.1–0.5 / 255 across 1440×900, 1280×720, 820×1180, 390×844 and 844×390; remaining difference is image resampling.
