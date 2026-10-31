// Stable, importable diagram components. Embed in MDX/Astro with a client directive:
//   import { HoldsGates } from '../../components/diagrams';
//   <HoldsGates client:visible />
// The name -> capability map lives in README.md next to this file.
import { FlowDiagram } from "./FlowDiagram";
import { Sequence } from "./Sequence";
import * as R from "./flows-runtime";
import * as P from "./flows-pal";
import * as X from "./flows-more";

export { ArchitectureExplorer } from "./ArchitectureExplorer";
export { LifecycleMachine as VmLifecycle } from "./LifecycleMachine";
export { BrokerDemo } from "./BrokerDemo";
export { FlowDiagram } from "./FlowDiagram";
export { Sequence } from "./Sequence";

// Runtime
export const SystemContext = () => <FlowDiagram def={R.SYSTEM_CONTEXT} />;
export const ContainerView = () => <FlowDiagram def={R.CONTAINER_VIEW} />;
export const TrustBoundaries = () => <FlowDiagram def={R.TRUST_BOUNDARIES} />;
export const ModelRouting = () => <FlowDiagram def={R.MODEL_ROUTING} />;
export const BudgetEvalGate = () => <FlowDiagram def={R.BUDGET_EVAL_GATE} />;
export const DeployTopology = () => <FlowDiagram def={R.DEPLOY_TOPOLOGY} />;
export const AgentNetwork = () => <FlowDiagram def={R.AGENT_NETWORK} />;
export const TenancyRls = () => <FlowDiagram def={R.TENANCY_RLS} />;
export const RunSequence = () => <Sequence name="run" />;
export const MicroVmRunSequence = () => <Sequence name="microvm-run" />;
export const ToolCallSequence = () => <Sequence name="tool" />;
export const EgressSequence = () => <Sequence name="egress" />;
export const SandboxLifecycleSequence = () => <Sequence name="lifecycle" />;
export const CheckpointSequence = () => <Sequence name="checkpoint" />;

// pal
export const BriefAttention = () => <FlowDiagram def={P.BRIEF_ATTENTION} />;
export const HoldsGates = () => <FlowDiagram def={P.HOLDS_GATES} />;
export const TwoProducts = () => <FlowDiagram def={P.TWO_PRODUCTS} compact />;
export const VoicePipeline = () => <FlowDiagram def={P.VOICE_PIPELINE} />;
export const CrossChannelMemory = () => <FlowDiagram def={P.CROSS_CHANNEL_MEMORY} />;
export const WorldModel = () => <FlowDiagram def={P.WORLD_MODEL} />;
export const ProactiveNudges = () => <FlowDiagram def={P.PROACTIVE_NUDGES} />;
export const SkillForge = () => <FlowDiagram def={P.SKILL_FORGE} />;
export const Recap = () => <FlowDiagram def={P.RECAP} />;

// More runtime capabilities
export const WebhookTriggers = () => <FlowDiagram def={X.WEBHOOK_TRIGGERS} />;
export const CronSchedules = () => <FlowDiagram def={X.CRON_SCHEDULES} />;
export const ConnectorActions = () => <FlowDiagram def={X.CONNECTOR_ACTIONS} />;
export const TracePropagation = () => <FlowDiagram def={X.TRACE_PROPAGATION} />;
export const SignedReceipts = () => <FlowDiagram def={X.SIGNED_RECEIPTS} />;
export const TokenStreaming = () => <FlowDiagram def={X.TOKEN_STREAMING} />;
export const SessionsMemory = () => <FlowDiagram def={X.SESSIONS_MEMORY} />;
export const KnowledgeHandoff = () => <FlowDiagram def={X.KNOWLEDGE_HANDOFF} />;
export const IdentitySecrets = () => <FlowDiagram def={X.IDENTITY_SECRETS} />;
export const IsolationClasses = () => <FlowDiagram def={X.ISOLATION_CLASSES} />;
export const InvocationModes = () => <FlowDiagram def={X.INVOCATION_MODES} />;
export const OnboardingFlow = () => <FlowDiagram def={X.ONBOARDING_FLOW} />;
