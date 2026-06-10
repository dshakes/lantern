// Tests for MediaHandler pure / cheaply-mockable methods.
//
// Strategy:
//  - `hasMedia` and `kind` are pure (no I/O) — exercised directly.
//  - `annotate` for `kind === "unknown"` returns immediately — no mocks needed.
//  - `annotate` for video messages requires `downloadMediaMessage` from baileys;
//    we mock the entire `baileys` module so the bridge never actually tries to
//    connect to WhatsApp.
//  - Voice / image paths both hit authedFetch (network). We mock
//    `@lantern/bridge-core/auth` so authedFetch is intercepted via
//    globalThis.fetch (same pattern as attention.test.ts).
//
// We do NOT test the real OpenAI/Whisper path — that path is marked as a
// dev-only fallback and requires OPENAI_API_KEY in the environment.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import pino from "pino";

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted before any import)
// ---------------------------------------------------------------------------

// Baileys mock: intercept downloadMediaMessage so media tests don't need a
// live WA session.  We expose a replaceable `mockDownload` spy the tests can
// swap per-test.
const mockDownload = vi.hoisted(() => vi.fn<() => Promise<Buffer>>());

vi.mock("baileys", async () => {
  return {
    downloadMediaMessage: (...args: unknown[]) => mockDownload(...args),
    // MediaHandler only imports downloadMediaMessage; everything else is
    // type-only from the module.
  };
});

// auth mock: redirect authedFetch to globalThis.fetch so tests can intercept
// with their own stub (same pattern as attention.test.ts).
vi.mock("@lantern/bridge-core/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lantern/bridge-core/auth")>();
  return {
    ...actual,
    authEnabled: () => true,
    authedFetch: (path: string, init?: RequestInit) => globalThis.fetch(path, init!),
  };
});

// language mock: keep the bridge-core dependency minimal — just return a
// harmless no-op lang hint and never flag a transcript as garbled.
vi.mock("@lantern/bridge-core/language", async () => {
  return {
    voiceTranscriptionLangHint: () => ({ iso: "te", prompt: "", lang: "te" as const }),
    looksGarbledTranscript: () => false,
    detectLanguageHints: () => ({}),
    languageModalityHint: () => "",
    degradedVoiceAck: () => "one sec—",
  };
});

import { MediaHandler } from "../src/media.js";

const logger = pino({ level: "silent" });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the minimal WAMessage shape for an audio note. */
function audioMsg(caption?: string) {
  return {
    message: {
      audioMessage: { ptt: true, mimetype: "audio/ogg", caption },
    },
  };
}

/** Build the minimal WAMessage shape for an image. */
function imageMsg(caption?: string) {
  return {
    message: {
      imageMessage: { mimetype: "image/jpeg", caption },
    },
  };
}

/** Build the minimal WAMessage shape for a video. */
function videoMsg(caption?: string) {
  return {
    message: {
      videoMessage: { mimetype: "video/mp4", caption },
    },
  };
}

/** A message with no media (plain text). */
function textMsg() {
  return {
    message: {
      conversation: "Hello",
    },
  };
}

/** Stub globalThis.fetch to return a given JSON body. */
function stubFetch(ok: boolean, json: Record<string, unknown> = {}) {
  const stub = vi.fn(async () =>
    ({
      ok,
      status: ok ? 200 : 500,
      text: async () => JSON.stringify(json),
      json: async () => json,
    }) as unknown as Response
  );
  globalThis.fetch = stub;
  return stub;
}

// ---------------------------------------------------------------------------
// hasMedia
// ---------------------------------------------------------------------------

describe("MediaHandler.hasMedia", () => {
  const h = new MediaHandler(logger);

  it("returns true for an audio message", () => {
    expect(h.hasMedia(audioMsg() as Parameters<typeof h.hasMedia>[0])).toBe(true);
  });

  it("returns true for an image message", () => {
    expect(h.hasMedia(imageMsg() as Parameters<typeof h.hasMedia>[0])).toBe(true);
  });

  it("returns true for a video message", () => {
    expect(h.hasMedia(videoMsg() as Parameters<typeof h.hasMedia>[0])).toBe(true);
  });

  it("returns false for a plain-text message", () => {
    expect(h.hasMedia(textMsg() as Parameters<typeof h.hasMedia>[0])).toBe(false);
  });

  it("returns false for an empty message envelope", () => {
    expect(h.hasMedia({ message: {} } as Parameters<typeof h.hasMedia>[0])).toBe(false);
  });

  it("returns false when message field is absent", () => {
    expect(h.hasMedia({} as Parameters<typeof h.hasMedia>[0])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// kind
// ---------------------------------------------------------------------------

describe("MediaHandler.kind", () => {
  const h = new MediaHandler(logger);

  it("classifies audio as 'voice'", () => {
    expect(h.kind(audioMsg() as Parameters<typeof h.kind>[0])).toBe("voice");
  });

  it("classifies image as 'image'", () => {
    expect(h.kind(imageMsg() as Parameters<typeof h.kind>[0])).toBe("image");
  });

  it("classifies video as 'video'", () => {
    expect(h.kind(videoMsg() as Parameters<typeof h.kind>[0])).toBe("video");
  });

  it("classifies text/unknown as 'unknown'", () => {
    expect(h.kind(textMsg() as Parameters<typeof h.kind>[0])).toBe("unknown");
  });

  it("classifies empty envelope as 'unknown'", () => {
    expect(h.kind({ message: {} } as Parameters<typeof h.kind>[0])).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// annotate — unknown kind (no network, immediate return)
// ---------------------------------------------------------------------------

describe("MediaHandler.annotate — unknown kind", () => {
  const h = new MediaHandler(logger);

  it("returns ok:false, kind:'unknown', syntheticText:'' for a plain-text message", async () => {
    const result = await h.annotate(textMsg() as Parameters<typeof h.annotate>[0]);
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("unknown");
    expect(result.syntheticText).toBe("");
  });
});

// ---------------------------------------------------------------------------
// annotate — video (requires downloadMediaMessage mock, but no network)
// ---------------------------------------------------------------------------

describe("MediaHandler.annotate — video", () => {
  beforeEach(() => {
    mockDownload.mockResolvedValue(Buffer.from("fake-video-bytes"));
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns syntheticText with caption when caption is set", async () => {
    const h = new MediaHandler(logger);
    const result = await h.annotate(videoMsg("check this out") as Parameters<typeof h.annotate>[0]);
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("video");
    expect(result.caption).toBe("check this out");
    expect(result.syntheticText).toContain("check this out");
    expect(result.syntheticText).toContain("video");
  });

  it("returns 'no caption' text when caption is absent", async () => {
    const h = new MediaHandler(logger);
    const result = await h.annotate(videoMsg() as Parameters<typeof h.annotate>[0]);
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("video");
    expect(result.syntheticText).toContain("no caption");
  });

  it("returns ok:false with placeholder when downloadMediaMessage throws", async () => {
    mockDownload.mockRejectedValue(new Error("decrypt failed"));
    const h = new MediaHandler(logger);
    const result = await h.annotate(videoMsg("boom") as Parameters<typeof h.annotate>[0]);
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("video");
    // syntheticText should still be a non-empty string so the caller knows
    // what happened — not an empty string (that's reserved for degraded voice).
    expect(result.syntheticText.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// annotate — voice (mocked download + mocked authedFetch via globalThis.fetch)
// ---------------------------------------------------------------------------

describe("MediaHandler.annotate — voice (transcription path)", () => {
  beforeEach(() => {
    // Default: download succeeds with a tiny fake ogg buffer.
    mockDownload.mockResolvedValue(Buffer.from("fake-ogg-bytes"));
  });

  afterEach(() => {
    vi.resetAllMocks();
    delete process.env.OPENAI_API_KEY;
    delete process.env.LANTERN_OPENAI_API_KEY;
  });

  it("returns ok:true with [voice note transcribed] prefix on success", async () => {
    stubFetch(true, { text: "hello there" });
    const h = new MediaHandler(logger);
    const result = await h.annotate(audioMsg() as Parameters<typeof h.annotate>[0]);
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("voice");
    expect(result.syntheticText).toMatch(/\[voice note transcribed\]/);
    expect(result.syntheticText).toContain("hello there");
  });

  it("marks degraded:true when transcription proxy returns non-OK (no direct API key)", async () => {
    stubFetch(false, {});
    const h = new MediaHandler(logger);
    // No OPENAI_API_KEY set, so direct path won't run.
    const result = await h.annotate(audioMsg() as Parameters<typeof h.annotate>[0]);
    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.syntheticText).toBe(""); // degraded → empty so caller ACKs
  });

  it("marks degraded:true when transcript is empty string", async () => {
    stubFetch(true, { text: "" });
    const h = new MediaHandler(logger);
    const result = await h.annotate(audioMsg() as Parameters<typeof h.annotate>[0]);
    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.syntheticText).toBe("");
  });

  it("marks degraded:true when transcription proxy throws (no direct key)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof globalThis.fetch;
    const h = new MediaHandler(logger);
    const result = await h.annotate(audioMsg() as Parameters<typeof h.annotate>[0]);
    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// annotate — image (mocked download + mocked authedFetch via globalThis.fetch)
// ---------------------------------------------------------------------------

describe("MediaHandler.annotate — image (vision path)", () => {
  beforeEach(() => {
    mockDownload.mockResolvedValue(Buffer.from("fake-jpeg-bytes"));
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns ok:true with [image — looks like: ...] prefix on success", async () => {
    stubFetch(true, { text: "a dog sitting on a couch" });
    const h = new MediaHandler(logger);
    const result = await h.annotate(imageMsg() as Parameters<typeof h.annotate>[0]);
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("image");
    expect(result.syntheticText).toContain("image");
    expect(result.syntheticText).toContain("a dog sitting on a couch");
  });

  it("includes caption in syntheticText when caption is set", async () => {
    stubFetch(true, { text: "a screenshot of a calendar" });
    const h = new MediaHandler(logger);
    const result = await h.annotate(imageMsg("check this out") as Parameters<typeof h.annotate>[0]);
    expect(result.ok).toBe(true);
    expect(result.syntheticText).toContain("check this out");
    expect(result.syntheticText).toContain("a screenshot of a calendar");
    expect(result.caption).toBe("check this out");
  });

  it("falls back gracefully when vision API returns non-OK (with caption)", async () => {
    stubFetch(false, {});
    const h = new MediaHandler(logger);
    const result = await h.annotate(imageMsg("my receipt") as Parameters<typeof h.annotate>[0]);
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("image");
    expect(result.caption).toBe("my receipt");
    expect(result.syntheticText).toContain("my receipt");
  });

  it("falls back gracefully when vision API returns non-OK (no caption)", async () => {
    stubFetch(false, {});
    const h = new MediaHandler(logger);
    const result = await h.annotate(imageMsg() as Parameters<typeof h.annotate>[0]);
    expect(result.ok).toBe(false);
    expect(result.syntheticText).toContain("image");
  });

  it("falls back when vision returns empty text (no caption)", async () => {
    stubFetch(true, { text: "" });
    const h = new MediaHandler(logger);
    const result = await h.annotate(imageMsg() as Parameters<typeof h.annotate>[0]);
    expect(result.ok).toBe(false);
    expect(result.syntheticText).toBe("[image]");
  });

  it("falls back when vision returns empty text (with caption)", async () => {
    stubFetch(true, { text: "" });
    const h = new MediaHandler(logger);
    const result = await h.annotate(imageMsg("my doc") as Parameters<typeof h.annotate>[0]);
    expect(result.ok).toBe(false);
    expect(result.syntheticText).toContain("my doc");
  });

  it("returns ok:false placeholder when downloadMediaMessage throws", async () => {
    mockDownload.mockRejectedValue(new Error("media decrypt error"));
    const h = new MediaHandler(logger);
    const result = await h.annotate(imageMsg() as Parameters<typeof h.annotate>[0]);
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("image");
  });

  it("returns ok:false when vision fetch throws (network error)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof globalThis.fetch;
    const h = new MediaHandler(logger);
    const result = await h.annotate(imageMsg() as Parameters<typeof h.annotate>[0]);
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("image");
  });
});

// ---------------------------------------------------------------------------
// nativity callback (passed via constructor)
// ---------------------------------------------------------------------------

describe("MediaHandler nativity callback", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("accepts a nativity getter that returns an empty string (default)", () => {
    const h = new MediaHandler(logger, () => "");
    expect(h.kind(audioMsg() as Parameters<typeof h.kind>[0])).toBe("voice");
  });

  it("accepts a nativity getter returning a language code", () => {
    const h = new MediaHandler(logger, () => "te-IN");
    expect(h.hasMedia(audioMsg() as Parameters<typeof h.hasMedia>[0])).toBe(true);
  });
});
