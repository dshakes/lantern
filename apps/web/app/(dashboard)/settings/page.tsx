"use client";

import { format } from "date-fns";
import {
  Key,
  Users,
  CreditCard,
  Shield,
  Copy,
  Trash2,
} from "lucide-react";
import clsx from "clsx";
import { apiKeys, teamMembers } from "@/lib/mock-data";

const roleBadgeColors: Record<string, string> = {
  owner: "bg-lantern-500/10 text-lantern-500",
  admin: "bg-purple-500/10 text-purple-400",
  member: "bg-blue-500/10 text-blue-400",
  viewer: "bg-zinc-500/10 text-zinc-400",
};

export default function SettingsPage() {
  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <div className="border-b border-zinc-800 bg-surface-1 px-8 py-5">
        <h1 className="text-xl font-semibold text-zinc-100">Settings</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Manage API keys, team members, and billing.
        </p>
      </div>

      <div className="flex-1 space-y-8 p-8">
        {/* API Keys */}
        <section>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-100">
              <Key className="h-4.5 w-4.5 text-lantern-500" />
              API Keys
            </h2>
            <button className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-3 py-1.5 text-sm font-medium text-black transition-colors hover:bg-lantern-400">
              Create Key
            </button>
          </div>
          <div className="overflow-hidden rounded-xl border border-zinc-800 bg-surface-1">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Prefix</th>
                  <th>Scopes</th>
                  <th>Created</th>
                  <th className="w-20"></th>
                </tr>
              </thead>
              <tbody>
                {apiKeys.map((key) => (
                  <tr key={key.id}>
                    <td className="font-medium text-zinc-300">{key.name}</td>
                    <td>
                      <div className="flex items-center gap-1.5">
                        <code className="rounded bg-surface-3 px-2 py-0.5 font-mono text-xs text-zinc-400">
                          {key.prefix}...
                        </code>
                        <button className="text-zinc-600 transition-colors hover:text-zinc-400">
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {key.scopes.map((scope) => (
                          <span
                            key={scope}
                            className="rounded bg-surface-3 px-1.5 py-0.5 text-[11px] text-zinc-500"
                          >
                            {scope}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="text-zinc-500">
                      {format(key.createdAt, "MMM d, yyyy")}
                    </td>
                    <td>
                      <button className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-red-400 transition-colors hover:bg-red-500/10">
                        <Trash2 className="h-3 w-3" />
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Team Members */}
        <section>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-100">
              <Users className="h-4.5 w-4.5 text-lantern-500" />
              Team Members
            </h2>
            <button className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-surface-3">
              Invite Member
            </button>
          </div>
          <div className="overflow-hidden rounded-xl border border-zinc-800 bg-surface-1">
            <div className="divide-y divide-zinc-800/50">
              {teamMembers.map((member) => (
                <div
                  key={member.id}
                  className="flex items-center gap-4 px-5 py-3.5"
                >
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-3 text-sm font-medium text-zinc-400">
                    {member.name
                      .split(" ")
                      .map((n) => n[0])
                      .join("")}
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-medium text-zinc-200">
                      {member.name}
                    </p>
                    <p className="text-xs text-zinc-500">{member.email}</p>
                  </div>
                  <span
                    className={clsx(
                      "rounded-full px-2.5 py-0.5 text-xs font-medium",
                      roleBadgeColors[member.role]
                    )}
                  >
                    {member.role}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Billing */}
        <section>
          <div className="mb-4">
            <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-100">
              <CreditCard className="h-4.5 w-4.5 text-lantern-500" />
              Billing
            </h2>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-surface-1 p-8">
            <div className="grid grid-cols-3 gap-6">
              <div>
                <p className="text-xs font-medium text-zinc-500">Current Plan</p>
                <p className="mt-1 text-lg font-semibold text-zinc-100">Pro</p>
                <p className="mt-0.5 text-xs text-zinc-500">$49/mo</p>
              </div>
              <div>
                <p className="text-xs font-medium text-zinc-500">
                  This Month Usage
                </p>
                <p className="mt-1 text-lg font-semibold text-lantern-500">
                  $12.47
                </p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  348 runs / 2.1M tokens
                </p>
              </div>
              <div>
                <p className="text-xs font-medium text-zinc-500">
                  Payment Method
                </p>
                <div className="mt-1 flex items-center gap-2">
                  <Shield className="h-4 w-4 text-zinc-500" />
                  <span className="text-sm text-zinc-300">
                    Visa ending in 4242
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
