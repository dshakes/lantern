// Agentic article reading — when a contact shares a URL, FETCH and READ it so
// the reply grounds on the article's actual content, not a free-association from
// the title. The bot used to reply "thanks, good one" to a Medium link it never
// opened (the manager-article embarrassment). Pure-ish: a single network fetch,
// best-effort, fails closed to null (caller just skips the block). The reply
// turn then reasons over the real text — no separate LLM call needed here.

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/i;

// Domains where a "fetch + summarize" is pointless or wrong (videos, maps,
// meetings, auth) — never an article to read.
const SKIP_DOMAIN_RE =
  /(?:youtube\.com|youtu\.be|google\.[a-z.]+\/maps|maps\.app|\.zoom\.us|teams\.microsoft|meet\.google|calendly|\/login|\/signin|accounts\.google|whatsapp\.com|t\.me\/joinchat)/i;

/** First http(s) URL in the text worth reading as an article, or null. */
export function extractArticleUrl(text: string): string | null {
  const m = (text || "").match(URL_RE);
  if (!m) return null;
  const url = m[0].replace(/[.,;:!?)\]]+$/, "");
  if (SKIP_DOMAIN_RE.test(url)) return null;
  return url;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot|#\d+|#x[0-9a-f]+);/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ArticleContent {
  url: string;
  text: string;
  via: "direct" | "reader";
}

type FetchFn = typeof fetch;

const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36";

/**
 * Fetch + extract an article's readable text. Tries a direct fetch first; if the
 * result is thin (JS-rendered / soft-paywalled — Medium, Substack), retries
 * through the r.jina.ai reader proxy which renders + extracts. Returns null when
 * nothing substantive comes back (caller skips the block — never blocks a reply).
 */
export async function fetchArticle(
  url: string,
  opts: { timeoutMs?: number; maxChars?: number; fetchImpl?: FetchFn } = {},
): Promise<ArticleContent | null> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxChars = opts.maxChars ?? 6000;
  const f = opts.fetchImpl ?? fetch;

  const get = async (u: string): Promise<string | null> => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const r = await f(u, {
        headers: { "User-Agent": DESKTOP_UA, Accept: "text/html,text/plain,*/*" },
        signal: ctrl.signal,
        redirect: "follow",
      });
      clearTimeout(timer);
      if (!r.ok) return null;
      return await r.text();
    } catch {
      return null;
    }
  };

  // 1) direct fetch + strip
  const raw = await get(url);
  let text = raw ? stripHtml(raw) : "";
  let via: ArticleContent["via"] = "direct";

  // 2) reader-proxy fallback when the direct text is thin (paywall / JS render)
  if (text.length < 600) {
    const reader = await get("https://r.jina.ai/" + url);
    const readerText = reader ? reader.replace(/\s+/g, " ").trim() : "";
    if (readerText.length > text.length) {
      text = readerText;
      via = "reader";
    }
  }

  if (text.length < 200) return null; // nothing real to ground on
  return { url, text: text.slice(0, maxChars), via };
}

/** The systemHint block that grounds the reply on the real article content. */
export function buildArticleBlock(content: ArticleContent, contactLabel: string, ownerName: string): string {
  return (
    `## Article ${contactLabel} just shared — you READ it; respond to its ACTUAL content, not the title\n` +
    `URL: ${content.url}\n"""\n${content.text}\n"""\n` +
    `Reply as ${ownerName} would after actually reading it: ONE specific, substantive line — a real takeaway, an agree/push-back, or a sharp question about what it actually says. ` +
    `NEVER a generic "thanks, good one / will check it out / will let the team look" — that proves you didn't read it.`
  );
}
