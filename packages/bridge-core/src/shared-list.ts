// Shared list — a persistent list the owner AND his inner circle (Manasa) both
// contribute to via the bot: "add milk to the list", "what's on our list?",
// "cross off milk". State is `<stateDir>/shared-list.json` (0600). Pure store;
// the bridge wires the spouse-agent + owner commands to it and can mirror to a
// Notes-app list for on-device visibility.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SharedListItem {
  text: string;
  addedBy: string; // "Manasa" | "owner" | a name
  addedMs: number;
}

const FILE = "shared-list.json";

function norm(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function loadList(stateDir: string): SharedListItem[] {
  try {
    const p = join(stateDir, FILE);
    if (!existsSync(p)) return [];
    const parsed = JSON.parse(readFileSync(p, "utf8")) as { items?: SharedListItem[] };
    return Array.isArray(parsed.items) ? parsed.items.filter((i) => i && typeof i.text === "string") : [];
  } catch {
    return [];
  }
}

function save(stateDir: string, items: SharedListItem[]): void {
  try {
    writeFileSync(join(stateDir, FILE), JSON.stringify({ items }, null, 2), { mode: 0o600 });
  } catch {
    /* best-effort */
  }
}

/** Add items (deduped by normalized text). Returns the ones actually added. */
export function addToList(stateDir: string, texts: string[], addedBy: string, nowMs: number): string[] {
  const items = loadList(stateDir);
  const have = new Set(items.map((i) => norm(i.text)));
  const added: string[] = [];
  for (const raw of texts) {
    const text = (raw || "").trim();
    if (!text || have.has(norm(text))) continue;
    have.add(norm(text));
    items.push({ text, addedBy, addedMs: nowMs });
    added.push(text);
  }
  if (added.length) save(stateDir, items);
  return added;
}

/** Remove items by fuzzy (normalized substring) match. Returns removed texts. */
export function removeFromList(stateDir: string, texts: string[]): string[] {
  const items = loadList(stateDir);
  const targets = texts.map(norm).filter(Boolean);
  if (targets.length === 0) return [];
  const removed: string[] = [];
  const kept = items.filter((it) => {
    const n = norm(it.text);
    const match = targets.some((t) => n === t || n.includes(t) || t.includes(n));
    if (match) removed.push(it.text);
    return !match;
  });
  if (removed.length) save(stateDir, kept);
  return removed;
}

export function clearList(stateDir: string): void {
  save(stateDir, []);
}

/** Render the list for a text message. */
export function renderList(items: SharedListItem[]): string {
  if (items.length === 0) return "🧺 the list is empty";
  const lines = [`🧺 our list (${items.length})`];
  for (const it of items) lines.push(`• ${it.text}`);
  return lines.join("\n");
}
