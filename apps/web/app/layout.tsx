import type { Metadata } from "next";
import { THEME_INIT_SCRIPT } from "@/lib/theme-init-script";
import { Inter, Inter_Tight, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

// Brand type (docs/brand): Inter Tight display, Inter text, JetBrains Mono code.
// Exposed as CSS vars consumed by @theme in globals.css.
const interTight = Inter_Tight({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-inter-tight", display: "swap" });
const inter = Inter({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-inter", display: "swap" });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-jetbrains", display: "swap" });

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
    <html lang="en" className={`dark ${interTight.variable} ${inter.variable} ${jetbrains.variable}`} suppressHydrationWarning>
      <head>
        {/* No-flash theme init: set data-theme before paint. Dark is default (light via the toggle). */}
        <script
          dangerouslySetInnerHTML={{
            __html: THEME_INIT_SCRIPT,
          }}
        />
      </head>
      <body className="antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
