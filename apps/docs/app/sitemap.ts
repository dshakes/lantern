import type { MetadataRoute } from "next";
import { DOCS_URL, PAGES } from "./_meta";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return Object.keys(PAGES).map((r) => ({ url: `${DOCS_URL}${r === "/" ? "/" : r + "/"}` }));
}
