import "./globals.css";
import type { Metadata, Viewport } from "next";
import { Shell } from "./_components/Shell";

// Runs before paint so an explicit theme choice never flashes the other theme.
const themeScript = `try{var t=localStorage.getItem("lantern-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

// Per-page metadata comes from each page's `pageMeta(route)` (see _meta.ts); this is the fallback.
export const metadata: Metadata = {
  title: { default: "Lantern Docs", template: "%s — Lantern Docs" },
  description: "Documentation for the Lantern AI agent platform.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600..800&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
      </head>
      <body className="antialiased">
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
