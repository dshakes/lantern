import type { NextConfig } from "next";

// Static export, like apps/docs: the Pages deploy serves this at the site root
// (PAGES_BASE_PATH=/lantern) and the docs under /lantern/docs. Unset = served at /.
const basePath = process.env.PAGES_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  output: "export",
  basePath: basePath || undefined,
  assetPrefix: basePath || undefined,
  trailingSlash: true, // emit dir/index.html so deep links resolve on static hosts
  images: { unoptimized: true },
  // Plain <a>/<video> URLs are not basePath-prefixed by Next; components read this.
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
};

export default nextConfig;
