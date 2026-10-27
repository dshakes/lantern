"use client";

// Webhook triggers for one agent (ADR 0028). Each trigger is a public
// POST /v1/hooks/{id} that GitHub / Sentry / PagerDuty (or any HMAC-signing
// sender) delivers to; a verified delivery starts a run of this agent.

import { use, useCallback, useEffect, useRef, useState } from "react";
import { Copy, Plus, Trash2, Webhook } from "lucide-react";
import { api, type Trigger, type TriggerProvider } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { Modal, ModalField } from "@/components/modal";
import { Button, LinkButton } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { HeaderSkeleton, Skeleton } from "@/components/skeleton";
import { useToast } from "@/components/toast";

const PROVIDERS: { value: TriggerProvider; label: string; hint: string }[] = [
  { value: "github", label: "GitHub", hint: "Paste the URL and secret into Settings → Webhooks (content type: application/json)." },
  { value: "sentry", label: "Sentry", hint: "Sentry generates its own client secret — paste it below." },
  { value: "pagerduty", label: "PagerDuty", hint: "PagerDuty shows a signing secret after you create the subscription — create the trigger first, then use Replace secret." },
  { value: "generic", label: "Generic HMAC", hint: "Sign t.<body> with HMAC-SHA256; send X-Lantern-Signature: t=<unix>,v1=<hex>." },
];

const inputCls =
  "w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500/50";

export default function AgentTriggersPage({ params }: { params: Promise<{ name: string }> }) {
  const { name: rawName } = use(params);
  const name = decodeURIComponent(rawName);
  const toast = useToast();
  // The toast context value is rebuilt on every provider render; keep it out of
  // load's deps or a failing load re-triggers itself through its own toast.
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const [triggers, setTriggers] = useState<Trigger[] | null>(null);
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<TriggerProvider>("github");
  const [secret, setSecret] = useState("");
  const [template, setTemplate] = useState("");
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<Trigger | null>(null);

  const load = useCallback(async () => {
    try {
      setTriggers(await api.listTriggers(name));
    } catch (err) {
      toastRef.current.error(`Could not load triggers: ${err instanceof Error ? err.message : String(err)}`);
      setTriggers([]);
    }
  }, [name]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    let inputTemplate: Record<string, unknown> | undefined;
    if (template.trim()) {
      try {
        inputTemplate = JSON.parse(template);
      } catch {
        toast.error("Input template must be valid JSON");
        return;
      }
    }
    setSaving(true);
    try {
      const t = await api.createTrigger(name, { provider, secret: secret || undefined, inputTemplate });
      setOpen(false);
      setSecret("");
      setTemplate("");
      setCreated(t);
      await load();
    } catch (err) {
      toast.error(`Create failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  async function toggle(t: Trigger) {
    try {
      await api.updateTrigger(t.id, { enabled: !t.enabled });
      await load();
    } catch (err) {
      toast.error(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function replaceSecret(t: Trigger) {
    const next = window.prompt("New signing secret (at least 16 characters):");
    if (!next) return;
    try {
      await api.updateTrigger(t.id, { secret: next });
      toast.success("Secret replaced");
    } catch (err) {
      toast.error(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function remove(t: Trigger) {
    if (!window.confirm("Delete this trigger? Deliveries to its URL will return 404.")) return;
    try {
      await api.deleteTrigger(t.id);
      await load();
    } catch (err) {
      toast.error(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function copy(text: string) {
    void navigator.clipboard.writeText(text).then(() => toast.success("Copied"));
  }

  if (triggers === null) {
    return (
      <div className="flex-1 overflow-y-auto">
        <HeaderSkeleton />
        <div className="space-y-3 p-6 md:p-8">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      </div>
    );
  }

  const providerHint = PROVIDERS.find((p) => p.value === provider)?.hint;

  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader
        title="Webhook triggers"
        description={`Start a run of ${name} when GitHub, Sentry, PagerDuty or any HMAC-signing service sends an event. Runs count against this agent's budget.`}
        action={
          <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setOpen(true)}>
            New trigger
          </Button>
        }
        secondaryAction={
          <LinkButton href={`/agents/${encodeURIComponent(name)}`} variant="ghost">
            Back to agent
          </LinkButton>
        }
      />

      <div className="mx-auto max-w-3xl space-y-3 p-6 md:p-8">
        {triggers.length === 0 ? (
          <EmptyState
            icon={Webhook}
            title="No webhook triggers yet"
            description="Create one, then paste its URL and secret into the sending service."
            actionLabel="New trigger"
            onAction={() => setOpen(true)}
            size="compact"
          />
        ) : (
          triggers.map((t) => {
            const url = api.hookUrl(t.hookPath);
            return (
              <div key={t.id} className="mc-glass space-y-2 rounded-xl p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-100">
                      {PROVIDERS.find((p) => p.value === t.provider)?.label ?? t.provider}
                    </span>
                    <span
                      className={
                        t.enabled
                          ? "rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-400"
                          : "rounded-full bg-zinc-500/10 px-2 py-0.5 text-[10px] text-zinc-400"
                      }
                    >
                      {t.enabled ? "enabled" : "disabled"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant="ghost" onClick={() => toggle(t)}>
                      {t.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => replaceSecret(t)}>
                      Replace secret
                    </Button>
                    <Button size="sm" variant="danger" icon={<Trash2 className="h-3 w-3" />} onClick={() => remove(t)} aria-label="Delete trigger">
                      Delete
                    </Button>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded bg-surface-0 px-2 py-1 text-[11px] text-zinc-300">{url}</code>
                  <Button size="sm" variant="ghost" icon={<Copy className="h-3 w-3" />} onClick={() => copy(url)} aria-label="Copy URL">
                    Copy
                  </Button>
                </div>
                <p className="text-[11px] text-zinc-500">
                  {t.lastDeliveryAt ? `Last delivery ${new Date(t.lastDeliveryAt).toLocaleString()}` : "No deliveries yet"}
                  {t.inputTemplate ? " · custom input template" : ""}
                </p>
              </div>
            );
          })
        )}
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New webhook trigger"
        description="Deliveries must be signed with the trigger's secret; unsigned or replayed requests are rejected."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={saving} onClick={create}>
              Create
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <ModalField label="Provider" hint={providerHint}>
            <select value={provider} onChange={(e) => setProvider(e.target.value as TriggerProvider)} className={inputCls}>
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </ModalField>
          <ModalField label="Signing secret (optional)" hint="Leave empty to generate one. At least 16 characters.">
            <input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} className={inputCls} />
          </ModalField>
          <ModalField label="Input template (optional JSON)" hint='e.g. {"pr": "{{payload.number}}", "title": "{{payload.pull_request.title}}"} — default passes the whole payload.'>
            <textarea value={template} onChange={(e) => setTemplate(e.target.value)} rows={4} className={`${inputCls} font-mono text-xs`} />
          </ModalField>
        </div>
      </Modal>

      <Modal
        open={created !== null}
        onClose={() => setCreated(null)}
        title="Trigger created"
        description={created?.secret ? "Copy the secret now — it is not shown again." : "Paste this URL into the sending service."}
        footer={
          <Button variant="primary" onClick={() => setCreated(null)}>
            Done
          </Button>
        }
      >
        {created && (
          <div className="space-y-3">
            <ModalField label="Payload URL">
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-surface-0 px-2 py-1 text-[11px] text-zinc-300">{api.hookUrl(created.hookPath)}</code>
                <Button size="sm" variant="ghost" icon={<Copy className="h-3 w-3" />} onClick={() => copy(api.hookUrl(created.hookPath))}>
                  Copy
                </Button>
              </div>
            </ModalField>
            {created.secret && (
              <ModalField label="Secret">
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded bg-surface-0 px-2 py-1 text-[11px] text-zinc-300">{created.secret}</code>
                  <Button size="sm" variant="ghost" icon={<Copy className="h-3 w-3" />} onClick={() => copy(created.secret ?? "")}>
                    Copy
                  </Button>
                </div>
              </ModalField>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
