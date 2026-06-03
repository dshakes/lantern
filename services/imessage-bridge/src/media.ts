// iMessage attachment handling. Unlike WhatsApp where attachments
// arrive over the wire and we have to download them via Baileys, on
// iMessage the file is already on local disk — chat.db's `attachment`
// table joins message → message_attachment_join → attachment, and
// `attachment.filename` is a path under ~/Library/Messages/Attachments
// (also accessible since we already have Full Disk Access).
//
// We use the same control-plane vision endpoint + OpenAI Whisper as
// the WhatsApp bridge so transcripts/descriptions are byte-identical
// across channels.

import { readFileSync, existsSync } from "fs";
import type { Logger } from "pino";

import { authedFetch } from "@lantern/bridge-core/auth";
import {
  voiceTranscriptionLangHint,
  looksGarbledTranscript,
} from "@lantern/bridge-core/language";
import type { Attachment } from "./chat-db.js";

export interface MediaAnnotation {
  syntheticText: string;
  ok: boolean;
  kind: "voice" | "image" | "video" | "other";
  mime?: string;
  // True when media arrived but could not be understood (transcription
  // mis-decoded / low-confidence). Caller should degrade to a human ack
  // instead of feeding syntheticText (kept empty) to the LLM. Parity with
  // the WhatsApp bridge's MediaAnnotation.
  degraded?: boolean;
}

export class MediaHandler {
  private logger: Logger;
  // Optional getter for the owner's nativity (owner profile) — biases the
  // Whisper language hint without extra config. Parity with WA bridge.
  private nativity: () => string;
  constructor(logger: Logger, nativity?: () => string) {
    this.logger = logger.child({ component: "media" });
    this.nativity = nativity ?? (() => "");
  }

  // Classify by MIME type. iMessage stores voice notes as audio/x-caf
  // (CoreAudio), photos as image/jpeg or image/heic, videos as video/*.
  // We only handle the ones a vision/audio LLM can do something useful
  // with.
  kind(att: Attachment): MediaAnnotation["kind"] {
    const m = (att.mimeType || "").toLowerCase();
    if (m.startsWith("audio/")) return "voice";
    if (m.startsWith("image/")) return "image";
    if (m.startsWith("video/")) return "video";
    return "other";
  }

  // Read + describe an attachment. Returns a MediaAnnotation whose
  // `syntheticText` should be fed into the reply pipeline as the
  // inbound message body.
  async annotate(att: Attachment): Promise<MediaAnnotation> {
    const kind = this.kind(att);
    if (kind === "other") {
      return { ok: false, kind, mime: att.mimeType, syntheticText: `[they sent an attachment (${att.mimeType || "unknown"}) — not handled]` };
    }
    // chat.db stores ~/-prefixed paths. Normalize.
    const path = att.filename.replace(/^~/, process.env.HOME || "");
    if (!existsSync(path)) {
      return { ok: false, kind, syntheticText: `[${kind} attachment unreadable — file missing at ${path}]` };
    }
    try {
      const buf = readFileSync(path);
      if (kind === "voice") return await this.transcribeVoice(buf, att.mimeType);
      if (kind === "image") return await this.describeImage(buf, att.mimeType);
      // video: fall back to caption-only / file-name annotation
      const name = path.split("/").pop() ?? "video";
      return { ok: true, kind, syntheticText: `[they sent a video — "${name}"]` };
    } catch (err) {
      this.logger.warn({ err, path, kind }, "annotate read failed");
      return { ok: false, kind, syntheticText: `[${kind} — couldn't read attachment]` };
    }
  }

  private async transcribeVoice(buf: Buffer, mime?: string): Promise<MediaAnnotation> {
    // Transcribe via the control-plane Whisper proxy (POST
    // /v1/audio/transcriptions), which uses the tenant's stored OpenAI key.
    // This keeps the key out of the bridge process and respects the
    // model-router invariant (no service calls api.openai.com directly).
    // A raw OPENAI_API_KEY env var, if present, is honoured as an offline
    // fallback only. Parity with the WhatsApp bridge's media.ts.
    //
    // iMessage voice notes are CoreAudio (audio/x-caf); some clips arrive
    // as m4a. Carry the container hint in `filename` so Whisper picks the
    // right decoder.
    const filename = mime?.includes("caf")
      ? "voice.caf"
      : mime?.includes("mp4") || mime?.includes("m4a")
        ? "voice.m4a"
        : "voice.m4a";
    // LANGUAGE BIAS: see whatsapp-bridge/src/media.ts — Whisper mis-decodes
    // low-resource South-Asian speech (Telangana Telugu → Kannada script).
    // Pass an explicit ISO `language` + script-priming `prompt`.
    const langHint = voiceTranscriptionLangHint({ nativity: this.nativity() });
    try {
      const res = await authedFetch("/v1/audio/transcriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioBase64: buf.toString("base64"),
          filename,
          ...(langHint.iso ? { language: langHint.iso } : {}),
          ...(langHint.prompt ? { prompt: langHint.prompt } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        this.logger.warn({ status: res.status, body: body.slice(0, 200) }, "transcription proxy failed");
        const fallback = await this.transcribeVoiceDirect(buf, mime, filename, langHint);
        if (fallback) return fallback;
        return {
          ok: false,
          kind: "voice",
          mime,
          syntheticText: `[voice note — transcription unavailable (${res.status}). Add an OpenAI key in Settings.]`,
        };
      }
      const data = (await res.json()) as { text?: string };
      const transcript = (data.text || "").trim();
      if (!transcript) {
        return { ok: false, kind: "voice", mime, syntheticText: "[voice note — empty transcription]" };
      }
      return this.finalizeTranscript(transcript, langHint.lang, mime);
    } catch (err) {
      this.logger.warn({ err }, "transcription proxy exception");
      const fallback = await this.transcribeVoiceDirect(buf, mime, filename, langHint);
      if (fallback) return fallback;
      return { ok: false, kind: "voice", mime, syntheticText: "[voice note — transcription errored]" };
    }
  }

  // Quality gate shared by the proxy + direct paths. A mis-decoded transcript
  // (wrong script, e.g. Telugu→Kannada) is marked `degraded` with EMPTY
  // syntheticText so the caller degrades to a human ack instead of feeding
  // garbage to the LLM (which would emit a "garbled transcription" meta reply
  // that then gets suppressed → dead silence). No transcript text is logged
  // (PII). Parity with the WhatsApp bridge.
  private finalizeTranscript(
    transcript: string,
    expectedLang: Parameters<typeof looksGarbledTranscript>[1],
    mime?: string,
  ): MediaAnnotation {
    if (looksGarbledTranscript(transcript, expectedLang)) {
      this.logger.warn({ expectedLang, len: transcript.length }, "voice transcript looks garbled — degrading to ack");
      return { ok: false, kind: "voice", mime, degraded: true, syntheticText: "" };
    }
    // Annotate so the LLM knows this came from a voice note and can
    // mirror the casual register a voice message implies.
    return { ok: true, kind: "voice", mime, syntheticText: `[voice note transcribed] ${transcript}` };
  }

  // Offline/dev fallback: call OpenAI Whisper directly when a raw key is in
  // the env. Returns null when no key is set so the caller can surface a
  // clear "add a key" message. Not the prod path — see transcribeVoice.
  private async transcribeVoiceDirect(
    buf: Buffer,
    mime: string | undefined,
    filename: string,
    langHint: ReturnType<typeof voiceTranscriptionLangHint>,
  ): Promise<MediaAnnotation | null> {
    const apiKey = process.env.OPENAI_API_KEY || process.env.LANTERN_OPENAI_API_KEY;
    if (!apiKey) return null;
    try {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(buf)], { type: mime || "audio/m4a" }), filename);
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
      return this.finalizeTranscript(transcript, langHint.lang, mime);
    } catch {
      return null;
    }
  }

  private async describeImage(buf: Buffer, mime?: string): Promise<MediaAnnotation> {
    // Describe via the control-plane vision endpoint (POST /v1/vision/ocr),
    // which takes a `{ imageDataUrl, prompt }` JSON body. We previously POSTed
    // a multimodal `messages` array to /v1/completions, but that handler types
    // message content as a plain string, so the array body failed to decode →
    // HTTP 400 "invalid request body". /v1/vision/ocr is the right contract.
    // Parity with the WhatsApp bridge.
    const b64 = buf.toString("base64");
    const useType = mime || "image/jpeg";
    try {
      const res = await authedFetch("/v1/vision/ocr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageDataUrl: `data:${useType};base64,${b64}`,
          prompt: "Describe this image sent in a personal chat in 1-2 short plain lowercase sentences. No preamble, no guesses about intent. If it contains text, include it.",
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        this.logger.warn({ status: res.status, body: body.slice(0, 200) }, "vision failed");
        return { ok: false, kind: "image", mime, syntheticText: "[image — couldn't describe]" };
      }
      const data = (await res.json()) as { text?: string };
      const desc = (data.text || "").trim();
      if (!desc) return { ok: false, kind: "image", mime, syntheticText: "[image]" };
      return { ok: true, kind: "image", mime, syntheticText: `[image — looks like: ${desc}]` };
    } catch (err) {
      this.logger.warn({ err }, "vision exception");
      return { ok: false, kind: "image", mime, syntheticText: "[image]" };
    }
  }
}
