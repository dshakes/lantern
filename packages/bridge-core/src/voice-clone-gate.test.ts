// Tests for the B8 ElevenLabs voice-clone gate.
//
// Voice-clone (speaking to a recipient in the owner's OWN cloned voice)
// is deepfake-class, so it is OFF by default and triple-gated:
//   LANTERN_VOICE_CLONE=1 + LANTERN_ELEVENLABS_API_KEY + LANTERN_ELEVENLABS_VOICE_ID
//
// These lock in:
//   (a) disabled/unconfigured → null (caller uses Polly <Say>);
//   (b) enabled+configured    → synthesis is ATTEMPTED and the hosted
//       URL is returned (the <Play> path);
//   (c) any synth/host failure → null (clean Polly fallback, never throws);
//   (d) the gate never leaks the API key.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  resolveVoiceCloneConfig,
  isVoiceCloneEnabled,
} from "./outbound-call.ts";
import { synthesizeSpeech } from "./call-orchestrator.ts";

const FULL_ENV = {
  LANTERN_VOICE_CLONE: "1",
  LANTERN_ELEVENLABS_API_KEY: "sk-secret-key",
  LANTERN_ELEVENLABS_VOICE_ID: "voice-abc",
} as NodeJS.ProcessEnv;

// ── resolveVoiceCloneConfig / isVoiceCloneEnabled ──────────────────

test("gate CLOSED when LANTERN_VOICE_CLONE unset, even with key+voice", () => {
  const env = {
    LANTERN_ELEVENLABS_API_KEY: "sk-secret-key",
    LANTERN_ELEVENLABS_VOICE_ID: "voice-abc",
  } as NodeJS.ProcessEnv;
  assert.equal(resolveVoiceCloneConfig(env), null);
  assert.equal(isVoiceCloneEnabled(env), false);
});

test("gate CLOSED when flag on but API key missing", () => {
  const env = {
    LANTERN_VOICE_CLONE: "1",
    LANTERN_ELEVENLABS_VOICE_ID: "voice-abc",
  } as NodeJS.ProcessEnv;
  assert.equal(resolveVoiceCloneConfig(env), null);
});

test("gate CLOSED when flag on but voice id missing", () => {
  const env = {
    LANTERN_VOICE_CLONE: "1",
    LANTERN_ELEVENLABS_API_KEY: "sk-secret-key",
  } as NodeJS.ProcessEnv;
  assert.equal(resolveVoiceCloneConfig(env), null);
});

test("gate OPEN only when all three present", () => {
  const cfg = resolveVoiceCloneConfig(FULL_ENV);
  assert.ok(cfg);
  assert.equal(cfg!.apiKey, "sk-secret-key");
  assert.equal(cfg!.voiceId, "voice-abc");
  assert.equal(isVoiceCloneEnabled(FULL_ENV), true);
});

test("legacy LANTERN_ELEVENLABS_KEY alias is accepted", () => {
  const env = {
    LANTERN_VOICE_CLONE: "1",
    LANTERN_ELEVENLABS_KEY: "sk-legacy",
    LANTERN_ELEVENLABS_VOICE_ID: "voice-abc",
  } as NodeJS.ProcessEnv;
  const cfg = resolveVoiceCloneConfig(env);
  assert.ok(cfg);
  assert.equal(cfg!.apiKey, "sk-legacy");
});

test("flag accepts 1/true/on; rejects 0/off/garbage", () => {
  const base = {
    LANTERN_ELEVENLABS_API_KEY: "k",
    LANTERN_ELEVENLABS_VOICE_ID: "v",
  };
  for (const v of ["1", "true", "on", "TRUE", "On"]) {
    assert.ok(resolveVoiceCloneConfig({ ...base, LANTERN_VOICE_CLONE: v } as NodeJS.ProcessEnv), `"${v}" should enable`);
  }
  for (const v of ["0", "off", "no", "", "yes-ish"]) {
    assert.equal(resolveVoiceCloneConfig({ ...base, LANTERN_VOICE_CLONE: v } as NodeJS.ProcessEnv), null, `"${v}" should NOT enable`);
  }
});

// ── synthesizeSpeech (the abstraction the orchestrator calls) ──────

test("synthesizeSpeech returns null when gate closed (→ Polly path)", async () => {
  let rendered = false;
  const url = await synthesizeSpeech("hi there", {
    config: null, // gate closed
    render: async () => {
      rendered = true;
      return Buffer.from([1, 2, 3]);
    },
    hostAudio: async () => "http://x/a.mp3",
  });
  assert.equal(url, null);
  assert.equal(rendered, false, "must NOT attempt synthesis when disabled");
});

test("synthesizeSpeech ATTEMPTS synth + returns hosted URL when enabled", async () => {
  let renderedText: string | null = null;
  let hostedKey: string | null = null;
  const url = await synthesizeSpeech("leave a happy birthday message", {
    config: { apiKey: "sk-secret-key", voiceId: "voice-abc" },
    render: async (text) => {
      renderedText = text;
      return Buffer.from([0xff, 0xf3]); // pretend MP3 bytes
    },
    hostAudio: async (key) => {
      hostedKey = key;
      return `https://tunnel.example/voice-cache/${key}.mp3`;
    },
  });
  assert.equal(renderedText, "leave a happy birthday message");
  assert.ok(hostedKey, "host should be invoked with a cache key");
  assert.ok(url && url.startsWith("https://tunnel.example/voice-cache/"));
  assert.ok(url!.endsWith(".mp3"));
});

test("synthesizeSpeech falls back to null when render throws (never throws)", async () => {
  const url = await synthesizeSpeech("hi", {
    config: { apiKey: "k", voiceId: "v" },
    render: async () => {
      throw new Error("ElevenLabs 429");
    },
    hostAudio: async () => "http://x/a.mp3",
  });
  assert.equal(url, null);
});

test("synthesizeSpeech falls back to null when render returns null/empty", async () => {
  for (const out of [null, Buffer.alloc(0)]) {
    const url = await synthesizeSpeech("hi", {
      config: { apiKey: "k", voiceId: "v" },
      render: async () => out,
      hostAudio: async () => "http://x/a.mp3",
    });
    assert.equal(url, null);
  }
});

test("synthesizeSpeech falls back to null when hosting fails", async () => {
  const url = await synthesizeSpeech("hi", {
    config: { apiKey: "k", voiceId: "v" },
    render: async () => Buffer.from([1]),
    hostAudio: async () => {
      throw new Error("disk full");
    },
  });
  assert.equal(url, null);
});

test("synthesizeSpeech returns null for empty text without synthesizing", async () => {
  let rendered = false;
  const url = await synthesizeSpeech("   ", {
    config: { apiKey: "k", voiceId: "v" },
    render: async () => {
      rendered = true;
      return Buffer.from([1]);
    },
    hostAudio: async () => "http://x/a.mp3",
  });
  assert.equal(url, null);
  assert.equal(rendered, false);
});

test("identical (text, voice) yields a stable, reusable cache key", async () => {
  const keys: string[] = [];
  const opts = {
    config: { apiKey: "k", voiceId: "voice-abc" },
    render: async () => Buffer.from([1]),
    hostAudio: async (key: string) => {
      keys.push(key);
      return `http://x/${key}.mp3`;
    },
  };
  await synthesizeSpeech("same phrase", opts);
  await synthesizeSpeech("same phrase", opts);
  assert.equal(keys[0], keys[1], "same phrase should reuse the cache key");
});
