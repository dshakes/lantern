// Media handling for inbound WhatsApp messages: voice notes get
// transcribed via Whisper, images get described via a vision LLM.
// Both feed the resulting text into the normal reply path so the
// agent can respond contextually.
//
// Why we don't try to ALSO send voice/images outbound here:
//   - Voice cloning (ElevenLabs) is expensive and requires per-user
//     voice training. Left as a future flag (LANTERN_VOICE_CLONE_ID).
//   - Image generation (DALL-E / SD) is a different product.
// Inbound understanding is the high-leverage win; outbound is mostly
// novelty.
//
// We POST to the control-plane's /v1/completions endpoint for both,
// which routes through the per-tenant LLM provider keys (same path
// the dashboard's "Generate with AI" uses). No direct OpenAI/
// Anthropic env vars in the bridge — keeps secrets in one place.

import type { Logger } from "pino";
import { downloadMediaMessage, type WAMessage } from "baileys";
import { authedFetch } from "@lantern/bridge-core/auth";

export interface MediaAnnotation {
  // Synthesized text that the reply pipeline treats as the inbound
  // text. For a voice note: the transcription. For an image: a
  // bracketed description prefix + caption.
  syntheticText: string;
  // Whether we actually understood the media, vs failed.
  ok: boolean;
  // For logging / dashboard display.
  kind: "voice" | "image" | "video" | "unknown";
  // Original caption from WhatsApp if attached (images often have one).
  caption?: string;
}

export class MediaHandler {
  private logger: Logger;
  constructor(logger: Logger) {
    this.logger = logger.child({ component: "media" });
  }

  // Returns true if this message has media we know how to handle.
  hasMedia(msg: WAMessage): boolean {
    return !!(
      msg.message?.audioMessage ||
      msg.message?.imageMessage ||
      msg.message?.videoMessage
    );
  }

  // Detect media kind from message shape.
  kind(msg: WAMessage): MediaAnnotation["kind"] {
    if (msg.message?.audioMessage) return "voice";
    if (msg.message?.imageMessage) return "image";
    if (msg.message?.videoMessage) return "video";
    return "unknown";
  }

  // Download, understand, return a synthetic-text annotation we can
  // feed to the reply pipeline. Fire-and-forget safe — if anything
  // throws we return ok=false and a placeholder so the reply path
  // still gets called.
  async annotate(msg: WAMessage): Promise<MediaAnnotation> {
    const kind = this.kind(msg);
    if (kind === "unknown") {
      return { ok: false, kind, syntheticText: "" };
    }
    try {
      const buf = (await downloadMediaMessage(msg, "buffer", {})) as Buffer;
      if (kind === "voice") {
        return await this.transcribeVoice(buf);
      }
      if (kind === "image") {
        const caption = msg.message?.imageMessage?.caption || undefined;
        return await this.describeImage(buf, caption);
      }
      if (kind === "video") {
        // Videos: extract caption only for now; full frame-grab+vision
        // is more work than it's worth for typical WA usage.
        const caption = msg.message?.videoMessage?.caption || "";
        return {
          ok: true,
          kind,
          caption,
          syntheticText: caption
            ? `[they sent a video with caption: "${caption}"]`
            : "[they sent a video — no caption]",
        };
      }
    } catch (err) {
      this.logger.warn({ err, kind }, "media annotate failed");
    }
    return { ok: false, kind, syntheticText: `[they sent ${kind} — couldn't read it]` };
  }

  private async transcribeVoice(buf: Buffer): Promise<MediaAnnotation> {
    // Use OpenAI Whisper via the control-plane proxy. We bypass the
    // /v1/completions path here because Whisper has its own endpoint;
    // we call OpenAI directly when LANTERN_OPENAI_API_KEY is set, else
    // surface a clear error so the user knows what's missing.
    const apiKey = process.env.OPENAI_API_KEY || process.env.LANTERN_OPENAI_API_KEY;
    if (!apiKey) {
      return {
        ok: false,
        kind: "voice",
        syntheticText:
          "[voice note — transcription unavailable. Set OPENAI_API_KEY to enable Whisper.]",
      };
    }
    try {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(buf)], { type: "audio/ogg" }), "voice.ogg");
      form.append("model", "whisper-1");
      const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        this.logger.warn({ status: res.status, body: body.slice(0, 200) }, "whisper failed");
        return {
          ok: false,
          kind: "voice",
          syntheticText: `[voice note — Whisper returned ${res.status}]`,
        };
      }
      const data = (await res.json()) as { text?: string };
      const transcript = (data.text || "").trim();
      if (!transcript) {
        return { ok: false, kind: "voice", syntheticText: "[voice note — empty transcription]" };
      }
      // Annotate so the LLM knows this came from a voice note and can
      // mirror the casual register a voice message implies.
      return {
        ok: true,
        kind: "voice",
        syntheticText: `[voice note transcribed] ${transcript}`,
      };
    } catch (err) {
      this.logger.warn({ err }, "whisper exception");
      return { ok: false, kind: "voice", syntheticText: "[voice note — transcription errored]" };
    }
  }

  private async describeImage(buf: Buffer, caption?: string): Promise<MediaAnnotation> {
    // Send to the control-plane's vision endpoint. The control-plane
    // routes via failover (OpenAI gpt-4o, Anthropic claude-sonnet)
    // depending on which keys the tenant has configured.
    const b64 = buf.toString("base64");
    try {
      const res = await authedFetch("/v1/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "auto",
          messages: [
            {
              role: "system",
              content:
                "You describe images sent over WhatsApp in 1-2 short, plain sentences so a friend can know what's in them. Don't add commentary or guess intent — just describe. Lowercase, no preamble.",
            },
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: `data:image/jpeg;base64,${b64}` },
                },
                {
                  type: "text",
                  text: caption ? `(they captioned it: "${caption}")` : "describe this:",
                },
              ],
            },
          ],
          max_tokens: 120,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        this.logger.warn({ status: res.status, body: body.slice(0, 200) }, "vision call failed");
        return {
          ok: false,
          kind: "image",
          caption,
          syntheticText: caption
            ? `[image with caption: "${caption}"]`
            : "[image — couldn't describe]",
        };
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        content?: string;
      };
      const desc =
        data.choices?.[0]?.message?.content?.trim() || data.content?.trim() || "";
      if (!desc) {
        return {
          ok: false,
          kind: "image",
          caption,
          syntheticText: caption ? `[image with caption: "${caption}"]` : "[image]",
        };
      }
      // Prefix so the LLM knows the inbound is media + a description.
      const prefix = caption
        ? `[image with caption "${caption}" — looks like: ${desc}]`
        : `[image — looks like: ${desc}]`;
      return { ok: true, kind: "image", caption, syntheticText: prefix };
    } catch (err) {
      this.logger.warn({ err }, "vision exception");
      return {
        ok: false,
        kind: "image",
        caption,
        syntheticText: caption ? `[image with caption: "${caption}"]` : "[image]",
      };
    }
  }
}
