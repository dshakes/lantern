# ADR 0013 — Real gRPC surfaces for billing + scheduler; memory stays REST-only

- **Status:** Accepted
- **Date:** 2026-06-23
- **Deciders:** Lantern control-plane / services team
- **Tags:** grpc, protobuf, billing, scheduler, memory, health
- **Related:** [CLAUDE.md](../../CLAUDE.md) (proto workflow, invariants #2/#6/#7), `packages/proto/lantern/v1/`

## Context

The `billing`, `scheduler`, and `memory` services each stood up a `grpc.Server`,
constructed their handler, and then **threw the handler away**:

```go
billingSvc := handlers.NewBillingService(srv)
_ = billingSvc // Registered via gRPC service descriptor when proto is generated.
```

No proto existed, so nothing was ever registered. Worse, each process then
advertised a per-service health status for a service name that has **no proto
definition at all**:

```go
healthSvc.SetServingStatus("lantern.v1.BillingService", healthpb.HealthCheckResponse_SERVING)
```

A health probe or service mesh querying `lantern.v1.BillingService` /
`lantern.v1.SchedulerService` / `lantern.v1.MemoryService` got `SERVING` for an
RPC surface that did not exist and could never answer. The services were both
**not callable** and **lying about being callable**.

The handlers themselves were already written (`EmitUsage`, `CheckBudget`,
`GetUsage`, `SetBudget`; `RegisterSchedule`, `ListSchedules`, `DeleteSchedule`,
`Trigger`) — only the proto contract and the registration were missing.

The repo's `gen/go` Go stubs are **hand-maintained and the source of truth**
(see CLAUDE.md "Real protoc Go codegen"); `make proto` regenerates all files and
can diverge from the hand stubs, so a blanket regen is unsafe.

## Decision

### Billing + scheduler: author real protos and register

Add `packages/proto/lantern/v1/billing.proto` and `scheduler.proto` in the
existing `lantern.v1` package / `go_package` style, with RPCs matching the
existing handler method surface one-to-one. Generate **only** those two files
into `gen/go` (`protoc` targeting just the new `.proto`s,
`paths=source_relative`, mirroring the Makefile `proto` flags) so no
pre-existing hand-maintained stub is touched. Then:

- Handlers implement the generated `BillingServiceServer` /
  `SchedulerServiceServer` interfaces directly (proto types become the wire
  types — invariant #6), embedding the `Unimplemented…Server` for forward
  compatibility.
- `main.go` replaces `_ = svc` with `RegisterBillingServiceServer` /
  `RegisterSchedulerServiceServer`. The pre-existing per-service health
  advertisement is now **true** because the service is actually registered.

Tenant continues to ride in gRPC metadata, not the request body (invariant #7),
so the proto request messages carry no `tenant_id`. A fired schedule still
creates runs via the control-plane `RunService` (invariant #2); the scheduler
proto does not mutate run state itself.

### Memory: no proto; REST-only via control-plane

Memory deliberately gets **no** `lantern.v1.MemoryService` proto. A canonical
unified-memory + person-graph surface already exists in the control-plane over
REST (`/v1/memory/*`, `/v1/people/*` — see CLAUDE.md "Cross-channel unified
memory"). A parallel gRPC MemoryService would duplicate that surface and create
a second contract to keep in sync, for no consumer that needs it.

So the memory service's `main.go`:

- drops the dead `_ = memorySvc` placeholder (and the now-unused embedding
  plumbing it fed);
- **stops advertising** `lantern.v1.MemoryService` over gRPC health — it sets
  only the overall server status (`""`), which is honest: the process serves
  gRPC health + reflection for liveness, and nothing else;
- documents in a comment that memory is served over REST by the control-plane.

## Consequences

### Positive
1. Billing and scheduler are now actually callable over gRPC, and their health
   advertisement reflects reality.
2. No pre-existing `gen/go` stub was modified — only four new files
   (`billing*.pb.go`, `scheduler*.pb.go`) were added, keeping the
   hand-maintained-stub invariant intact.
3. Memory no longer falsely claims a non-existent service is `SERVING`; the
   single REST memory surface stays the one source of truth.

### Negative / trade-offs
1. The new generated files were produced with `protoc-gen-go v1.36.6` while
   existing stubs carry a `v1.36.11` header. The wire format and Go API are
   compatible; the header skew is cosmetic. A future full `make proto` will
   normalize headers (and must be reviewed against the hand stubs as usual).
2. The scheduler handler now converts `structpb.Struct` ↔ JSONB at the DB
   boundary (input templates / trigger inputs), a small mapping layer the
   plain-struct version didn't need.

### Neutral
- `delay` on `Trigger` is expressed as `delay_ms` (int64) on the wire; the
  handler converts to a `time.Duration` internally.
- The memory gRPC server is retained (health + reflection only) so existing
  liveness probes keep working unchanged.

## Verification
- `go vet ./... && go build ./... && go test -race ./...` green for
  `services/billing` and `services/scheduler` (including new bufconn smoke
  tests asserting each registered service answers a representative RPC and is
  listed by server reflection).
- `gen/go` and `services/control-plane` (which share the `gen/go` module) build
  green with the additive generated files.
