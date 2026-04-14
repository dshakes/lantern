import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lantern — Serverless Agents, Production Grade",
  description:
    "Ship an AI agent in 60 seconds. Run it on global infrastructure that scales from zero to a million parallel runs. Durable execution, multi-model routing, microVM isolation, and zero ops.",
  openGraph: {
    title: "Lantern — Serverless Agents, Production Grade",
    description:
      "The serverless platform for production AI agents. Any model. Any scale. Zero ops.",
    type: "website",
    url: "https://lantern.run",
  },
  twitter: {
    card: "summary_large_image",
    title: "Lantern — Serverless Agents, Production Grade",
    description:
      "The serverless platform for production AI agents. Any model. Any scale. Zero ops.",
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
          href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
