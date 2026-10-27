// WCAG AA gate for the central theme in globals.css: every text token must
// clear 4.5:1 on every page/card/hover surface, in dark (the @theme block)
// and light (the :root[data-theme="light"] remap).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

function tokens(start: string): Record<string, string> {
  const i = css.indexOf(start);
  assert.ok(i >= 0, `missing block ${start}`);
  const body = css.slice(i, css.indexOf("}", i));
  return Object.fromEntries([...body.matchAll(/--color-([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const dark = tokens("@theme {");
const light = { ...dark, ...tokens(':root[data-theme="light"] {') };
const text = ["zinc-50", "zinc-100", "zinc-200", "zinc-300", "zinc-400", "zinc-500", "lantern-300", "lantern-400", "lantern-500"];
const surfaces = ["surface-0", "surface-1", "surface-2", "surface-3"];
// zinc-600 is the faint tier (timestamps, counts): AA on the page and on cards.
const faint = ["zinc-600"];
const faintSurfaces = ["surface-0", "surface-1"];

for (const [name, t] of [["dark", dark], ["light", light]] as const) {
  test(`${name}: text tokens clear AA on every surface`, () => {
    for (const fg of text) for (const bg of surfaces) {
      const r = ratio(t[fg], t[bg]);
      assert.ok(r >= 4.5, `${fg} ${t[fg]} on ${bg} ${t[bg]} = ${r.toFixed(2)}`);
    }
    for (const fg of faint) for (const bg of faintSurfaces) {
      const r = ratio(t[fg], t[bg]);
      assert.ok(r >= 4.5, `${fg} ${t[fg]} on ${bg} ${t[bg]} = ${r.toFixed(2)}`);
    }
  });
  test(`${name}: on-flame ink clears AA on solid flame fills`, () => {
    for (const bg of ["lantern-300", "lantern-400", "lantern-500"]) {
      const r = ratio(t["on-flame"], t[bg]);
      assert.ok(r >= 4.5, `on-flame on ${bg} = ${r.toFixed(2)}`);
    }
  });
}
