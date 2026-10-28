import { ImageResponse } from "next/og";

// Social card (1200x630), generated at build time. Colors are the night theme
// from docs/brand/tokens.css.
export const alt = "Lantern: the agent runs outside, its code runs in a microVM";
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
          background: "#0b1220",
          padding: "80px",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "18px" }}>
          <div
            style={{
              width: 34,
              height: 40,
              border: "4px solid #7cc4e8",
              borderRadius: 10,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div style={{ width: 12, height: 16, background: "#ffb547", borderRadius: "50% 50% 50% 50% / 65% 65% 35% 35%" }} />
          </div>
          <div style={{ fontSize: 36, color: "#e8eef5", fontWeight: 600 }}>Lantern</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "28px" }}>
          <div
            style={{
              display: "flex",
              fontSize: 80,
              lineHeight: 1.0,
              fontWeight: 800,
              color: "#e8eef5",
              letterSpacing: "-0.03em",
              maxWidth: "1000px",
            }}
          >
            The agent runs outside. Its code runs in a microVM.
          </div>
          <div style={{ display: "flex", fontSize: 30, color: "#a9b6c8" }}>
            The open-source agent runtime you host in your own cloud
          </div>
        </div>

        <div style={{ display: "flex", gap: "28px", fontSize: 24, color: "#7a8aa2" }}>
          <div style={{ color: "#4fc1a6" }}>Apache-2.0</div>
          <div style={{ fontFamily: "monospace", color: "#7cc4e8" }}>github.com/dshakes/lantern</div>
        </div>
      </div>
    ),
    { ...size },
  );
}

export const dynamic = "force-static";
