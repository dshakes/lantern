// Refreshes src/components/docs/env-vars.json from the env reads in the code on
// a git ref (default origin/master). Run from site/: `node scripts/gen-env-data.mjs [ref]`.
//
// The JSON is the source of truth for descriptions and defaults (hand-written);
// this script only refreshes WHICH variables exist and WHERE they are read.
// New variables get an empty description; variables no longer read are dropped.
// LANTERN_* reads are folded into PAL_* (ADR 0032: both spellings are honoured).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const ref = process.argv[2] || 'origin/master';
const out = new URL('../src/components/docs/env-vars.json', import.meta.url);

// A "read" is the name inside a string literal, a process.env access, or a shell expansion.
const pattern = '(["\'`]|process\\.env\\.|\\$\\{?)(PAL|LANTERN)_[A-Z0-9_]+';
const raw = execFileSync('git', ['grep', '-n', '-o', '-E', pattern, ref, '--',
  'services', 'packages', 'apps', 'infra/helm', 'scripts',
  ':!*_test.go', ':!*.test.ts', ':!*.test.tsx', ':!*.spec.ts', ':!**/tests/**', ':!**/test_*.py',
  ':!*.md', ':!*.mdx', ':!**/node_modules/**', ':!packages/palenv/**', ':!packages/pal-env-rs/**',
], { cwd: new URL('../..', import.meta.url) /* repo root: pathspecs are root-relative */, maxBuffer: 64 << 20 }).toString();

const found = new Map(); // name -> { services:Set, sources:Set }
for (const line of raw.split('\n')) {
  const m = line.match(/^[^:]+:([^:]+):(\d+):.*?(?:PAL|LANTERN)_([A-Z0-9_]+)$/);
  if (!m) continue;
  const [, file, ln, suffix] = m;
  if (suffix.endsWith('_') || suffix.length < 2) continue; // prefixes like PAL_NODE_ADDR_<NODE>
  const name = `PAL_${suffix}`;
  const parts = file.split('/');
  const service = parts[0] === 'scripts' ? 'scripts' : parts[1];
  const e = found.get(name) ?? { services: new Set(), sources: new Set() };
  e.services.add(service);
  if (e.sources.size < 3) e.sources.add(`${file}:${ln}`);
  found.set(name, e);
}

// Fallback group for variables the hand-written data has not placed yet.
function groupOf(services) {
  const s = [...services];
  if (s.some((x) => /bridge/.test(x))) return 'pal: chat bridges (iMessage, WhatsApp)';
  if (s.some((x) => /^sdk-|^cli$/.test(x))) return 'SDKs and CLI';
  if (s.includes('scripts')) return 'Scripts and benchmarks';
  return `Service: ${s[0]}`;
}

const prev = JSON.parse(readFileSync(out, 'utf8'));
const byName = new Map(prev.map((v) => [v.name, v]));
const rows = [];
for (const [name, e] of found) {
  const old = byName.get(name) ?? {};
  rows.push({
    name,
    services: [...e.services].sort(),
    group: old.group || groupOf(e.services),
    default: old.default ?? '',
    description: old.description ?? '',
    prod: old.prod ?? false,
    source: [...e.sources][0],
  });
}
// Non-PAL variables (DATABASE_URL, JWT_SECRET, ...) are kept as written by hand.
for (const v of prev) if (!v.name.startsWith('PAL_')) rows.push(v);
rows.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(out, JSON.stringify(rows, null, 1) + '\n');
console.log(`${rows.length} variables (${found.size} PAL_* read in code on ${ref})`);
