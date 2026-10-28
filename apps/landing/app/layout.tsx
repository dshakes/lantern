import type { Metadata } from "next";
import "./globals.css";

const baseUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://lantern.run";
const title = "Lantern: the open-source agent runtime for your own cloud";
const description =
  "Open-source runtime for AI agents that you host in your VPC or on-prem: a Firecracker or Kata microVM sandbox plus durable runs, budgets that return 402, model routing and signed receipts. Apache-2.0.";

export const metadata: Metadata = {
  // Origin only: Next already prefixes file-based og:image URLs with the basePath.
  metadataBase: new URL(new URL(baseUrl).origin),
  title,
  description,
  alternates: { canonical: `${baseUrl}/` },
  // og:image / twitter:image come from app/opengraph-image.tsx + app/twitter-image.tsx.
  openGraph: { title, description, type: "website", url: baseUrl, siteName: "Lantern" },
  twitter: { card: "summary_large_image", title, description },
};

// Runs before paint so an explicit theme choice never flashes the other theme.
const themeScript = `try{var t=localStorage.getItem("lantern-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600..800&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
