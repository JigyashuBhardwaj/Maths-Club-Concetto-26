/**
 * HTTP security headers, kept in plain TypeScript so they can be unit tested
 * and imported (relatively) from next.config.ts.
 *
 * CSP note: Next.js injects small inline scripts for hydration, so this policy
 * allows 'unsafe-inline' for scripts. A nonce-based policy needs per-request
 * dynamic rendering and is deliberately deferred until the authenticated
 * (already dynamic) pages exist. Everything else is locked down.
 *
 * When Supabase is introduced, extend `connect-src` with its https:// and wss://
 * origins (derived from NEXT_PUBLIC_SUPABASE_URL) in that patch.
 */

export interface SecurityHeader {
  key: string;
  value: string;
}

export function buildContentSecurityPolicy({ isDev }: { isDev: boolean }): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'unsafe-inline'", ...(isDev ? ["'unsafe-eval'"] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'"],
    "connect-src": ["'self'"],
    "media-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };

  const policy = Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");

  return isDev ? policy : `${policy}; upgrade-insecure-requests`;
}

export function buildSecurityHeaders({ isDev }: { isDev: boolean }): SecurityHeader[] {
  return [
    { key: "Content-Security-Policy", value: buildContentSecurityPolicy({ isDev }) },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "same-origin" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    // fullscreen is required by the competition rules; everything else is off.
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=(self)",
    },
    // Browsers ignore HSTS over plain http (localhost), so this is safe in every environment.
    { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  ];
}
