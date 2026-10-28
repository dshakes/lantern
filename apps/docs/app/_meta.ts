import type { Metadata } from "next";

// Per-page title + description, one entry per route. Pages call pageMeta("/route");
// scripts/build-search-index.mjs fails the build if a built page has no entry here
// or its <h1> drifts from the title, so a new page cannot ship without metadata.
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://dshakes.github.io/lantern";
export const DOCS_URL = `${SITE_URL}/docs`;

export const PAGES: Record<string, { title: string; description: string }> = {
  "/": { title: "Run agents in production, on infrastructure you control.", description: "Lantern is the self-hosted runtime for AI agents. The agent loop runs on your control plane; untrusted code runs in its own microVM." },
  "/accounts": { title: "Accounts & sign-up", description: "How people get into a Lantern deployment and how they leave: gated sign-up, email verification, password reset, data export and workspace deletion." },
  "/agents": { title: "Agents", description: "An agent takes input, works through steps (LLM calls, tool calls, API requests) and returns output." },
  "/api": { title: "API Reference", description: "The control plane serves REST on :8080. Every /v1/ endpoint takes a Bearer token: a dashboard JWT or an API key." },
  "/architecture": { title: "Architecture explorer", description: "Every box below is a real process and every arrow a real call." },
  "/budgets": { title: "Budgets", description: "Per-agent spend and rate limits, set as policy. With hardFail: true, a call that would start while a limit is already reached is refused before the model is..." },
  "/cli": { title: "CLI Reference", description: "One static Go binary. It boots the local stack, scaffolds and runs agents, gates CI on evals, drives sandbox VMs, and installs the data plane in your cloud." },
  "/connectors": { title: "Connectors", description: "A connector gives an agent hands: search a Gmail inbox, open a GitHub issue, post to Slack. Lantern ships 18, each with a fixed set of actions." },
  "/demo": { title: "Demo mode", description: "lantern demo starts the whole stack in kiosk mode: every visitor gets a private workspace with sample agents, a guided tour, and no sign-up." },
  "/deployment": { title: "Deployment", description: "Lantern splits into a control plane (scheduling, routing, dashboard) and a data plane (microVMs, execution, secrets)." },
  "/env-vars": { title: "Environment variables", description: "Every environment variable the control plane, schedulers, runtime manager, in-VM harness and dashboard read, with defaults and which are required in production." },
  "/evaluations": { title: "Evaluations", description: "Test agents against fixed cases, fail CI on regressions, split traffic between versions, and collect human feedback." },
  "/examples": { title: "Examples", description: "Runnable, end-to-end agents. Each lives under examples/ in the repo with a README and an end-to-end test that runs it against recorded GitHub, Sentry,..." },
  "/human-in-the-loop": { title: "Human-in-the-loop", description: "Two ways to put a person in a workflow: approval nodes you place yourself, and the confidence gate (off by default), which diverts low-confidence steps to a..." },
  "/installation": { title: "Installation", description: "Clone, start the stack, verify it's healthy. Only want to look around? make demo needs Docker and no API key; see Demo mode." },
  "/knowledge": { title: "Knowledge base & human handoff", description: "Upload documents to an agent. Each one is split into chunks, embedded and stored in Postgres with pgvector." },
  "/marketplace": { title: "Marketplace & A2A", description: "Publish an agent, fork someone else's into your tenant, or call a published agent without forking it." },
  "/models": { title: "Models", description: "Agents ask for a capability such as reasoning-large. Lantern maps it to a concrete model from the providers you have keyed." },
  "/operations": { title: "Operations", description: "After helm install: scrape metrics, wire alerts, keep backups you have restored, run the restore drill, upgrade from the Bitnami-based chart, and run demo mode." },
  "/personal": { title: "Personal harness — your phone, your bot", description: "The iMessage + WhatsApp bridges run on your own Mac and answer as you." },
  "/quickstart": { title: "Get started", description: "Describe what you want your agent to do in plain language. Lantern's onboarding agent designs it, checks your model key with a real call, creates it, and..." },
  "/runtime": { title: "Agent runtime", description: "Every Lantern run executes in one of two tiers — shared (inline executor inside the control-plane) or microVM (W12 Kubernetes/Firecracker/Kata stack) —..." },
  "/runtime/durable-execution": { title: "Durable execution", description: "A crash mid-run does not lose work, re-spend tokens, or fire a side effect twice." },
  "/runtime/egress": { title: "Egress and credentials", description: "A sandbox is only as safe as its way out. Lantern ships two egress modes." },
  "/runtime/identity": { title: "Identity & Secrets", description: "Every headless agent spawn gets its own cryptographic identity, and secrets are vended to it at execution time over a mutually-authenticated channel — never..." },
  "/runtime/isolation": { title: "Isolation Classes", description: "Every headless agent declares an isolation class in its agent.yaml. The class is the security boundary the workload runs behind." },
  "/runtime/local-microvms": { title: "Run real microVMs on your Mac", description: "On an Apple Silicon Mac you can run real Firecracker microVMs locally: a Lima Linux guest with nested virtualization provides /dev/kvm, and the..." },
  "/runtime/observability": { title: "Observability", description: "One OTel trace per spawn, GenAI token telemetry, real-time anomaly detection — wired through standard OpenTelemetry." },
  "/runtime/quickstart": { title: "Headless Agent Quickstart", description: "Write your first agent.yaml, pick an isolation class, run it, watch its logs / traces / cost, then terminate it — end to end in about 15 minutes." },
  "/runtime/receipts": { title: "Verifiable receipts", description: "When a headless agent finishes, you can ask the runtime for a signed receipt — tamper-evident, offline-verifiable proof of what actually ran." },
  "/runtime/sandbox-lifecycle": { title: "Sandbox lifecycle", description: "MicroVM sandboxes are stateful. A running VM suspends itself when idle and wakes on the next request; you can also pause it (snapshot, quota slot freed),..." },
  "/runtime/sessions-and-memory": { title: "Sessions and memory", description: "Sessions are interactive, multi-turn conversations with an agent." },
  "/runtime/streaming": { title: "Token streaming", description: "Session replies are streamed token-by-token from the model provider through the control-plane to the client." },
  "/scheduling": { title: "Scheduling", description: "Run an agent on a cron expression. Schedules are their own resource, so one agent can have many, each with its own input and timezone." },
  "/sdk": { title: "SDK Reference", description: "Three SDKs: TypeScript (@lantern/sdk), Python (lantern-sdk, imported as lantern) and Go (github.com/dshakes/lantern/packages/sdk-go)." },
  "/security": { title: "Security", description: "Each hop between the caller, the control plane, the data-plane host and the microVM is a trust boundary with its own credential, and untrusted code sits..." },
  "/stack": { title: "The Stack", description: "Four languages, three data stores, one contract format. This page answers “why is there Rust and Go in here?”: what each piece does and why it went to that..." },
  "/surfaces": { title: "Surfaces", description: "A surface is a channel where people talk to an agent. Seven are wired: WhatsApp, iMessage, Slack, Discord, Telegram, voice and web chat." },
  "/testing": { title: "End-to-end tests", description: "make test-e2e runs Go suites against a live local stack over HTTP: real JWT login, real Postgres rows, no mocks." },
  "/triggers": { title: "Webhook triggers", description: "A trigger binds a public URL, POST /v1/hooks/{id}, to one agent." },
};

export function pageMeta(route: string): Metadata {
  const p = PAGES[route];
  if (!p) throw new Error(`_meta.ts: no entry for ${route}`);
  const url = `${DOCS_URL}${route === "/" ? "/" : route + "/"}`;
  const full = route === "/" ? p.title : `${p.title} — Lantern Docs`;
  return {
    title: route === "/" ? { absolute: "Lantern Docs" } : p.title,
    description: p.description,
    alternates: { canonical: url },
    openGraph: { type: "article", siteName: "Lantern Docs", title: full, description: p.description, url, images: [{ url: `${DOCS_URL}/og.png`, width: 1200, height: 630 }] },
    twitter: { card: "summary_large_image", title: full, description: p.description, images: [`${DOCS_URL}/og.png`] },
  };
}
