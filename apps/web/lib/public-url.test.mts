import test from "node:test";
import assert from "node:assert/strict";
import { publicApiBase, widgetScriptUrl } from "./public-url.ts";

// Copied URLs carry the caller's API key: they must point at this deployment,
// never at a hardcoded public domain.
function withWindow(origin: string | undefined, fn: () => void) {
  const g = globalThis as Record<string, unknown>;
  const saved = g.window;
  if (origin === undefined) delete g.window;
  else {
    const u = new URL(origin);
    g.window = { location: { origin: u.origin, hostname: u.hostname } };
  }
  try { fn(); } finally { if (saved === undefined) delete g.window; else g.window = saved; }
}

test("publicApiBase: NEXT_PUBLIC_API_URL wins (trailing slash trimmed)", () => {
  const saved = process.env.NEXT_PUBLIC_API_URL;
  process.env.NEXT_PUBLIC_API_URL = "https://api.acme.example.com/";
  try {
    withWindow("https://dash.acme.example.com", () => assert.equal(publicApiBase(), "https://api.acme.example.com"));
  } finally {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_API_URL; else process.env.NEXT_PUBLIC_API_URL = saved;
  }
});

test("publicApiBase: page origin, localhost API in dev, empty on the server", () => {
  const saved = process.env.NEXT_PUBLIC_API_URL;
  delete process.env.NEXT_PUBLIC_API_URL;
  try {
    withWindow("https://dash.acme.example.com", () => assert.equal(publicApiBase(), "https://dash.acme.example.com"));
    withWindow("http://localhost:3001", () => assert.equal(publicApiBase(), "http://localhost:8080"));
    withWindow(undefined, () => assert.equal(publicApiBase(), ""));
  } finally {
    if (saved !== undefined) process.env.NEXT_PUBLIC_API_URL = saved;
  }
});

test("widgetScriptUrl: same-origin /widget.js", () => {
  withWindow("https://dash.acme.example.com", () => assert.equal(widgetScriptUrl(), "https://dash.acme.example.com/widget.js"));
  withWindow(undefined, () => assert.equal(widgetScriptUrl(), "/widget.js"));
});
