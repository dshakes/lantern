# Lantern brand: glass and flame

A lantern is a flame you can carry because glass keeps it contained. That is the
product: the agent's untrusted code is the flame, the microVM is the glass, and
the host is the brass frame that decides what gets in or out. Every color,
shape and motion below encodes one of those roles, so a reader can tell from a
diagram alone which side of a boundary something lives on.

Canonical tokens: [`tokens.css`](tokens.css). Diagram source:
[`diagram-template.svg`](diagram-template.svg). Gate: `scripts/check-diagrams.sh`.

## Color

Each hue is a role, never decoration. Light ("day") and dark ("night") are both
first-class; the system preference decides, and `<html data-theme="light|dark">`
overrides it.

| Token | Role | Day | Night |
|---|---|---|---|
| `--lx-bg` | page / canvas | `#f2f5f8` | `#0b1220` |
| `--lx-surface` | neutral node, card | `#ffffff` | `#111b2e` |
| `--lx-surface-2` | grouping band | `#e7edf3` | `#17243b` |
| `--lx-ink` / `-2` / `-3` | text, secondary, tertiary | `#0f1b2d` `#44546a` `#5d6d83` | `#e8eef5` `#a9b6c8` `#7a8aa2` |
| `--lx-line` | neutral stroke | `#c3cedb` | `#2b3b57` |
| `--lx-flame` | untrusted code, the guest workload | `#a85e06` | `#ffb547` |
| `--lx-glass` | the microVM wall, isolation | `#1c76a6` | `#7cc4e8` |
| `--lx-patina` | trusted host infrastructure (manager, broker, control plane internals) | `#17785f` | `#4fc1a6` |
| `--lx-signal` | denied, refused, a boundary that must not be crossed | `#c23b29` | `#ff7262` |

Each role color has a `-soft` fill for node backgrounds. Text sits on `ink`,
`ink-2` or `ink-3` only (all ≥ 4.5:1 on `bg` and `surface` in both themes);
role colors are for strokes, fills and large text.

Control-plane things stay neutral (`surface` + `line`). Color is spent only
where trust changes.

## Type

| Face | Use |
|---|---|
| Bricolage Grotesque (600–800, tight tracking) | display headlines on landing and docs home only |
| IBM Plex Sans (400/500/600) | all body copy, UI, and every diagram label |
| IBM Plex Mono (400/500) | code, commands, env vars, ports, file paths |

Sentence case everywhere. No all-caps labels, no eyebrow text above headings.
Diagrams fall back to `system-ui` / `ui-monospace` where web fonts are not
loaded (GitHub renders SVG via `<img>`).

Scale (rem, 1.25 ratio from 1rem): 0.8 · 1 · 1.25 · 1.56 · 1.95 · 2.44 · 3.05 ·
clamp() up to 4.75 for the landing hero.

## Shape

- Radius: 6px chips/inputs, 10px nodes and code, 18px groups and the microVM wall.
- Strokes: 1.5px nodes and edges, 2.5px for the microVM wall (the thickest line in any diagram), 1.25px dashed for a trust boundary, dashed signal for a denied path.
- Arrows: one filled triangle marker per role color.

## Motion

Motion means something moved through the system, so it is reserved for that.

- **Packet**: a dot travels a conduit at constant speed (linear, `--lx-dur-packet` 2.8s), never eased. When it crosses the microVM wall the wall brightens for 160ms.
- **State**: lifecycle states change with a 160ms cross-fade (`--lx-ease`).
- **Response**: UI responds to a person's action in `--lx-dur-ui` (160ms). No entrance animations on scroll, no hover lifts.
- `prefers-reduced-motion: reduce` shows the final static frame; nothing loops.

## Diagrams

Copy `diagram-template.svg`: keep its `<style class="lx-style">` block byte-for-byte,
prefix every `id` with the file name, put an accessible `<title>`/`<desc>` first,
title states the claim in sentence case, legend bottom-left listing only roles
used. All diagrams live in `docs/assets/diagrams/`; the docs site inlines them
from there and `scripts/check-diagrams.sh` gates them.

## Adopting in the dashboard

`apps/web` keeps its own theme for now. To adopt: import the `:root` blocks from
`tokens.css`, map `--lx-surface*`/`--lx-ink*` onto the existing neutral scale, and
use the role colors only for trust-related UI (sandbox state, egress decisions,
denials).
