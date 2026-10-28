import type { MetadataRoute } from "next";

const baseUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://lantern.run";

export default function sitemap(): MetadataRoute.Sitemap {
  const routes = ["", "/compare", "/privacy", "/terms"];

  return routes.map((route) => ({
    url: `${baseUrl}${route}`,
    lastModified: new Date(),
  }));
}

export const dynamic = "force-static";
