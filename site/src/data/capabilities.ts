// Every capability the docs showcase: one line each, the page that explains it,
// and the diagram its thumbnail is drawn from (MiniFlow renders the same def
// the page's interactive diagram uses). Used by the docs home and /docs/capabilities/.
import type { FlowDef } from '../components/diagrams/FlowDiagram';
import type { SequenceDef } from '../components/diagrams/sequences';
import * as R from '../components/diagrams/flows-runtime';
import * as P from '../components/diagrams/flows-pal';
import * as X from '../components/diagrams/flows-more';
import { CHECKPOINT_SEQUENCE, EGRESS_SEQUENCE, LIFECYCLE_SEQUENCE, TOOL_SEQUENCE, RUN_SEQUENCE } from '../components/diagrams/sequences';

export type Capability = {
  title: string; line: string; href: string; product: 'pal' | 'rt';
  icon: string; group: string; def?: FlowDef; seq?: SequenceDef; featured?: boolean;
};

export const CAPABILITIES: Capability[] = [
  // ---- pal
  { product: 'pal', group: 'Every day', title: 'The Brief', icon: 'list-format', featured: true,
    line: 'One ranked list of what needs you: drafts, promises and threads left waiting.', href: '/docs/pal/daily/', def: P.BRIEF_ATTENTION },
  { product: 'pal', group: 'Trust', title: 'Holds', icon: 'padlock', featured: true,
    line: 'A reply that promises money or states what pal can’t verify waits for you.', href: '/docs/pal/human-in-the-loop/', def: P.HOLDS_GATES },
  { product: 'pal', group: 'Voice', title: 'Sounds like you', icon: 'comment', featured: true,
    line: 'Drafts are checked against your own sent messages before they go out.', href: '/docs/pal/voice/', def: P.VOICE_PIPELINE },
  { product: 'pal', group: 'Memory', title: 'One memory, every channel', icon: 'random',
    line: 'iMessage and WhatsApp share one person graph and timeline.', href: '/docs/pal/surfaces/', def: P.CROSS_CHANNEL_MEMORY },
  { product: 'pal', group: 'Every day', title: 'World model', icon: 'information',
    line: 'Mail, calendar and your own notes keep what pal knows about your life current.', href: '/docs/pal/daily/#the-world-model', def: P.WORLD_MODEL },
  { product: 'pal', group: 'Every day', title: 'Nudges', icon: 'clock',
    line: 'A heads-up before a meeting, a date, a reply you owe or a promise still open.', href: '/docs/pal/daily/#nudges', def: P.PROACTIVE_NUDGES },
  { product: 'pal', group: 'Every day', title: 'Skill forge', icon: 'puzzle',
    line: 'Teach a recurring task in one message; nothing runs until you approve it.', href: '/docs/pal/daily/#skills', def: P.SKILL_FORGE },
  { product: 'pal', group: 'Every day', title: 'What did I miss', icon: 'rocket',
    line: 'A short recap of what landed while you were away, most important first.', href: '/docs/pal/daily/#what-did-i-miss', def: P.RECAP },
  { product: 'pal', group: 'Knowledge', title: 'Knowledge and handoff', icon: 'open-book',
    line: 'Answers cite your documents; a chat can be handed to a person.', href: '/docs/pal/knowledge/', def: X.KNOWLEDGE_HANDOFF },

  // ---- PAL Runtime
  { product: 'rt', group: 'Reliable', title: 'Durable execution', icon: 'approve-check', featured: true,
    line: 'A crash mid-run resumes from the journal; finished steps are not re-run.', href: '/docs/runtime/durable-execution/', seq: CHECKPOINT_SEQUENCE },
  { product: 'rt', group: 'Safe', title: 'microVM isolation', icon: 'laptop', featured: true,
    line: 'Untrusted code runs in its own microVM; untrusted and hostile classes are never downgraded to runc.', href: '/docs/runtime/isolation/', def: X.ISOLATION_CLASSES },
  { product: 'rt', group: 'Safe', title: 'Egress broker', icon: 'external', featured: true,
    line: 'Network calls pass an allowlist; credentials are added outside the VM.', href: '/docs/security/egress/', seq: EGRESS_SEQUENCE },
  { product: 'rt', group: 'Build', title: 'Model routing', icon: 'random', featured: true,
    line: 'Ask for a capability, not a model; failover and idempotency keys built in.', href: '/docs/build/models/', def: R.MODEL_ROUTING },
  { product: 'rt', group: 'Reliable', title: 'Budgets and eval gates', icon: 'analytics', featured: true,
    line: 'Over a hard cap is HTTP 402 before any provider call; a regression is 422.', href: '/docs/build/budgets/', def: R.BUDGET_EVAL_GATE },
  { product: 'rt', group: 'Safe', title: 'Sandbox lifecycle', icon: 'window',
    line: 'Pause, resume, fork and idle-suspend a running microVM.', href: '/docs/runtime/sandbox-lifecycle/', seq: LIFECYCLE_SEQUENCE },
  { product: 'rt', group: 'Build', title: 'Tool calls in a VM', icon: 'setting',
    line: 'A workflow tool step executes inside the microVM via the runtime manager.', href: '/docs/runtime/invocation/', seq: TOOL_SEQUENCE },
  { product: 'rt', group: 'Build', title: 'Run lifecycle', icon: 'right-arrow',
    line: 'From POST /v1/runs to a streamed result, including crash re-drive.', href: '/docs/architecture/request-lifecycle/', seq: RUN_SEQUENCE },
  { product: 'rt', group: 'Build', title: 'Invocation modes', icon: 'window',
    line: 'The ways a run starts and where its code executes.', href: '/docs/runtime/invocation/', def: X.INVOCATION_MODES },
  { product: 'rt', group: 'Build', title: 'Connectors', icon: 'puzzle',
    line: '18 real connector APIs with credentials encrypted at rest.', href: '/docs/build/connectors/', def: X.CONNECTOR_ACTIONS },
  { product: 'rt', group: 'Build', title: 'Webhook triggers', icon: 'rocket',
    line: 'A signed public URL per agent; duplicate deliveries are dropped.', href: '/docs/build/triggers/', def: X.WEBHOOK_TRIGGERS },
  { product: 'rt', group: 'Build', title: 'Cron schedules', icon: 'clock',
    line: 'Timezone-aware schedules that fire runs.', href: '/docs/build/scheduling/', def: X.CRON_SCHEDULES },
  { product: 'rt', group: 'Build', title: 'Sessions and memory', icon: 'comment-alt',
    line: 'Multi-turn sessions with events over SSE and a shared memory API.', href: '/docs/runtime/sessions-and-memory/', def: X.SESSIONS_MEMORY },
  { product: 'rt', group: 'Build', title: 'Token streaming', icon: 'right-arrow',
    line: 'Tokens flow from provider to browser with no buffering in between.', href: '/docs/runtime/streaming/', def: X.TOKEN_STREAMING },
  { product: 'rt', group: 'Build', title: 'Agents talking to agents', icon: 'random',
    line: 'Attach MCP tools, discover agents over A2A, invoke marketplace agents.', href: '/docs/build/marketplace/', def: R.AGENT_NETWORK },
  { product: 'rt', group: 'Safe', title: 'Tenant isolation', icon: 'padlock',
    line: 'Row-level security on every tenant table and a token-gated gRPC boundary.', href: '/docs/security/', def: R.TENANCY_RLS },
  { product: 'rt', group: 'Safe', title: 'Identity and secrets', icon: 'approve-check',
    line: 'Secrets are references until the harness vends them to an authenticated peer.', href: '/docs/security/identity/', def: X.IDENTITY_SECRETS },
  { product: 'rt', group: 'Safe', title: 'Signed receipts', icon: 'approve-check-circle',
    line: 'An Ed25519 signature over the run’s journal hash; tampering breaks it.', href: '/docs/security/receipts/', def: X.SIGNED_RECEIPTS },
  { product: 'rt', group: 'Operate', title: 'Tracing', icon: 'magnifier',
    line: 'Every span carries tenant, run and step ids, into the VM and back.', href: '/docs/observability/', def: X.TRACE_PROPAGATION },
  { product: 'rt', group: 'Operate', title: 'Deploy anywhere', icon: 'setting',
    line: 'Control plane managed or self-hosted; the data plane in your VPC.', href: '/docs/operate/deployment/', def: R.DEPLOY_TOPOLOGY },
  { product: 'rt', group: 'Build', title: 'Agentic onboarding', icon: 'star',
    line: 'Describe a goal; get a reviewed spec, a tested key and a first streamed run.', href: '/docs/start/quickstart/', def: X.ONBOARDING_FLOW },
];
