import { afterEach, describe, expect, it, vi } from "vitest";
import { LanternApiError, LanternClient, MessageStreamError } from "../src/client.js";
import type { ExecStreamEvent } from "../src/types.js";

const client = new LanternClient({ baseUrl: "http://x", apiKey: "k" });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function sse(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function collect(it: AsyncIterable<ExecStreamEvent>): Promise<ExecStreamEvent[]> {
  const out: ExecStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

afterEach(() => vi.unstubAllGlobals());

describe("runtime pause/resume/fork", () => {
  it("pause POSTs and returns typed result", async () => {
    const f = vi.fn().mockResolvedValue(json({ vmId: "vm1", snapshotId: "s1", state: "paused" }));
    vi.stubGlobal("fetch", f);
    const r = await client.runtime.pause("vm1");
    expect(r.state).toBe("paused");
    expect(f.mock.calls[0][0]).toBe("http://x/v1/runtime/vms/vm1/pause");
    expect(f.mock.calls[0][1].method).toBe("POST");
  });

  it("resume surfaces 402 and 409 as LanternApiError without retry", async () => {
    for (const status of [402, 409]) {
      const f = vi.fn().mockResolvedValue(new Response("nope", { status }));
      vi.stubGlobal("fetch", f);
      await expect(client.runtime.resume("vm1")).rejects.toMatchObject({ status });
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it("fork defaults count to 1 and sends the given count", async () => {
    const f = vi.fn().mockImplementation(async () =>
      json({ sourceVmId: "vm1", snapshotId: "s1", forks: [{ vmId: "a", state: "running" }, { vmId: "b", state: "failed", error: "boom" }] }),
    );
    vi.stubGlobal("fetch", f);
    const r = await client.runtime.fork("vm1");
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ count: 1 });
    await client.runtime.fork("vm1", { count: 3 });
    expect(JSON.parse(f.mock.calls[1][1].body)).toEqual({ count: 3 });
    expect(r.forks[1].error).toBe("boom");
  });
});

describe("runtime.execStream", () => {
  it("parses SSE split across chunks and multibyte UTF-8 boundaries", async () => {
    const enc = new TextEncoder();
    const bytes = enc.encode(
      'event: stdout\ndata: {"data":"héllo €"}\n\nevent: stderr\ndata: {"data":"warn"}\n\nevent: exit\ndata: {"exitCode":3}\n\n',
    );
    // split at every byte: worst case for chunk and multibyte boundaries
    const chunks = Array.from(bytes, (b) => new Uint8Array([b]));
    const f = vi.fn().mockResolvedValue(sse(chunks));
    vi.stubGlobal("fetch", f);
    const events = await collect(client.runtime.execStream("vm1", { command: "/bin/sh", argv: ["-c", "x"] }));
    expect(events).toEqual([
      { type: "stdout", data: "héllo €" },
      { type: "stderr", data: "warn" },
      { type: "exit", exitCode: 3 },
    ]);
    expect(f.mock.calls[0][1].headers.Accept).toBe("text/event-stream");
  });

  it("throws on an error event", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse([new TextEncoder().encode('event: error\ndata: {"error":"vm gone"}\n\n')])));
    await expect(collect(client.runtime.execStream("vm1", { command: "ls" }))).rejects.toBeInstanceOf(MessageStreamError);
  });

  it("throws LanternApiError on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("conflict", { status: 409 })));
    await expect(collect(client.runtime.execStream("vm1", { command: "ls" }))).rejects.toBeInstanceOf(LanternApiError);
  });
});

describe("runtime.get/list normalization", () => {
  it("unwraps {vm, events} and bare arrays", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ vm: { vmId: "v", state: "paused", snapshotId: "s" }, events: [] })));
    expect((await client.runtime.get("v")).snapshotId).toBe("s");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json([{ vmId: "v", state: "running" }])));
    expect(await client.runtime.list()).toHaveLength(1);
  });
});
