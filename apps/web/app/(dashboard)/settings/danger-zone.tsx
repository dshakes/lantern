"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/button";
import { Modal, ModalField } from "@/components/modal";
import { useToast } from "@/components/settings/toast";

const CONFIRM_PHRASE = "delete my workspace";

// Owner-only data rights (ADR 0027 §7): download everything the workspace owns
// as JSON, or erase the workspace for good via the GDPR purge.
export function DangerZone() {
  const { user, logout } = useAuth();
  const { toast } = useToast();
  const router = useRouter();
  const [exporting, setExporting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);

  if (!user || user.role !== "owner") return null;

  const download = async () => {
    setExporting(true);
    try {
      const data = await api.exportTenant(user.tenantId);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `pal-export-${user.tenantId}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast("error", "Couldn't export your data. Try again.");
    } finally {
      setExporting(false);
    }
  };

  const erase = async () => {
    setDeleting(true);
    try {
      await api.deleteTenant(user.tenantId);
      logout();
      router.replace("/login");
    } catch {
      toast("error", "Couldn't delete the workspace. Nothing was removed.");
      setDeleting(false);
    }
  };

  const close = () => {
    setConfirmOpen(false);
    setTyped("");
  };

  return (
    <section className="rounded-xl border border-red-500/20 bg-surface-1 p-5 md:p-6">
      <header className="mb-4">
        <h3 className="text-sm font-semibold text-zinc-100">Your data</h3>
        <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-500">
          Download everything this workspace owns, or delete it. Credentials such as API keys and
          password hashes are left out of the export.
        </p>
      </header>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" icon={<Download className="h-3.5 w-3.5" />} loading={exporting} onClick={download}>
          Export data (JSON)
        </Button>
        <Button variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setConfirmOpen(true)}>
          Delete workspace
        </Button>
      </div>

      <Modal
        open={confirmOpen}
        onClose={close}
        title="Delete this workspace?"
        description="This permanently deletes every agent, run, session, connector, key and user in the workspace. It can't be undone."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button variant="danger" loading={deleting} disabled={typed !== CONFIRM_PHRASE} onClick={erase}>
              Delete forever
            </Button>
          </>
        }
      >
        <ModalField label={`Type "${CONFIRM_PHRASE}" to confirm`}>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-xs text-zinc-100 outline-none focus:border-red-500/50"
          />
        </ModalField>
      </Modal>
    </section>
  );
}
