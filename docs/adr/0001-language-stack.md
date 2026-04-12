# ADR 0001 — Polyglot language stack: Go, Rust, TypeScript, Python

- **Status:** Accepted
- **Date:** 2026-04-11
- **Deciders:** Lantern architecture team
- **Tags:** stack, polyglot

## Context

Lantern is a multi-layer system with very different demands per layer:

| Layer | Demands |
|---|---|
| Control plane / workflow engine | High concurrency, strong gRPC ecosystem, tight K8s API integration, fast iteration on CRUD logic |
| Runtime data plane (Firecracker, snapshotting, gateway streaming proxy) | Predictable tail latency, no GC pauses, low memory overhead, native FFI to libraries like Firecracker (which is Rust) |
| Model router | Same as runtime data plane — hot path, streaming, must not stall |
| Web dashboard, landing, docs | RSC + streaming + complex UI |
| Primary SDK | Where the agent ecosystem already lives |
| Secondary SDKs | AI/ML users; infra users |
| CLI | Single static binary, easy cross-compile |

A monoglot stack would force compromises in at least one of these layers. We considered the alternatives:

| Option | Rejected because |
|---|---|
| **Go everywhere** | GC pauses on the streaming hot path; awkward for SDK ergonomics in TS/Python where users live; no strong story for Firecracker/microVM control |
| **Rust everywhere** | Slow iteration on CRUD-heavy services; ecosystem for Postgres + Redis + K8s client work is less mature than Go's; harder to hire for |
| **TypeScript everywhere (Bun/Node)** | Wrong tool for the runtime data plane and snapshotter; weaker story for K8s controllers; worse perf on the model router hot path |
| **Python everywhere** | Wrong tool for both the control plane and the data plane; we'd be the slowest serverless platform on the market |

## Decision

We use four languages, each in the layer where it is unambiguously the best choice:

- **Go** — `control-plane`, `workflow-engine`, `memory`, `notifier`, `billing`, `scheduler`, `cli`, `sdk-go`
- **Rust** — `runtime-manager`, `gateway`, `model-router`, snapshotter binaries
- **TypeScript / Next.js 15** — `apps/web`, `apps/landing`, `apps/docs-site`, `packages/sdk-ts`, `packages/ui-kit`
- **Python** — `packages/sdk-python`

A single source of truth for cross-service types lives in `packages/proto/` (protobuf3) and codegens to all four languages.

**No new language without a new ADR.** This is the boundary.

## Consequences

### Positive

1. Each layer uses the right tool. We are not paying a polyglot tax in productivity, we are getting one in correctness.
2. The community for each layer aligns with what we're building (Go for K8s, Rust for low-level systems, TS for AI SDK ergonomics).
3. Hiring is easier per-layer than for a full-stack Rust/Go shop — we can hire a TS frontend engineer who never touches Rust.
4. The protobuf-first cross-service contract makes language boundaries safe.

### Negative

1. **Build complexity is higher.** We need a `make` toolchain that builds all four. Mitigation: a single `make ci-local` target; strong Bazel-or-Just setup.
2. **More dependency surfaces to keep current.** Mitigation: Renovate bot, weekly cadence.
3. **Polyglot CI is slower.** Mitigation: parallel CI matrix per language; strict caching.
4. **Onboarding is steeper.** Mitigation: `CLAUDE.md` and `docs/architecture/01-overview.md` map each layer to the right language up-front.

### Mitigations baked into the repo

- `make` targets per language and a top-level `make ci-local` that runs the matrix locally.
- A single `Justfile` (or equivalent) at the repo root that abstracts the per-language commands.
- One CI workflow per language, gated by path filters.
- Generated code lives in language-specific subdirs and is checked in (so consumers don't need protoc).
- A monorepo policy: changes that touch protos must regenerate and commit all generated outputs in the same PR.

## Alternatives considered (deeper)

### Rust-only data plane + Go-only control plane (drop TS for Python in SDKs)
Tempting, but the agent ecosystem is unambiguously TypeScript-first today. Shipping a TS SDK as primary is a hard requirement; Python is a strong second.

### Single-language SDK (TS only)
Makes the spec ambiguous. Python users will (rightly) reach for the Python SDK; Go users will reach for the Go SDK. Better to ship all three in parallel from the proto-generated client.

### Use Bun for the gateway and ditch Rust
Bun is fast but not predictable; we need 99th percentile latency guarantees on the streaming proxy that Rust + Tokio can give and a Bun runtime cannot.

## References

- `docs/architecture/01-overview.md` — overall component map
- `CLAUDE.md` — repo conventions
- Vercel AI Gateway docs (referenced design pattern)
- Firecracker (Rust) — why the runtime manager must speak Rust natively
