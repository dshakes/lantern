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
import {
  voiceTranscriptionLangHint,
  looksGarbledTranscript,
} from "@lantern/bridge-core/language";

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
  // True when we received media but could not understand it (transcription
  // mis-decoded / low-confidence). The caller should NOT feed syntheticText
  // to the LLM as a real message — instead degrade to a human ack/reaction.
  // syntheticText stays empty in this case to avoid leaking garbled text.
  degraded?: boolean;
}

export class MediaHandler {
  private logger: Logger;
  // Optional getter for the owner's nativity line (from the owner profile).
  // Lets the Whisper language hint follow the profile without extra config.
  private nativity: () => string;
  constructor(logger: Logger, nativity?: () => string) {
    this.logger = logger.child({ component: "media" });
    this.nativity = nativity ?? (() => "");
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
    // Transcribe via the control-plane Whisper proxy (POST
    // /v1/audio/transcriptions), which uses the tenant's stored OpenAI key.
    // This keeps the key out of the bridge process and respects the
    // model-router invariant (no service calls api.openai.com directly).
    // A raw OPENAI_API_KEY env var, if present, is honoured as an offline
    // fallback only.
    //
    // LANGUAGE BIAS: Whisper auto-detect mis-decodes low-resource South-Asian
    // speech (Telangana Telugu → garbled Kannada script). We pass an explicit
    // ISO `language` + script-priming `prompt` sourced from LANTERN_VOICE_LANG
    // / owner nativity (default "te") so it decodes into the right script.
    const langHint = voiceTranscriptionLangHint({ nativity: this.nativity() });
    try {
      const res = await authedFetch("/v1/audio/transcriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioBase64: buf.toString("base64"),
          filename: "voice.ogg",
          ...(langHint.iso ? { language: langHint.iso } : {}),
          ...(langHint.prompt ? { prompt: langHint.prompt } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        this.logger.warn({ status: res.status, body: body.slice(0, 200) }, "transcription proxy failed");
        const fallback = await this.transcribeVoiceDirect(buf, langHint);
        if (fallback) return fallback;
        // Transcription unavailable (proxy error, no key, etc.). Mark
        // `degraded` with EMPTY syntheticText so the caller sends a warm
        // human ack instead of feeding a "[transcription unavailable]"
        // placeholder to the LLM (which would emit a meta-reply that the
        // bot-tell filter suppresses → dead silence).
        return { ok: false, kind: "voice", degraded: true, syntheticText: "" };
      }
      const data = (await res.json()) as { text?: string };
      const transcript = (data.text || "").trim();
      if (!transcript) {
        // Empty transcription is not a real message — degrade to an ack.
        return { ok: false, kind: "voice", degraded: true, syntheticText: "" };
      }
      return this.finalizeTranscript(transcript, langHint.lang);
    } catch (err) {
      this.logger.warn({ err }, "transcription proxy exception");
      const fallback = await this.transcribeVoiceDirect(buf, langHint);
      if (fallback) return fallback;
      return { ok: false, kind: "voice", degraded: true, syntheticText: "" };
    }
  }

  // Quality gate shared by the proxy + direct paths. A mis-decoded transcript
  // (wrong script, e.g. Telugu→Kannada) is marked `degraded` with EMPTY
  // syntheticText so the caller degrades to a human ack instead of feeding
  // garbage to the LLM (which would emit a "transcription is garbled" meta
  // reply that then gets suppressed → dead silence). No transcript text is
  // logged (PII).
  private finalizeTranscript(transcript: string, expectedLang: Parameters<typeof looksGarbledTranscript>[1]): MediaAnnotation {
    if (looksGarbledTranscript(transcript, expectedLang)) {
      this.logger.warn({ expectedLang, len: transcript.length }, "voice transcript looks garbled — degrading to ack");
      return { ok: false, kind: "voice", degraded: true, syntheticText: "" };
    }
    // Annotate so the LLM knows this came from a voice note and can
    // mirror the casual register a voice message implies.
    return { ok: true, kind: "voice", syntheticText: `[voice note transcribed] ${transcript}` };
  }

  // Offline/dev fallback: call OpenAI Whisper directly when a raw key is in
  // the env. Returns null when no key is set so the caller can surface a
  // clear "add a key" message. Not the prod path — see transcribeVoice.
  private async transcribeVoiceDirect(
    buf: Buffer,
    langHint: ReturnType<typeof voiceTranscriptionLangHint>,
  ): Promise<MediaAnnotation | null> {
    const apiKey = process.env.OPENAI_API_KEY || process.env.LANTERN_OPENAI_API_KEY;
    if (!apiKey) return null;
    try {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(buf)], { type: "audio/ogg" }), "voice.ogg");
      form.append("model", "whisper-1");
      if (langHint.iso) form.append("language", langHint.iso);
      if (langHint.prompt) form.append("prompt", langHint.prompt);
      const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { text?: string };
      const transcript = (data.text || "").trim();
      if (!transcript) return null;
      return this.finalizeTranscript(transcript, langHint.lang);
    } catch {
      return null;
    }
  }

  private async describeImage(buf: Buffer, caption?: string): Promise<MediaAnnotation> {
    // Describe via the control-plane's vision endpoint (POST /v1/vision/ocr).
    // That endpoint takes a `{ imageDataUrl, prompt }` JSON body and builds
    // the multimodal OpenAI request server-side. We previously POSTed a
    // multimodal `messages` array to /v1/completions — but that handler types
    // message content as a plain string, so the array body failed to decode
    // and returned HTTP 400 "invalid request body". Using /v1/vision/ocr is
    // the correct contract (it accepts a data: URL + a free-form prompt).
    const b64 = buf.toString("base64");
    try {
      const res = await authedFetch("/v1/vision/ocr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageDataUrl: `data:image/jpeg;base64,${b64}`,
          prompt: caption
            ? `Describe this image sent over WhatsApp in 1-2 short, plain lowercase sentences so a friend knows what's in it. They captioned it: "${caption}". Don't guess intent — just describe. If it contains text, include it.`
            : "Describe this image sent over WhatsApp in 1-2 short, plain lowercase sentences so a friend knows what's in it. Don't guess intent — just describe. If it contains text, include it.",
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
      const data = (await res.json()) as { text?: string };
      const desc = (data.text || "").trim();
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
