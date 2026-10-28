import type { MetadataRoute } from "next";
import { DOCS_URL } from "./_meta";

export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/" }, sitemap: `${DOCS_URL}/sitemap.xml` };
}
