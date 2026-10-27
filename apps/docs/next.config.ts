import type { NextConfig } from "next";

// The docs site is pure static prose (no API routes, no server components, no
// next/image), so it ships as a fully static export deployable to GitHub Pages.
//
// basePath/assetPrefix are env-driven so `npm run dev` works at the root while the
// Pages deploy serves under the project subpath. The deploy workflow sets
// PAGES_BASE_PATH=/lantern/docs: the landing page (apps/landing) owns
// dshakes.github.io/lantern/ and the docs live under it at /lantern/docs/.
// For a custom domain, leave PAGES_BASE_PATH unset.
const basePath = process.env.PAGES_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  output: "export",
  basePath: basePath || undefined,
  assetPrefix: basePath || undefined,
  trailingSlash: true, // emit dir/index.html so deep links resolve on static hosts
  images: { unoptimized: true }, // no Image Optimization server in a static export
  // The landing page is a separate app one level up (/lantern/docs -> /lantern/).
  env: { NEXT_PUBLIC_HOME_URL: process.env.LANTERN_HOME_URL ?? `${basePath.replace(/\/docs$/, "")}/` },
};

export default nextConfig;
