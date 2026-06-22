# Runbook — control-plane down / 5xx

> **Audience:** on-call operators.
> **Fires from:** `ControlPlaneDown` (critical), `ControlPlaneNotReady` (critical).
> **Dashboards:** Lantern — Platform Overview.

The control-plane (`services/control-plane`, REST `:8080`, gRPC `:50051`) is the
front door: auth, agents, runs, sessions, connectors, budgets, marketplace, and
the dashboard backend all live behind it. If it is down, the platform is down.

---

## What fired it

- **`ControlPlaneDown`** — the scrape/probe target `up{job="lantern-control-plane"}`
  has been 0 for 2m. The process is unreachable (crash-loop, OOM, scheduling
  failure, or network).
- **`ControlPlaneNotReady`** — the blackbox probe of `/readyz` reports not-ready
  for 3m. The process is **up** but a hard dependency (Postgres or Redis) is
  unreachable, so it refuses traffic. This usually points at the DB, not the
  control-plane itself — cross-check `db-saturation.md`.

> **Note on 5xx rate.** A true HTTP-5xx-rate alert needs the
> `lantern_http_requests_total` counter, which is **not emitted yet** (TODO in
> `infra/monitoring/prometheus/alerts.yml`). Until that middleware ships, "5xx"
> is observed via the liveness/readiness probes above and the logs below — not a
> Prometheus error-rate series.

---

## Triage

```bash
# Pod state — look for CrashLoopBackOff, OOMKilled, Pending.
kubectl -n <ns> get pods -l app.kubernetes.io/name=control-plane -o wide
kubectl -n <ns> describe pod <control-plane-pod> | sed -n '/Events/,$p'

# Recent logs (control-plane logs at LOG_LEVEL; start near the crash).
kubectl -n <ns> logs deploy/<control-plane> --tail=200
kubectl -n <ns> logs deploy/<control-plane> --previous --tail=100   # last crash

# Hit the health endpoints directly from inside the cluster.
kubectl -n <ns> exec deploy/<control-plane> -- wget -qO- localhost:8080/healthz
kubectl -n <ns> exec deploy/<control-plane> -- wget -qO- localhost:8080/readyz
```

`/healthz` = process liveness. `/readyz` = liveness **plus** DB/Redis
reachability. A green `/healthz` + red `/readyz` means the dependency is the
problem.

Check the dependencies the control-plane needs at boot:

```bash
# Postgres reachable + accepting connections?  (see db-saturation.md for depth)
kubectl -n <ns> exec deploy/<control-plane> -- sh -c \
  'nc -z $POSTGRES_HOST 5432 && echo db-ok || echo db-unreachable'

# Redis (SSE pub/sub, rate limiting, session events).
kubectl -n <ns> exec deploy/<control-plane> -- sh -c \
  'nc -z $REDIS_HOST 6379 && echo redis-ok || echo redis-unreachable'
```

---

## Remediation

1. **CrashLoopBackOff / panic at boot** — read `--previous` logs. Common causes:
   - bad/rotated `DATABASE_URL`, `REDIS_URL`, or a missing required secret
     (JWT secret, credential key) → fix the Secret, roll the deployment.
   - a failed DB migration on startup → see `db-restore.md` / the migration
     tooling; do NOT delete data to "get past" a migration.
2. **OOMKilled** — bump `controlPlane.resources.limits.memory` in the Helm
   values and roll. Note the trigger (a fan-out/large response) for follow-up.
3. **`/readyz` red, DB/Redis unreachable** — the control-plane is healthy;
   recover the dependency. Go to `db-saturation.md` (Postgres) or restore Redis.
4. **Image/rollout regression** — if this started right after a deploy, roll
   back: `kubectl -n <ns> rollout undo deploy/<control-plane>`.

After recovery confirm: `/readyz` green, `up{job="lantern-control-plane"} == 1`,
and a known agent lists via `GET /v1/agents`.

---

## Escalate

- DB is the root cause and not recovering → **DB on-call** + `db-saturation.md`,
  `db-restore.md`.
- Crash persists after a rollback to a known-good image → **platform on-call**;
  capture `--previous` logs and the `describe` Events before restarting again.
