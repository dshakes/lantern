import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lantern — AI Agents for Production",
  description:
    "Build, test, and ship AI agents across Claude, GPT, and Gemini. Open source. Durable execution, multi-model routing, microVM isolation, and zero ops.",
  openGraph: {
    title: "Lantern — AI Agents for Production",
    description:
      "Build, test, and ship AI agents across Claude, GPT, and Gemini. Open source.",
    type: "website",
    url: "https://lantern.run",
  },
  twitter: {
    card: "summary_large_image",
    title: "Lantern — AI Agents for Production",
    description:
      "Build, test, and ship AI agents across Claude, GPT, and Gemini. Open source.",
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
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
