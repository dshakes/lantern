import type { Metadata } from "next";
import { Bricolage_Grotesque, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

// Brand type (docs/brand): Bricolage Grotesque display, IBM Plex Sans text,
// IBM Plex Mono code. Exposed as CSS vars consumed by @theme in globals.css.
const bricolage = Bricolage_Grotesque({ subsets: ["latin"], weight: ["600", "700", "800"], variable: "--font-bricolage", display: "swap" });
const plexSans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-plex-sans", display: "swap" });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono", display: "swap" });

export const metadata: Metadata = {
  title: "PAL Dashboard",
  description: "Manage your AI agents, monitor runs, and control your serverless agent platform.",
};

// This is an auth-gated, fully data-driven dashboard — render every route
// dynamically rather than statically prerendering at build time (which fails
// on client-only APIs like useSearchParams / localStorage during SSG).
export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`dark ${bricolage.variable} ${plexSans.variable} ${plexMono.variable}`} suppressHydrationWarning>
      <head>
        {/* No-flash theme init: set data-theme before paint. Dark is default (light via the toggle). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('lantern-theme')||'dark';document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme='dark';}`,
          }}
        />
      </head>
      <body className="antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
