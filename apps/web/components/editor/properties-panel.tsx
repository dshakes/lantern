"use client";

import { useCallback, useState } from "react";
import { useReactFlow, type Node } from "@xyflow/react";
import {
  Zap,
  Brain,
  Wrench,
  GitBranch,
  Repeat,
  ShieldCheck,
  Plug,
  Bot,
  CircleStop,
  Trash2,
  X,
  HelpCircle,
  Play,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import clsx from "clsx";
import type {
  NodeType,
  TriggerData,
  AiStepData,
  ToolData,
  ConditionData,
  LoopData,
  ApprovalData,
  ConnectorData,
  SubagentData,
  EndData,
} from "@/lib/workflow-types";

// ---- Icon lookup -----------------------------------------------------------

const iconComponents: Record<NodeType, LucideIcon> = {
  trigger: Zap,
  "ai-step": Brain,
  tool: Wrench,
  condition: GitBranch,
  loop: Repeat,
  approval: ShieldCheck,
  connector: Plug,
  subagent: Bot,
  end: CircleStop,
};

const typeLabels: Record<NodeType, string> = {
  trigger: "Trigger",
  "ai-step": "AI Step",
  tool: "Tool",
  condition: "Condition",
  loop: "Loop",
  approval: "Approval",
  connector: "Connector",
  subagent: "Sub-agent",
  end: "End",
};

const typeColors: Record<NodeType, string> = {
  trigger: "text-emerald-400",
  "ai-step": "text-indigo-400",
  tool: "text-blue-400",
  condition: "text-yellow-400",
  loop: "text-purple-400",
  approval: "text-red-400",
  connector: "text-teal-400",
  subagent: "text-orange-400",
  end: "text-zinc-400",
};

// ---- Shared field components -----------------------------------------------

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-zinc-500">
      {children}
    </label>
  );
}

function FieldHelp({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-1 flex items-start gap-1 text-[10px] leading-relaxed text-zinc-600">
      <HelpCircle className="mt-0.5 h-3 w-3 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function FieldError({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-1 text-[10px] text-red-400">{children}</p>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  required,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
}) {
  const showError = required && value.trim() === "";
  return (
    <>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={clsx(
          "w-full rounded-md border bg-surface-2 px-3 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1",
          showError
            ? "border-red-500/50 focus:border-red-500 focus:ring-red-500/30"
            : "border-zinc-700 focus:border-lantern-500 focus:ring-lantern-500/30"
        )}
      />
      {showError && <FieldError>This field is required</FieldError>}
    </>
  );
}

function TextArea({
  value,
  onChange,
  placeholder,
  rows = 4,
  required,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  required?: boolean;
}) {
  const showError = required && value.trim() === "";
  return (
    <>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className={clsx(
          "w-full rounded-md border bg-surface-2 px-3 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1",
          showError
            ? "border-red-500/50 focus:border-red-500 focus:ring-red-500/30"
            : "border-zinc-700 focus:border-lantern-500 focus:ring-lantern-500/30"
        )}
      />
      {showError && <FieldError>This field is required</FieldError>}
    </>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border border-zinc-700 bg-surface-2 px-3 py-1.5 text-sm text-zinc-200 focus:border-lantern-500 focus:outline-none focus:ring-1 focus:ring-lantern-500/30"
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

function Slider({
  value,
  onChange,
  min,
  max,
  step,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-zinc-700 accent-lantern-500"
      />
      <span className="min-w-[3rem] text-right text-xs font-mono text-zinc-400">
        {value}
      </span>
    </div>
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  const showError =
    (min !== undefined && value < min) || (max !== undefined && value > max);
  return (
    <>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value) || 0)}
        min={min}
        max={max}
        className={clsx(
          "w-full rounded-md border bg-surface-2 px-3 py-1.5 text-sm text-zinc-200 focus:outline-none focus:ring-1",
          showError
            ? "border-red-500/50 focus:border-red-500 focus:ring-red-500/30"
            : "border-zinc-700 focus:border-lantern-500 focus:ring-lantern-500/30"
        )}
      />
      {showError && (
        <FieldError>
          Must be between {min ?? "-inf"} and {max ?? "inf"}
        </FieldError>
      )}
    </>
  );
}

// ---- Per-type config forms -------------------------------------------------

function TriggerConfig({
  data,
  onChange,
}: {
  data: TriggerData;
  onChange: (d: Partial<TriggerData>) => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <FieldLabel>Trigger Kind</FieldLabel>
        <Select
          value={data.triggerKind}
          onChange={(v) =>
            onChange({
              triggerKind: v as TriggerData["triggerKind"],
            })
          }
          options={[
            { value: "manual", label: "Manual" },
            { value: "schedule", label: "Schedule" },
            { value: "webhook", label: "Webhook" },
            { value: "chat", label: "Chat Surface" },
          ]}
        />
        <FieldHelp>How this workflow is started.</FieldHelp>
      </div>
      {data.triggerKind === "schedule" && (
        <div>
          <FieldLabel>Cron Expression</FieldLabel>
          <TextInput
            value={data.cron ?? ""}
            onChange={(v) => onChange({ cron: v })}
            placeholder="0 9 * * MON"
            required
          />
          <FieldHelp>Standard 5-field cron expression (minute hour day month weekday).</FieldHelp>
        </div>
      )}
      {data.triggerKind === "webhook" && (
        <div>
          <FieldLabel>Webhook URL</FieldLabel>
          <TextInput
            value={data.webhookUrl ?? ""}
            onChange={(v) => onChange({ webhookUrl: v })}
            placeholder="https://..."
          />
          <FieldHelp>Auto-generated on deploy if left blank.</FieldHelp>
        </div>
      )}
      {data.triggerKind === "chat" && (
        <div>
          <FieldLabel>Surface</FieldLabel>
          <Select
            value={data.surface ?? ""}
            onChange={(v) => onChange({ surface: v })}
            options={[
              { value: "", label: "Select surface..." },
              { value: "slack", label: "Slack" },
              { value: "discord", label: "Discord" },
              { value: "telegram", label: "Telegram" },
              { value: "whatsapp", label: "WhatsApp" },
              { value: "web", label: "Web Chat" },
            ]}
          />
          <FieldHelp>The chat platform this agent listens on.</FieldHelp>
        </div>
      )}
    </div>
  );
}

function AiStepConfig({
  data,
  onChange,
}: {
  data: AiStepData;
  onChange: (d: Partial<AiStepData>) => void;
}) {
  const [testState, setTestState] = useState<"idle" | "loading" | "done">(
    "idle"
  );
  const [testOutput, setTestOutput] = useState("");

  const handleTestPrompt = useCallback(() => {
    if (!data.prompt.trim()) return;
    setTestState("loading");
    // Simulate an LLM response — in production this calls the model router
    setTimeout(() => {
      const simulatedResponse = `[Simulated ${data.capability} response]\n\nBased on the prompt:\n"${data.prompt.slice(0, 80)}..."\n\nSample output: {"result": "example value", "confidence": 0.92}`;
      setTestOutput(simulatedResponse);
      setTestState("done");
    }, 1200);
  }, [data.prompt, data.capability]);

  return (
    <div className="space-y-3">
      <div>
        <FieldLabel>Prompt</FieldLabel>
        <TextArea
          value={data.prompt}
          onChange={(v) => onChange({ prompt: v })}
          placeholder="Enter your prompt template..."
          rows={6}
          required
        />
        <FieldHelp>
          Use {"{{variable}}"} syntax to reference trigger input or previous step outputs.
        </FieldHelp>
      </div>

      {/* Test prompt */}
      <div>
        <button
          onClick={handleTestPrompt}
          disabled={testState === "loading" || !data.prompt.trim()}
          className="inline-flex items-center gap-1.5 rounded-md border border-indigo-500/30 px-2.5 py-1.5 text-[11px] font-medium text-indigo-400 transition-colors hover:bg-indigo-500/10 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {testState === "loading" ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              Testing...
            </>
          ) : (
            <>
              <Play className="h-3 w-3" />
              Test Prompt
            </>
          )}
        </button>
        {testState === "done" && testOutput && (
          <pre className="mt-2 max-h-32 overflow-auto rounded border border-zinc-700/50 bg-surface-0 p-2 text-[10px] leading-relaxed text-zinc-400">
            {testOutput}
          </pre>
        )}
      </div>

      <div>
        <FieldLabel>Capability</FieldLabel>
        <Select
          value={data.capability}
          onChange={(v) =>
            onChange({ capability: v as AiStepData["capability"] })
          }
          options={[
            { value: "auto", label: "Auto" },
            { value: "reasoning-large", label: "Reasoning Large" },
            { value: "reasoning-small", label: "Reasoning Small" },
            { value: "fast", label: "Fast" },
            { value: "code", label: "Code" },
          ]}
        />
        <FieldHelp>The model router maps this to a concrete model. Never hardcode a model name.</FieldHelp>
      </div>
      <div>
        <FieldLabel>Temperature</FieldLabel>
        <Slider
          value={data.temperature}
          onChange={(v) => onChange({ temperature: v })}
          min={0}
          max={2}
          step={0.1}
        />
        <FieldHelp>Lower = more deterministic. Higher = more creative.</FieldHelp>
      </div>
      <div>
        <FieldLabel>Max Tokens</FieldLabel>
        <NumberInput
          value={data.maxTokens}
          onChange={(v) => onChange({ maxTokens: v })}
          min={1}
          max={128000}
        />
        <FieldHelp>Maximum number of tokens in the response.</FieldHelp>
      </div>
    </div>
  );
}

function ToolConfig({
  data,
  onChange,
}: {
  data: ToolData;
  onChange: (d: Partial<ToolData>) => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <FieldLabel>Tool</FieldLabel>
        <Select
          value={data.tool}
          onChange={(v) => onChange({ tool: v as ToolData["tool"] })}
          options={[
            { value: "", label: "Select tool..." },
            { value: "web.search", label: "Web Search" },
            { value: "python.exec", label: "Python Execute" },
            { value: "fs.read", label: "File Read" },
            { value: "fs.write", label: "File Write" },
          ]}
        />
        <FieldHelp>Built-in tools run inside the microVM sandbox.</FieldHelp>
      </div>
      <div>
        <FieldLabel>Parameters (JSON)</FieldLabel>
        <TextArea
          value={data.parameters}
          onChange={(v) => onChange({ parameters: v })}
          placeholder='{"key": "value"}'
          rows={4}
        />
        <FieldHelp>JSON object passed as input to the tool.</FieldHelp>
      </div>
    </div>
  );
}

function ConditionConfig({
  data,
  onChange,
}: {
  data: ConditionData;
  onChange: (d: Partial<ConditionData>) => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <FieldLabel>Expression</FieldLabel>
        <TextArea
          value={data.expression}
          onChange={(v) => onChange({ expression: v })}
          placeholder='steps.classify.output.category === "urgent"'
          rows={3}
          required
        />
        <FieldHelp>
          JavaScript expression that evaluates to true or false. Reference previous steps via steps.stepId.output.
        </FieldHelp>
      </div>
      <div className="flex gap-2">
        <div className="flex items-center gap-1.5 rounded bg-emerald-500/10 px-2 py-1">
          <div className="h-2 w-2 rounded-full bg-emerald-400" />
          <span className="text-[10px] text-emerald-400">True</span>
        </div>
        <div className="flex items-center gap-1.5 rounded bg-red-500/10 px-2 py-1">
          <div className="h-2 w-2 rounded-full bg-red-400" />
          <span className="text-[10px] text-red-400">False</span>
        </div>
      </div>
    </div>
  );
}

function LoopConfig({
  data,
  onChange,
}: {
  data: LoopData;
  onChange: (d: Partial<LoopData>) => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <FieldLabel>Array Expression</FieldLabel>
        <TextInput
          value={data.arrayExpression}
          onChange={(v) => onChange({ arrayExpression: v })}
          placeholder="steps.search.output.results"
          required
        />
        <FieldHelp>Path to an array in a previous step's output. Each element is processed individually.</FieldHelp>
      </div>
      <div>
        <FieldLabel>Concurrency</FieldLabel>
        <Slider
          value={data.concurrency}
          onChange={(v) => onChange({ concurrency: Math.round(v) })}
          min={1}
          max={10}
          step={1}
        />
        <FieldHelp>Number of items processed in parallel.</FieldHelp>
      </div>
    </div>
  );
}

function ApprovalConfig({
  data,
  onChange,
}: {
  data: ApprovalData;
  onChange: (d: Partial<ApprovalData>) => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <FieldLabel>Approvers (comma-separated)</FieldLabel>
        <TextInput
          value={data.approvers}
          onChange={(v) => onChange({ approvers: v })}
          placeholder="user:owner, role:manager"
          required
        />
        <FieldHelp>Users or roles who can approve. Format: user:id or role:name.</FieldHelp>
      </div>
      <div>
        <FieldLabel>Timeout (minutes)</FieldLabel>
        <NumberInput
          value={data.timeoutMinutes}
          onChange={(v) => onChange({ timeoutMinutes: v })}
          min={1}
          max={10080}
        />
        <FieldHelp>The run pauses until approved or timed out. Max 7 days (10080 minutes).</FieldHelp>
      </div>
      <div>
        <FieldLabel>Reason Template</FieldLabel>
        <TextArea
          value={data.reason}
          onChange={(v) => onChange({ reason: v })}
          placeholder="Approval needed for..."
          rows={2}
        />
        <FieldHelp>Shown to the approver. Can use template variables.</FieldHelp>
      </div>
    </div>
  );
}

// ---- Connector action-specific fields --------------------------------------

const connectorActionFields: Record<
  string,
  Record<string, { label: string; placeholder: string; type: "text" | "textarea" }[]>
> = {
  gmail: {
    send_email: [
      { label: "To", placeholder: "recipient@example.com", type: "text" },
      { label: "Subject", placeholder: "Email subject", type: "text" },
      { label: "Body", placeholder: "Email body text...", type: "textarea" },
    ],
    read_email: [
      { label: "Message ID", placeholder: "msg-id", type: "text" },
    ],
    search: [
      { label: "Query", placeholder: 'from:user@example.com subject:"report"', type: "text" },
      { label: "Max Results", placeholder: "10", type: "text" },
    ],
  },
  slack: {
    post_message: [
      { label: "Channel", placeholder: "#general", type: "text" },
      { label: "Message", placeholder: "Hello from Lantern!", type: "textarea" },
    ],
    react: [
      { label: "Channel", placeholder: "#general", type: "text" },
      { label: "Timestamp", placeholder: "1234567890.123456", type: "text" },
      { label: "Emoji", placeholder: "thumbsup", type: "text" },
    ],
  },
  github: {
    create_issue: [
      { label: "Repository", placeholder: "owner/repo", type: "text" },
      { label: "Title", placeholder: "Issue title", type: "text" },
      { label: "Body", placeholder: "Issue description...", type: "textarea" },
    ],
    create_pr: [
      { label: "Repository", placeholder: "owner/repo", type: "text" },
      { label: "Branch", placeholder: "feature/my-branch", type: "text" },
      { label: "Title", placeholder: "PR title", type: "text" },
    ],
    add_comment: [
      { label: "Repository", placeholder: "owner/repo", type: "text" },
      { label: "Issue Number", placeholder: "123", type: "text" },
      { label: "Comment", placeholder: "Comment body...", type: "textarea" },
    ],
  },
  linear: {
    create_issue: [
      { label: "Team", placeholder: "ENG", type: "text" },
      { label: "Title", placeholder: "Issue title", type: "text" },
      { label: "Description", placeholder: "Issue description...", type: "textarea" },
    ],
    update_issue: [
      { label: "Issue ID", placeholder: "ENG-123", type: "text" },
      { label: "Status", placeholder: "In Progress", type: "text" },
    ],
  },
  notion: {
    create_page: [
      { label: "Parent Page ID", placeholder: "page-id", type: "text" },
      { label: "Title", placeholder: "Page title", type: "text" },
      { label: "Content", placeholder: "Page content...", type: "textarea" },
    ],
    query_database: [
      { label: "Database ID", placeholder: "db-id", type: "text" },
      { label: "Filter (JSON)", placeholder: '{"property": "Status", "equals": "Done"}', type: "textarea" },
    ],
  },
  stripe: {
    create_invoice: [
      { label: "Customer ID", placeholder: "cus_...", type: "text" },
      { label: "Amount (cents)", placeholder: "5000", type: "text" },
      { label: "Description", placeholder: "Invoice description", type: "text" },
    ],
    get_customer: [
      { label: "Customer ID", placeholder: "cus_...", type: "text" },
    ],
  },
};

function ConnectorConfig({
  data,
  onChange,
}: {
  data: ConnectorData;
  onChange: (d: Partial<ConnectorData>) => void;
}) {
  const connectorActions: Record<string, { value: string; label: string }[]> = {
    gmail: [
      { value: "send_email", label: "Send Email" },
      { value: "read_email", label: "Read Email" },
      { value: "search", label: "Search" },
    ],
    slack: [
      { value: "post_message", label: "Post Message" },
      { value: "react", label: "Add Reaction" },
    ],
    github: [
      { value: "create_issue", label: "Create Issue" },
      { value: "create_pr", label: "Create PR" },
      { value: "add_comment", label: "Add Comment" },
    ],
    linear: [
      { value: "create_issue", label: "Create Issue" },
      { value: "update_issue", label: "Update Issue" },
    ],
    notion: [
      { value: "create_page", label: "Create Page" },
      { value: "query_database", label: "Query Database" },
    ],
    stripe: [
      { value: "create_invoice", label: "Create Invoice" },
      { value: "get_customer", label: "Get Customer" },
    ],
  };

  const actions = data.connector ? connectorActions[data.connector] ?? [] : [];

  // Get action-specific fields
  const actionFields =
    data.connector && data.action
      ? connectorActionFields[data.connector]?.[data.action] ?? []
      : [];

  // Parse current inputMapping as JSON to pre-fill action-specific fields
  let inputMappingObj: Record<string, string> = {};
  try {
    const parsed = JSON.parse(data.inputMapping || "{}");
    if (typeof parsed === "object" && parsed !== null) {
      inputMappingObj = parsed;
    }
  } catch {
    // ignore parse errors
  }

  const updateInputField = (key: string, value: string) => {
    const updated = { ...inputMappingObj, [key]: value };
    onChange({ inputMapping: JSON.stringify(updated, null, 2) });
  };

  return (
    <div className="space-y-3">
      <div>
        <FieldLabel>Connector</FieldLabel>
        <Select
          value={data.connector}
          onChange={(v) =>
            onChange({
              connector: v as ConnectorData["connector"],
              action: "",
              inputMapping: "{}",
            })
          }
          options={[
            { value: "", label: "Select connector..." },
            { value: "gmail", label: "Gmail" },
            { value: "slack", label: "Slack" },
            { value: "github", label: "GitHub" },
            { value: "linear", label: "Linear" },
            { value: "notion", label: "Notion" },
            { value: "stripe", label: "Stripe" },
          ]}
        />
        <FieldHelp>External service to connect to.</FieldHelp>
      </div>
      {data.connector && (
        <div>
          <FieldLabel>Action</FieldLabel>
          <Select
            value={data.action}
            onChange={(v) => onChange({ action: v, inputMapping: "{}" })}
            options={[
              { value: "", label: "Select action..." },
              ...actions,
            ]}
          />
        </div>
      )}

      {/* Dynamic action-specific input fields */}
      {actionFields.length > 0 && (
        <div className="space-y-2 rounded-lg border border-zinc-700/50 bg-surface-0/50 p-3">
          <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-600">
            Action Parameters
          </span>
          {actionFields.map((field) => {
            const fieldKey = field.label
              .toLowerCase()
              .replace(/[^a-z0-9]/g, "_");
            return (
              <div key={fieldKey}>
                <FieldLabel>{field.label}</FieldLabel>
                {field.type === "textarea" ? (
                  <TextArea
                    value={inputMappingObj[fieldKey] ?? ""}
                    onChange={(v) => updateInputField(fieldKey, v)}
                    placeholder={field.placeholder}
                    rows={2}
                  />
                ) : (
                  <TextInput
                    value={inputMappingObj[fieldKey] ?? ""}
                    onChange={(v) => updateInputField(fieldKey, v)}
                    placeholder={field.placeholder}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Raw JSON fallback when no action-specific fields */}
      {actionFields.length === 0 && (
        <div>
          <FieldLabel>Input Mapping (JSON)</FieldLabel>
          <TextArea
            value={data.inputMapping}
            onChange={(v) => onChange({ inputMapping: v })}
            placeholder='{"channel": "#general"}'
            rows={3}
          />
          <FieldHelp>JSON mapping of action input parameters.</FieldHelp>
        </div>
      )}
    </div>
  );
}

function SubagentConfig({
  data,
  onChange,
}: {
  data: SubagentData;
  onChange: (d: Partial<SubagentData>) => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <FieldLabel>Agent Name</FieldLabel>
        <Select
          value={data.agentName}
          onChange={(v) => onChange({ agentName: v })}
          options={[
            { value: "", label: "Select agent..." },
            { value: "research-agent", label: "research-agent" },
            { value: "code-reviewer", label: "code-reviewer" },
            { value: "data-pipeline", label: "data-pipeline" },
            { value: "customer-support", label: "customer-support" },
          ]}
        />
        <FieldHelp>The child agent to invoke. Its output becomes this step's result.</FieldHelp>
      </div>
      <div>
        <FieldLabel>Input Mapping (JSON)</FieldLabel>
        <TextArea
          value={data.inputMapping}
          onChange={(v) => onChange({ inputMapping: v })}
          placeholder='{"query": "{{trigger.input}}"}'
          rows={3}
        />
        <FieldHelp>JSON object passed as input to the child agent.</FieldHelp>
      </div>
    </div>
  );
}

function EndConfig({
  data,
  onChange,
}: {
  data: EndData;
  onChange: (d: Partial<EndData>) => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <FieldLabel>Output Expression</FieldLabel>
        <TextInput
          value={data.outputExpression}
          onChange={(v) => onChange({ outputExpression: v })}
          placeholder="steps.synthesize.output"
        />
        <FieldHelp>Expression that produces the final output of the workflow.</FieldHelp>
      </div>
    </div>
  );
}

// ---- Main properties panel -------------------------------------------------

interface PropertiesPanelProps {
  selectedNode: Node | null;
  onClose: () => void;
  onNodeDataChange?: () => void;
}

export function PropertiesPanel({
  selectedNode,
  onClose,
  onNodeDataChange,
}: PropertiesPanelProps) {
  const { setNodes, deleteElements } = useReactFlow();

  const updateNodeData = useCallback(
    (updates: Record<string, unknown>) => {
      if (!selectedNode) return;
      setNodes((nodes) =>
        nodes.map((n) => {
          if (n.id !== selectedNode.id) return n;
          return {
            ...n,
            data: { ...n.data, ...updates },
          };
        })
      );
      onNodeDataChange?.();
    },
    [selectedNode, setNodes, onNodeDataChange]
  );

  const handleDelete = useCallback(() => {
    if (!selectedNode) return;
    deleteElements({ nodes: [{ id: selectedNode.id }] });
    onClose();
  }, [selectedNode, deleteElements, onClose]);

  if (!selectedNode) {
    return (
      <aside className="flex w-72 flex-col border-l border-zinc-800 bg-surface-1">
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="text-center text-xs text-zinc-600">
            Select a node to view its properties
          </p>
        </div>
      </aside>
    );
  }

  const nodeType = selectedNode.type as NodeType;
  const Icon = iconComponents[nodeType];
  const data = selectedNode.data as Record<string, unknown>;

  return (
    <aside className="flex w-72 flex-col border-l border-zinc-800 bg-surface-1">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <Icon className={clsx("h-4 w-4", typeColors[nodeType])} />
          <span className="text-xs font-semibold text-zinc-200">
            {typeLabels[nodeType]}
          </span>
        </div>
        <button
          onClick={onClose}
          className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-surface-3 hover:text-zinc-300"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Label field (shared across all types) */}
      <div className="border-b border-zinc-800 px-4 py-3">
        <FieldLabel>Label</FieldLabel>
        <TextInput
          value={(data.label as string) ?? ""}
          onChange={(v) => updateNodeData({ label: v })}
          placeholder="Node label"
          required
        />
      </div>

      {/* Type-specific config */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {nodeType === "trigger" && (
          <TriggerConfig
            data={data as unknown as TriggerData}
            onChange={updateNodeData}
          />
        )}
        {nodeType === "ai-step" && (
          <AiStepConfig
            data={data as unknown as AiStepData}
            onChange={updateNodeData}
          />
        )}
        {nodeType === "tool" && (
          <ToolConfig
            data={data as unknown as ToolData}
            onChange={updateNodeData}
          />
        )}
        {nodeType === "condition" && (
          <ConditionConfig
            data={data as unknown as ConditionData}
            onChange={updateNodeData}
          />
        )}
        {nodeType === "loop" && (
          <LoopConfig
            data={data as unknown as LoopData}
            onChange={updateNodeData}
          />
        )}
        {nodeType === "approval" && (
          <ApprovalConfig
            data={data as unknown as ApprovalData}
            onChange={updateNodeData}
          />
        )}
        {nodeType === "connector" && (
          <ConnectorConfig
            data={data as unknown as ConnectorData}
            onChange={updateNodeData}
          />
        )}
        {nodeType === "subagent" && (
          <SubagentConfig
            data={data as unknown as SubagentData}
            onChange={updateNodeData}
          />
        )}
        {nodeType === "end" && (
          <EndConfig
            data={data as unknown as EndData}
            onChange={updateNodeData}
          />
        )}
      </div>

      {/* Delete button */}
      <div className="border-t border-zinc-800 px-4 py-3">
        <button
          onClick={handleDelete}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-red-500/30 px-3 py-2 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/10"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete Node
        </button>
      </div>
    </aside>
  );
}
