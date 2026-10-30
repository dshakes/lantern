import type { NextConfig } from "next";

// Pin the trace root to this app. Without it, Next infers the root from the
// highest lockfile it finds, and a stray ~/package-lock.json on the host moved the
// standalone server to .next/standalone/<path>/server.js. The launchd wrapper and
// the Docker image both start .next/standalone/server.js, so the dashboard
// built cleanly and then crash-looped.

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: __dirname,
  async rewrites() {
    return [
      {
        source: "/api/proxy/:path*",
        destination: `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080"}/:path*`,
      },
    ];
  },
};

export default nextConfig;
