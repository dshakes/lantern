import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lantern — Production AI agents with predictable cost",
  description:
    "Forecast run cost before dispatch. Catch eval regressions in CI. Deploy in your own VPC. Open-source, Apache 2.0, provider-agnostic.",
  openGraph: {
    title: "Lantern — Production AI agents with predictable cost",
    description:
      "Forecast cost, catch regressions in CI, deploy in your VPC. Open source.",
    type: "website",
    url: "https://lantern.run",
  },
  twitter: {
    card: "summary_large_image",
    title: "Lantern — Production AI agents with predictable cost",
    description:
      "Forecast cost, catch regressions in CI, deploy in your VPC. Open source.",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap"
          rel="stylesheet"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
