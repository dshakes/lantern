"use client";

import { useState } from "react";
import { X, Loader2, Mail } from "lucide-react";

export interface InvitedMember {
  id: string;
  name: string;
  email: string;
  role: "admin" | "member" | "viewer";
  joinedAt: Date;
}

interface InviteModalProps {
  open: boolean;
  onClose: () => void;
  onInvited: (member: InvitedMember) => void;
}

export function InviteModal({ open, onClose, onInvited }: InviteModalProps) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member" | "viewer">("member");
  const [sending, setSending] = useState(false);

  if (!open) return null;

  const handleInvite = async () => {
    if (!email.trim() || !email.includes("@")) return;
    setSending(true);

    // Simulate API call
    await new Promise((r) => setTimeout(r, 600));

    const namePart = email.split("@")[0];
    const name = namePart
      .split(/[._-]/)
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join(" ");

    const member: InvitedMember = {
      id: `usr_${Date.now()}`,
      name,
      email: email.trim(),
      role,
      joinedAt: new Date(),
    };

    onInvited(member);
    setSending(false);
    handleClose();
  };

  const handleClose = () => {
    setEmail("");
    setRole("member");
    onClose();
  };

  return (
    <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={handleClose}>
      <div className="modal-content w-full max-w-md rounded-2xl border border-zinc-800 bg-surface-1 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
          <h2 className="text-lg font-semibold text-zinc-100">Invite Team Member</h2>
          <button
            onClick={handleClose}
            className="rounded-lg p-1 text-zinc-500 transition-colors hover:bg-surface-3 hover:text-zinc-300"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Form */}
        <div className="space-y-5 px-6 py-5">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-zinc-300">
              Email address
            </label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="colleague@company.com"
                className="w-full rounded-lg border border-zinc-700 bg-surface-2 pl-10 pr-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30"
              />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-zinc-300">
              Role
            </label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as "admin" | "member" | "viewer")}
              className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500"
            >
              <option value="admin">Admin -- Full access, can manage team</option>
              <option value="member">Developer -- Can create and run agents</option>
              <option value="viewer">Viewer -- Read-only access</option>
            </select>
            <p className="mt-1 text-xs text-zinc-600">
              {role === "admin" && "Admins can manage team members, API keys, and billing."}
              {role === "member" && "Developers can create, deploy, and run agents."}
              {role === "viewer" && "Viewers can see agents and runs but cannot make changes."}
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-zinc-800 px-6 py-4">
          <button
            onClick={handleClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200"
          >
            Cancel
          </button>
          <button
            onClick={handleInvite}
            disabled={!email.trim() || !email.includes("@") || sending}
            className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-lantern-400 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {sending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Sending...
              </>
            ) : (
              "Send Invite"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
