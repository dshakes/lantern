import { ImageResponse } from "next/og";

// Native Next.js file convention: generates the 1200x630 social card at build
// time and auto-injects the og:image meta tags — no static binary asset to keep
// in sync with the brand. Colors mirror app/globals.css.
export const alt =
  "Lantern — Production AI agents with predictable cost";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#060609",
          padding: "80px",
          fontFamily: "sans-serif",
          // Brand glow, top-left teal fading out.
          backgroundImage:
            "radial-gradient(ellipse 900px 600px at 15% 0%, rgba(45,212,191,0.16), transparent 60%), radial-gradient(ellipse 700px 500px at 100% 100%, rgba(129,140,248,0.12), transparent 60%)",
        }}
      >
        {/* Wordmark — the diamond is a rotated square (no glyph/font dependency) */}
        <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
          <div
            style={{
              width: 30,
              height: 30,
              background: "#2dd4bf",
              transform: "rotate(45deg)",
              borderRadius: 4,
            }}
          />
          <div style={{ fontSize: 36, color: "#f0f0f5", fontWeight: 600 }}>
            lantern
          </div>
        </div>

        {/* Headline + subhead */}
        <div style={{ display: "flex", flexDirection: "column", gap: "28px" }}>
          <div
            style={{
              display: "flex",
              fontSize: 74,
              lineHeight: 1.05,
              fontWeight: 800,
              color: "#f0f0f5",
              letterSpacing: "-0.02em",
              maxWidth: "980px",
            }}
          >
            Production AI agents with predictable cost
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 32,
              color: "#9898a8",
              fontWeight: 400,
            }}
          >
            Forecast cost · Catch eval regressions in CI · Deploy in your VPC
          </div>
        </div>

        {/* Footer strip */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "16px",
            fontSize: 26,
            color: "#55556a",
          }}
        >
          <div style={{ color: "#fb923c" }}>Open source</div>
          <div>·</div>
          <div>Apache 2.0</div>
          <div>·</div>
          <div style={{ fontFamily: "monospace", color: "#38bdf8" }}>
            lantern.run
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
