import type { NextConfig } from "next";

// The docs site is pure static prose (no API routes, no server components, no
// next/image), so it ships as a fully static export deployable to GitHub Pages.
//
// basePath/assetPrefix are env-driven so `npm run dev` works at the root while the
// Pages deploy serves under the project subpath. The deploy workflow sets
// PAGES_BASE_PATH=/lantern (repo = github.com/dshakes/lantern → dshakes.github.io/lantern).
// For a custom domain, leave PAGES_BASE_PATH unset.
const basePath = process.env.PAGES_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  output: "export",
  basePath: basePath || undefined,
  assetPrefix: basePath || undefined,
  trailingSlash: true, // emit dir/index.html so deep links resolve on static hosts
  images: { unoptimized: true }, // no Image Optimization server in a static export
};

export default nextConfig;
