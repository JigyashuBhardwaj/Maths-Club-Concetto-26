import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";

import { getServerEnv } from "@/lib/env/server";

import "./globals.css";

// Self-hosted (no request to Google Fonts): faster first paint and works on restrictive venue networks.
const manrope = localFont({
  src: "../assets/fonts/Manrope-latin-variable.woff2",
  weight: "200 800",
  display: "swap",
  variable: "--font-manrope",
});

// Manrope is a Latin-only subset: Greek letters, sub/superscripts, ₹, arrows and the mathematical operators of the official
// questions come from this small fallback (a DejaVu Sans subset, licence beside it), so they look the same on every device
// instead of depending on whatever the visitor's system happens to have. It is only fetched when such a character is shown.
const mathFallback = localFont({
  src: "../assets/fonts/ConcettoMath-fallback.woff2",
  weight: "400",
  display: "swap",
  preload: false,
  variable: "--font-math",
});

export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(getServerEnv().APP_ORIGIN),
    title: { default: "Mathematics Club Portal", template: "%s · Mathematics Club Portal" },
    description: "Competition portal — Mathematics Club, IIT (ISM) Dhanbad.",
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#050507",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${manrope.variable} ${mathFallback.variable}`}>
      <body>{children}</body>
    </html>
  );
}
