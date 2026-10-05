import type { NextConfig } from "next";

import { buildSecurityHeaders } from "./src/config/security";

const isDev = process.env.NODE_ENV !== "production";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: buildSecurityHeaders({ isDev }) }];
  },
};

export default nextConfig;
