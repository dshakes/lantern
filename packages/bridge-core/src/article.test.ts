import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { extractArticleUrl, fetchArticle, buildArticleBlock } from "./article.ts";

describe("article", () => {
  test("extractArticleUrl: finds article URLs, skips videos/maps/auth/none", () => {
    assert.equal(extractArticleUrl("check this https://medium.com/p/abc def"), "https://medium.com/p/abc");
    assert.equal(extractArticleUrl("trailing dot https://example.com/post."), "https://example.com/post");
    assert.equal(extractArticleUrl("https://youtu.be/xyz watch this"), null);
    assert.equal(extractArticleUrl("https://meet.google.com/abc"), null);
    assert.equal(extractArticleUrl("no link here"), null);
  });

  test("fetchArticle: direct fetch when content is rich", async () => {
    const html = "<html><body>" + "<p>Speculative decoding gives 2x speedups in real workloads.</p>".repeat(20) + "</body></html>";
    const fetchImpl = (async () => ({ ok: true, text: async () => html })) as unknown as typeof fetch;
    const a = await fetchArticle("https://example.com/post", { fetchImpl });
    assert.equal(a?.via, "direct");
    assert.match(a?.text ?? "", /speculative decoding/i);
    assert.ok(!/<p>/.test(a?.text ?? ""), "html stripped");
  });

  test("fetchArticle: falls back to reader proxy when direct is thin", async () => {
    let calls = 0;
    const fetchImpl = (async (u: string) => {
      calls++;
      if (u.includes("r.jina.ai")) {
        return { ok: true, text: async () => "Title\n\n" + "real extracted article body about RL updates. ".repeat(30) };
      }
      return { ok: true, text: async () => "<html><body>Enable JS</body></html>" }; // thin
    }) as unknown as typeof fetch;
    const a = await fetchArticle("https://medium.com/p/x", { fetchImpl });
    assert.equal(a?.via, "reader");
    assert.match(a?.text ?? "", /RL updates/);
    assert.equal(calls, 2);
  });

  test("fetchArticle: null when nothing substantive (never blocks a reply)", async () => {
    const fetchImpl = (async () => ({ ok: true, text: async () => "<html></html>" })) as unknown as typeof fetch;
    assert.equal(await fetchArticle("https://x.com/y", { fetchImpl }), null);
    const errImpl = (async () => { throw new Error("net"); }) as unknown as typeof fetch;
    assert.equal(await fetchArticle("https://x.com/y", { fetchImpl: errImpl }), null);
  });

  test("buildArticleBlock: instructs grounding on real content, forbids generic", () => {
    const b = buildArticleBlock({ url: "https://x/p", text: "Speculative decoding at 85% acceptance.", via: "reader" }, "Kel", "Shekhar");
    assert.match(b, /READ it/);
    assert.match(b, /85%/);
    assert.match(b, /NEVER a generic/);
  });
});
