"use client";

// "Schedule VM" modal — gives the UI parity with `lantern run agent.yaml`
// + `POST /v1/runtime/schedule`. Lets an operator stand up a one-off
// headless agent without dropping to the CLI or curl.
//
// Fields mirror the AgentSpec proto:
//   - image (image_digest)
//   - isolation (enum)
//   - command + args (entrypoint override)
//   - env (extra env vars)
// Limits + egress + secrets are intentionally NOT exposed here — they
// belong in a saved agent.yaml not a click-to-spawn form. Operators
// who need them are already using the CLI.

import { useState } from "react";
import { Server, Plus, Trash2 } from "lucide-react";
import { Modal, ModalField } from "@/components/modal";
import { Button } from "@/components/button";
import { runtimeApi, UnauthorizedError } from "@/lib/runtime-api";
import { useToast } from "@/components/toast";

interface ScheduleModalProps {
  open: boolean;
  onClose: () => void;
  onScheduled: () => void;
}

type Isolation =
  | "trusted"
  | "standard"
  | "untrusted"
  | "hostile"
  | "wasm"
  | "devcontainer";

const ISOLATION_OPTIONS: { value: Isolation; label: string; hint: string }[] = [
  { value: "trusted", label: "Trusted", hint: "K8s Job — first-party only" },
  { value: "standard", label: "Standard", hint: "Firecracker — default" },
  { value: "untrusted", label: "Untrusted", hint: "Firecracker + egress allowlist" },
  { value: "hostile", label: "Hostile", hint: "Kata — full VM" },
  { value: "wasm", label: "Wasm", hint: "Wasmtime — deterministic, no I/O" },
  { value: "devcontainer", label: "Devcontainer", hint: "Long-lived pod + PVC" },
];

// Quick-start presets — common ad-hoc workloads operators want to test.
const PRESETS: { label: string; spec: Partial<FormState> }[] = [
  {
    label: "Alpine echo (60s)",
    spec: {
      image: "alpine:latest",
      isolation: "trusted",
      command: 'sh,-c',
      args: 'echo Hello from $HOSTNAME; sleep 60',
    },
  },
  {
    label: "Python idle (5m)",
    spec: {
      image: "python:3.11-slim",
      isolation: "standard",
      command: "python3,-c",
      args: 'import time; print("python ready"); time.sleep(300)',
    },
  },
  {
    label: "Busybox shell",
    spec: {
      image: "busybox:latest",
      isolation: "untrusted",
      command: "sh,-c",
      args: "echo locked-down; sleep 120",
    },
  },
];

interface FormState {
  image: string;
  isolation: Isolation;
  command: string; // comma-separated
  args: string; // single shell-ish string (whole thing becomes ONE arg)
  env: { key: string; value: string }[];
}

const EMPTY: FormState = {
  image: "alpine:latest",
  isolation: "trusted",
  command: "",
  args: "",
  env: [],
};

export function ScheduleModal({ open, onClose, onScheduled }: ScheduleModalProps) {
  const toast = useToast();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [submitting, setSubmitting] = useState(false);

  const reset = () => setForm(EMPTY);
  const close = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  const applyPreset = (preset: Partial<FormState>) => {
    setForm({ ...EMPTY, ...preset });
  };

  const addEnv = () =>
    setForm((f) => ({ ...f, env: [...f.env, { key: "", value: "" }] }));
  const updateEnv = (i: number, patch: Partial<{ key: string; value: string }>) =>
    setForm((f) => ({
      ...f,
      env: f.env.map((row, idx) => (idx === i ? { ...row, ...patch } : row)),
    }));
  const removeEnv = (i: number) =>
    setForm((f) => ({ ...f, env: f.env.filter((_, idx) => idx !== i) }));

  const submit = async () => {
    if (!form.image.trim()) {
      toast.error("Image is required");
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        imageDigest: form.image.trim(),
        isolation: form.isolation,
      };
      const cmd = form.command
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (cmd.length) body.command = cmd;
      // args: pass as a single argv element (the typical sh -c '<script>' pattern).
      if (form.args.trim()) body.args = [form.args];
      const env: Record<string, string> = {};
      for (const { key, value } of form.env) {
        const k = key.trim();
        if (k) env[k] = value;
      }
      if (Object.keys(env).length) body.env = env;

      const resp = await runtimeApi.post<{ vmId: string }>(
        "/v1/runtime/schedule",
        body,
      );
      toast.success(`Scheduled ${resp.vmId}`);
      reset();
      onScheduled();
      onClose();
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) {
        toast.error(
          "Schedule failed: " +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Schedule a VM"
      description="Spawn a headless agent into the runtime. Backed by POST /v1/runtime/schedule."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            loading={submitting}
            icon={<Server className="h-3.5 w-3.5" />}
          >
            Schedule
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {/* Presets */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase text-zinc-500">Presets:</span>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => applyPreset(p.spec)}
              className="rounded-full border border-zinc-700 bg-surface-2 px-2.5 py-1 text-[11px] text-zinc-300 transition-colors hover:bg-surface-3 hover:text-zinc-100"
              type="button"
            >
              {p.label}
            </button>
          ))}
        </div>

        <ModalField
          label="Image"
          hint="Container image — tag or fully-qualified ref (e.g. alpine:latest, ghcr.io/lantern/agent-runner:v1)."
        >
          <input
            value={form.image}
            onChange={(e) => setForm({ ...form, image: e.target.value })}
            placeholder="alpine:latest"
            className="w-full rounded-lg border border-zinc-700 bg-surface-0 px-3 py-2 font-mono text-sm text-zinc-100 placeholder-zinc-600 focus:border-lantern-500 focus:outline-none"
          />
        </ModalField>

        <ModalField label="Isolation class" hint="Picks the sandbox backend the scheduler routes to.">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            {ISOLATION_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setForm({ ...form, isolation: opt.value })}
                type="button"
                className={`rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                  form.isolation === opt.value
                    ? "border-lantern-500 bg-lantern-500/10 text-zinc-100"
                    : "border-zinc-700 bg-surface-0 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
                }`}
              >
                <div className="font-medium">{opt.label}</div>
                <div className="mt-0.5 text-[10px] text-zinc-500">{opt.hint}</div>
              </button>
            ))}
          </div>
        </ModalField>

        <ModalField
          label="Command"
          hint="Entrypoint override (comma-separated). Empty = image's default ENTRYPOINT. Example: sh,-c"
        >
          <input
            value={form.command}
            onChange={(e) => setForm({ ...form, command: e.target.value })}
            placeholder="sh,-c"
            className="w-full rounded-lg border border-zinc-700 bg-surface-0 px-3 py-2 font-mono text-sm text-zinc-100 placeholder-zinc-600 focus:border-lantern-500 focus:outline-none"
          />
        </ModalField>

        <ModalField
          label="Arguments"
          hint="Passed as a single argv element to the command. Typical with sh -c: the whole script."
        >
          <textarea
            value={form.args}
            onChange={(e) => setForm({ ...form, args: e.target.value })}
            placeholder="echo hello; sleep 60"
            rows={2}
            className="w-full resize-y rounded-lg border border-zinc-700 bg-surface-0 px-3 py-2 font-mono text-sm text-zinc-100 placeholder-zinc-600 focus:border-lantern-500 focus:outline-none"
          />
        </ModalField>

        <ModalField label="Environment variables" hint="Tenant id + agent version id are injected automatically.">
          <div className="space-y-2">
            {form.env.map((row, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  value={row.key}
                  onChange={(e) => updateEnv(i, { key: e.target.value })}
                  placeholder="KEY"
                  className="w-40 rounded-lg border border-zinc-700 bg-surface-0 px-3 py-1.5 font-mono text-xs text-zinc-100 placeholder-zinc-600 focus:border-lantern-500 focus:outline-none"
                />
                <span className="text-zinc-600">=</span>
                <input
                  value={row.value}
                  onChange={(e) => updateEnv(i, { value: e.target.value })}
                  placeholder="value"
                  className="flex-1 rounded-lg border border-zinc-700 bg-surface-0 px-3 py-1.5 font-mono text-xs text-zinc-100 placeholder-zinc-600 focus:border-lantern-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => removeEnv(i)}
                  className="rounded p-1 text-zinc-500 hover:bg-surface-3 hover:text-red-400"
                  aria-label="Remove env"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              onClick={addEnv}
              icon={<Plus className="h-3.5 w-3.5" />}
            >
              Add env var
            </Button>
          </div>
        </ModalField>
      </div>
    </Modal>
  );
}
