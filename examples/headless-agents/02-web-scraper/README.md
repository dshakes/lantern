# Demo 02 — web-scraper

Fetches a web page through the harness-enforced HTTP CONNECT proxy and
returns its title + meta description. Proves the **security plane** —
egress allowlist, secret vending, audit log.

**Isolation:** `untrusted` (Firecracker + seccomp deny-default + egress
allowlist + readonly rootfs).

## Run it

```bash
docker build -t lantern/demos/web-scraper:latest examples/headless-agents/02-web-scraper

# Allowed: Wikipedia is on the allowlist (see agent.yaml egress_rules)
lantern run examples/headless-agents/02-web-scraper/agent.yaml \
  --input '{"url": "https://en.wikipedia.org/wiki/Firecracker_(microVM)"}'
# → { "title": "Firecracker (microVM) - Wikipedia", "description": "...", "bytes": 234567 }

# Denied: harness proxy returns 403, workload exits 3, audit event written
lantern run examples/headless-agents/02-web-scraper/agent.yaml \
  --input '{"url": "https://attacker.example.com/exfil"}'
# → exit 3, audit_event { action: "egress.deny", pattern: "attacker.example.com" }
```

## What the audit trail looks like

After the denied run, query the audit log:

```bash
curl -s "http://localhost:8080/v1/runtime/audit?vm_id=$VM_ID" \
  -H "Authorization: Bearer $LANTERN_API_TOKEN" | jq
```

You'll see entries like:

```json
[
  { "action": "schedule",       "attrs": { "image_digest": "...", "isolation": "untrusted" } },
  { "action": "secret.vend",    "attrs": { "env_name": "USER_AGENT", "ttl_sec": 3600 } },
  { "action": "egress.allow",   "attrs": { "host": "en.wikipedia.org", "method": "GET" } },
  { "action": "egress.deny",    "attrs": { "host": "attacker.example.com", "reason": "no rule matches" } },
  { "action": "vm.terminated",  "attrs": { "exit_code": 3, "reason": "workload exited" } }
]
```

## Why `untrusted` isolation

The workload imports third-party packages (`requests`, `beautifulsoup4`).
Any code from PyPI is, by Lantern's threat model, untrusted —
package-supply-chain attacks are well-documented. The Firecracker
microVM + seccomp + egress allowlist contain the blast radius to:

1. Whatever the agent's CPU/memory quota allows.
2. Only outbound traffic to allowlisted hosts.
3. Read-only rootfs (the workload can't persist anything).
4. Audit trail of every external call.

If the package is compromised and tries to phone home — denied + audited.
