# ADR 0020 — Managed no-Mac onboarding architecture

- **Status:** Proposed
- **Date:** 2026-07-06
- **Deciders:** Shekhar Mudarapu, control-plane, personal-harness
- **Relates to:** W12 microVM runtime, control-plane/data-plane split

## Context

Today a new user of the *personal* side of Lantern effectively needs a Mac they
control: the bridges read `chat.db` (Full Disk Access), drive Messages/Calendar/
Notes/Mail via AppleScript automation, read `knowledgeC.db`, and keep all state
in local `~/.lantern/*.jsonl`. That is a hard onboarding wall — it excludes
everyone without an always-on Mac and makes "sign up and go" impossible.

But this framing conflates two products that the architecture already separates:

1. **The agent-runtime product** — the control-plane/data-plane platform
   (agents, runs, workflows, connectors, runtime microVMs, dashboard). This is
   **already** Mac-independent: it runs on Postgres/Redis/S3 + Go/Rust services
   and, per the deployment model, executes agent workloads either in managed
   cloud or in the customer's own VPC data plane (control-plane never touches
   user code — invariant #1). Nothing here needs a Mac. The "managed onboarding"
   task for this product is a **provisioning-flow** problem, not an
   architecture-change problem.

2. **The macOS personal bridges** — iMessage + WhatsApp. Parts of this are
   *inherently* Mac-bound and cannot be de-Mac'd; other parts are portable.

This ADR draws that line honestly and specifies the managed path for what *can*
move, while stating plainly what cannot.

## Decision

### Part A — Managed onboarding for the agent-runtime product (no Mac, ever)

This product already has no Mac dependency. "Managed no-Mac onboarding" here
means a hosted signup that provisions a working tenant without the user standing
up any infrastructure:

- **Signup** → existing `auth.go` register / OIDC (and SSO once ADR 0019 lands)
  creates the tenant + owner user. No change.
- **Execution target** — two modes, both already in the model:
  - **Managed cloud (default, zero-infra):** agent runs execute on Lantern-
    operated runtime nodes. The runtime-scheduler + runtime-manager +
    Firecracker/Kata path (ADR 0002–0008, W12) is exactly this. Onboarding just
    needs the managed node pool provisioned and the scheduler addr wired
    (`LANTERN_SCHEDULER_GRPC_ADDR`, required in prod).
  - **Customer-VPC data plane (BYO-cloud):** for customers who need code to run
    in their own VPC, `POST /v1/data-planes` registers an EKS/GKE/AKS data plane
    that heartbeats back; control-plane dispatches to it over gRPC. Already
    built (`data_planes` table, `dataplane.go`).
- **Provisioning flow (the actual onboarding work):** guided setup that (1)
  collects the tenant's LLM provider key (stored encrypted, `llm_provider_configs`),
  (2) offers a starter agent from the marketplace, (3) for BYO-cloud, walks the
  data-plane registration + bootstrap token. This is dashboard + CLI work
  (`lantern onboard`/`doctor` already exists per the Phase-2 effort), not a new
  runtime.

**Conclusion for Part A:** no architecture change required. The de-Mac'd managed
product is the control-plane/data-plane platform as it already stands; the deliverable
is a polished provisioning flow, not new isolation or hosting primitives.

### Part B — The personal bridges: what is portable vs. Mac-bound

The bridges bundle features with very different portability. Classify them:

| Bridge feature | Mac-bound? | Why / managed alternative |
|----------------|-----------|---------------------------|
| **iMessage channel** (`chat.db`, Messages AppleScript) | **HARD Mac-bound** | Apple provides no server API and no ToS-compliant cloud path. Cannot be managed. A hosted product cannot send/receive iMessage on the user's behalf. State this plainly to users. |
| **WhatsApp channel** (Baileys) | **Portable** | Baileys is a Node library talking to WhatsApp Web protocol — it runs on any Linux host, not just a Mac. The QR-pair + creds (`/session/:tenant/*`) can run in a managed container. This is the de-Mac'd personal channel. |
| Calendar / Notes / Mail actions (`mac-actions.ts` AppleScript) | **Mac-bound as written** | AppleScript is macOS-only. Managed alternative: swap the AppleScript backend for the **existing connector layer** — Google Calendar / Gmail / Notion connectors already exist in the 17-connector set. The `mac-actions` interface stays; the backend becomes a connector call for managed tenants. |
| `search_email` (Apple Mail Envelope Index) | **Mac-bound** | Reads local Mail SQLite. Managed alternative: Gmail/IMAP connector (OAuth), which is a superset and needs no Mac. |
| Personal-docs (`LANTERN_PERSONAL_DOCS_ROOTS`, OCR) | **Mac-bound (local FS)** | Reads the user's local disk. Managed alternative: Google Drive / iCloud-web / Dropbox connector as the doc source; OCR already goes through the control-plane `/v1/vision/ocr` endpoint, which is portable. |
| `knowledgeC.db` app-usage signal | **HARD Mac-bound** | Reads a private macOS DB. No cloud equivalent; drop in managed mode. |
| iPhone Shortcuts device signals (`/v1/signals`) | **Portable** | Already an HTTP endpoint on the control-plane through the tunnel — the iPhone posts directly, no Mac in the path. Works in managed mode unchanged. |
| Owner-profile, episodes, topic index, dislikes, all `~/.lantern/*.jsonl` state | **Portable (needs relocation)** | Logic is host-agnostic; only the *storage location* is local. For managed WhatsApp, this state moves to per-tenant encrypted storage (Postgres/S3, reusing the encrypt-at-rest posture) instead of `~/.lantern`. |
| Intelligence layer (identity, presence, thread-peek, working-memory) | **Mostly portable** | Pure modules over the state above. `thread-peek` into `chat.db` is Mac-bound; the WhatsApp thread source (wa-history) is portable. |

### Part C — The managed WhatsApp-personal path (the concrete de-Mac'd offering)

The one personal channel that can be fully managed is **WhatsApp**. Design:

- Run the WhatsApp bridge as a **per-tenant managed workload** — exactly the
  isolation primitive W12 already provides (a managed runtime container per
  tenant). One bridge process per tenant; the QR-pair happens in the dashboard,
  Baileys creds persist to per-tenant encrypted storage.
- **State relocation:** the `~/.lantern` JSONL stores become per-tenant rows/
  objects. The `secure-store.ts` AES-GCM envelope already used for the highest-
  PII stores is the pattern; extend it so the *storage backend* is pluggable
  (local file for self-host, encrypted Postgres/S3 for managed) behind the
  existing store interface. No logic change, only the persistence seam.
- **Mac-action features degrade to connectors** in managed mode: calendar/notes/
  mail/docs route through the connector layer instead of AppleScript. Features
  with no connector equivalent (iMessage, app-usage) are simply **absent** in
  managed mode and the UI says so.

**Do NOT** attempt to run the iMessage bridge as a managed service. It is
Apple-account-bound and requires a physical/virtual Mac the user has authorized
via TCC; there is no compliant server path. iMessage stays a self-hosted,
bring-your-own-Mac feature. The honest product story: "iMessage requires your
Mac; everything else — WhatsApp, agents, connectors — runs in our cloud."

## Consequences

- **+** The agent-runtime product needs *no* architectural work to be
  no-Mac-managed; it already is. This de-risks the biggest onboarding
  complaint immediately — the work is provisioning UX, not platform.
- **+** WhatsApp-personal becomes a genuine zero-Mac offering by reusing the W12
  per-tenant runtime + the existing encrypt-at-rest store, with Mac actions
  gracefully swapped for the existing connector layer.
- **+** Framing the personal features as portable-vs-Mac-bound gives a clear,
  honest capability matrix for the pricing/marketing page instead of an
  all-or-nothing "you need a Mac".
- **−** The state-storage seam (local file ↔ encrypted Postgres/S3) must be
  introduced across ~a dozen `~/.lantern/*.jsonl` stores. It is mechanical but
  broad; do it behind the existing store interfaces, one store at a time.
- **−** Managed WhatsApp puts a long-lived per-tenant Baileys session in our
  infra — an availability + WhatsApp-ToS surface (unofficial protocol) we do not
  carry today. Needs its own reliability + self-heal story (the bridge's
  decrypt-failure self-heal already exists; managed adds process supervision).
- **Hard limit:** iMessage cannot be de-Mac'd. Any roadmap claiming "fully
  managed personal assistant including iMessage" is false; the product must say
  so.
- **Invariant check:** managed WhatsApp state is tenant-scoped PII — it must land
  in RLS-covered tables (ADR 0011) with the encrypt-at-rest envelope, not a
  shared blob. That is the only new isolation requirement this introduces.
