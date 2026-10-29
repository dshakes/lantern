/**
 * Responsive check script for Lantern public sites.
 * Run from: apps/web/ (playwright installed there)
 * Usage: node /path/to/resp-check.mjs
 */
import { chromium } from "@playwright/test";
import fs from "fs";
import path from "path";

const BASE = "http://127.0.0.1:4001";
const CHROMIUM_EXEC = "/Users/shakes/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const SHOTS_DIR = "/private/tmp/claude-501/-Users-shakes-workspace-lantern/68c52fd5-5bc5-4aab-8406-9f904c8b340b/scratchpad/shots";

const WIDTHS = [320, 360, 375, 390, 414, 430, 768, 820, 1024, 1280, 1440, 1920];
const TOUCH_WIDTHS = new Set([320, 360, 375, 390, 414, 430, 768, 820]);

const ALL_PAGES = [
  { path: "/lantern/", label: "landing-home" },
  { path: "/lantern/#compare", label: "landing-compare" },
  { path: "/lantern/docs/", label: "docs-home" },
  { path: "/lantern/docs/quickstart/", label: "docs-quickstart" },
  { path: "/lantern/docs/architecture/", label: "docs-architecture" },
  { path: "/lantern/docs/api/", label: "docs-api" },
  { path: "/lantern/docs/cli/", label: "docs-cli" },
  { path: "/lantern/docs/env-vars/", label: "docs-env-vars" },
  { path: "/lantern/docs/runtime/", label: "docs-runtime" },
  { path: "/lantern/docs/budgets/", label: "docs-budgets" },
  { path: "/lantern/docs/operations/", label: "docs-operations" },
];

const SCREENSHOT_SPEC = [
  { label: "landing-home",    path: "/lantern/",               widths: [320, 390, 768, 1024, 1440], themes: ["dark","light"] },
  { label: "landing-compare", path: "/lantern/#compare",       widths: [320, 390, 768, 1024, 1440], themes: ["dark","light"] },
  { label: "docs-home",       path: "/lantern/docs/",          widths: [320, 390, 768, 1024, 1440], themes: ["dark"] },
  { label: "docs-env-vars",   path: "/lantern/docs/env-vars/", widths: [320, 390, 768, 1024, 1440], themes: ["dark"] },
];

const failures = [];

async function checkPage(browser, pg, width) {
  const isTouch = TOUCH_WIDTHS.has(width);
  const height = isTouch ? 812 : 900;
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: isTouch ? 2 : 1,
    isMobile: isTouch,
    hasTouch: isTouch,
    colorScheme: "dark",
  });
  const page = await ctx.newPage();

  try {
    await page.goto(BASE + pg.path, { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(400);

    // Check 1: horizontal scroll
    const sc = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      iw: window.innerWidth,
    }));
    if (sc.sw > sc.iw + 2) {
      failures.push({ page: pg.label, width, check: "horizontal-scroll",
        detail: `scrollWidth=${sc.sw} > innerWidth=${sc.iw}` });
    }

    // Check 2: elements overflowing viewport width (ignoring scroll containers)
    const overflows = await page.evaluate((vw) => {
      const results = [];
      for (const el of document.querySelectorAll("*")) {
        // Skip if inside a scroll container
        let p = el.parentElement;
        let inScroll = false;
        while (p) {
          const ps = getComputedStyle(p);
          if (ps.overflowX === "auto" || ps.overflowX === "scroll") { inScroll = true; break; }
          p = p.parentElement;
        }
        if (inScroll) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 2) continue;
        const right = rect.left + rect.width;
        if (right > vw + 4) {
          const st = getComputedStyle(el);
          if (st.position === "fixed" || st.position === "absolute") continue;
          // Skip hidden elements
          if (st.display === "none" || st.visibility === "hidden") continue;
          results.push({ tag: el.tagName.toLowerCase(), cls: (el.className||"").toString().slice(0,50), w: Math.round(rect.width), x: Math.round(rect.left), right: Math.round(right) });
        }
      }
      return results.slice(0, 5);
    }, width);

    if (overflows.length > 0) {
      failures.push({ page: pg.label, width, check: "overflow-x",
        detail: overflows.map(e => `<${e.tag} class="${e.cls}"> w=${e.w} x=${e.x} right=${e.right}`).join(" | ") });
    }

    // Check 3: tap targets >= 40px on touch widths
    if (isTouch) {
      const smalls = await page.evaluate((vw) => {
        const res = [];
        for (const el of document.querySelectorAll("a[href], button")) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden") continue;
          // Skip sr-only / clip-path hidden elements (visually hidden, not tappable at rest)
          if (cs.clipPath && cs.clipPath !== "none") continue;
          // Skip inline elements (text links embedded in paragraphs/lists; WCAG 2.5.8 inline exception)
          if (cs.display === "inline") continue;
          // Skip elements entirely off-screen (e.g. closed slide-out sidebar)
          if (rect.right < 0 || rect.left > vw) continue;
          if (rect.width < 40 || rect.height < 40) {
            res.push({ tag: el.tagName.toLowerCase(), text: (el.textContent||"").trim().slice(0,30), w: Math.round(rect.width), h: Math.round(rect.height) });
          }
        }
        return res.slice(0, 5);
      }, width);
      if (smalls.length > 0) {
        failures.push({ page: pg.label, width, check: "tap-target",
          detail: smalls.map(t => `${t.tag}:"${t.text}" ${t.w}x${t.h}`).join(" | ") });
      }
    }

    // Check 4: text >= 12px (font-size below 12px is unusable)
    const smallText = await page.evaluate(() => {
      const res = [];
      for (const el of document.querySelectorAll("p, li, td, th, a")) {
        const text = (el.textContent||"").trim();
        if (text.length < 4) continue;
        // Only direct text-bearing elements
        const size = parseFloat(getComputedStyle(el).fontSize);
        if (size < 12) {
          res.push({ tag: el.tagName.toLowerCase(), text: text.slice(0,30), size });
        }
      }
      return res.slice(0, 3);
    });
    if (smallText.length > 0) {
      failures.push({ page: pg.label, width, check: "text-size<12px",
        detail: smallText.map(t => `${t.tag}:"${t.text}" ${t.size}px`).join(" | ") });
    }

  } catch(err) {
    failures.push({ page: pg.label, width, check: "load-error", detail: String(err).slice(0, 100) });
  } finally {
    await ctx.close();
  }
}

async function takeScreenshot(browser, spec, width, theme) {
  const isTouch = TOUCH_WIDTHS.has(width);
  const height = isTouch ? 812 : 900;
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: isTouch ? 2 : 1,
    isMobile: isTouch,
    hasTouch: isTouch,
    colorScheme: theme === "dark" ? "dark" : "light",
  });
  const page = await ctx.newPage();
  await page.addInitScript((t) => { try { localStorage.setItem("lantern-theme", t); } catch {} }, theme);

  try {
    await page.goto(BASE + spec.path, { waitUntil: "networkidle", timeout: 20000 });
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    await page.waitForTimeout(300);
    const fname = `resp-${spec.label}-${width}-${theme}.png`;
    await page.screenshot({ path: path.join(SHOTS_DIR, fname), fullPage: false });
    console.log(`📸 ${fname}`);
  } catch(err) {
    console.error(`Screenshot failed ${spec.label}@${width}/${theme}: ${err}`);
  } finally {
    await ctx.close();
  }
}

async function main() {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });

  const browser = await chromium.launch({
    executablePath: CHROMIUM_EXEC,
    headless: true,
  });

  let done = 0;
  const total = ALL_PAGES.length * WIDTHS.length;

  for (const pg of ALL_PAGES) {
    for (const width of WIDTHS) {
      await checkPage(browser, pg, width);
      done++;
      if (done % 20 === 0) process.stdout.write(`\rchecks: ${done}/${total}`);
    }
  }
  process.stdout.write(`\rchecks: ${total}/${total}\n`);

  // Screenshots
  for (const spec of SCREENSHOT_SPEC) {
    for (const width of spec.widths) {
      for (const theme of spec.themes) {
        await takeScreenshot(browser, spec, width, theme);
      }
    }
  }

  await browser.close();

  // Report
  console.log(`\n=== RESULTS ===`);
  console.log(`Total checks: ${total}, Failures: ${failures.length}`);

  if (failures.length > 0) {
    // Group by page+check
    const grouped = new Map();
    for (const f of failures) {
      const key = `${f.page}::${f.check}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(f);
    }
    for (const [key, fs] of grouped) {
      const [pg, chk] = key.split("::");
      console.log(`\n[FAIL] ${pg} — ${chk}:`);
      for (const f of fs) {
        console.log(`  w=${f.width}: ${f.detail.slice(0,120)}`);
      }
    }
  }

  fs.writeFileSync(path.join(SHOTS_DIR, "failures.json"), JSON.stringify(failures, null, 2));
  console.log(`\nReport: ${path.join(SHOTS_DIR, "failures.json")}`);
}

main().catch(e => { console.error(e); process.exit(1); });
