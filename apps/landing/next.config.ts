import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // The runtime story now lives on the home page.
  async redirects() {
    return [{ source: "/runtime", destination: "/#lifecycle", permanent: true }];
  },
};

export default nextConfig;
