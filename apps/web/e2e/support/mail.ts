import fs from "node:fs";
import { CP_LOG } from "./env";

// The control-plane runs with PAL_MAILER=log (dev), which writes the whole
// message body to its JSON log. Poll that log for the newest mail to `to` and
// return the first URL in it.
export async function mailLink(to: string, subjectIncludes: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lines = fs.existsSync(CP_LOG) ? fs.readFileSync(CP_LOG, "utf8").split("\n").reverse() : [];
    for (const l of lines) {
      if (!l.includes('"mailer(log)') && !l.includes("mailer(log)")) continue;
      try {
        const e = JSON.parse(l) as { to?: string; subject?: string; body?: string };
        if (e.to === to && e.subject?.includes(subjectIncludes)) {
          const m = e.body?.match(/https?:\/\/\S+/);
          // The link carries the configured public origin; the test dashboard is elsewhere.
          if (m) { const u = new URL(m[0]); return u.pathname + u.search; }
        }
      } catch {
        /* not a JSON line */
      }
    }
    if (Date.now() > deadline) throw new Error(`no "${subjectIncludes}" mail for ${to} in ${CP_LOG}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}
