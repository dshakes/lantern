# Runbook — Postgres connection saturation

> **Audience:** on-call operators.
> **Fires from:** `PostgresConnectionSaturation` (warning), `PostgresExporterDown`
> (warning), and is the likely root cause behind `ControlPlaneNotReady`.
> **Dashboards:** Lantern — Platform Overview.

Postgres is the primary datastore (`runs`, `agents`, `journal_events`, sessions,
budgets, receipts, connector creds, …). Every Go service connects via a
`pgxpool`. When live backends approach `max_connections`, new connections are
refused — the control-plane's `/readyz` goes red and writes start failing. This
is almost always a **connection leak** or an **undersized pool/limit under
load**, not "too much traffic" per se.

---

## What fired it

- **`PostgresConnectionSaturation`** —
  `sum(pg_stat_database_numbackends) / max(pg_settings_max_connections) > 0.85`
  for 5m. Both are standard `postgres_exporter` metrics (no custom query). Over
  85% of connection slots are in use.
- **`PostgresExporterDown`** — `up{job="lantern-postgres-exporter"} == 0`. The
  exporter is the source for this alert **and** for `DataPlaneHeartbeatStale` /
  `CronScheduleOverdue` (its custom queries). While it's down those are blind.

---

## Triage

```sql
-- Where are the connections going?  By state and application.
SELECT state, count(*)
FROM pg_stat_activity
GROUP BY state ORDER BY count(*) DESC;

-- Idle-in-transaction is the classic leak signature — held connections doing
-- nothing.  A pile of these = a service not releasing/committing.
SELECT pid, usename, application_name, state,
       now() - state_change AS in_state, left(query, 120) AS query
FROM pg_stat_activity
WHERE state = 'idle in transaction'
ORDER BY state_change ASC
LIMIT 25;

-- Headroom.
SELECT (SELECT count(*) FROM pg_stat_activity)        AS used,
       current_setting('max_connections')::int        AS max_conns;
```

```bash
# Pool sizing the control-plane is configured with.
kubectl -n <ns> exec deploy/<control-plane> -- printenv | grep -i 'PG_MAX_CONNS\|DATABASE_URL' | sed 's/:[^:@]*@/:***@/'

# Is one service the hog?  application_name above usually identifies it; logs
# confirm long-held transactions.
kubectl -n <ns> logs deploy/<control-plane> --tail=200 | grep -i 'pool\|connection\|timeout'
```

---

## Remediation

1. **Connection leak (idle-in-transaction pile)** — the real fix is in the
   offending service (a transaction not committed/rolled back). To restore
   service NOW, roll the leaking deployment so its pool resets:
   `kubectl -n <ns> rollout restart deploy/<service>`. As a last resort, cancel
   the oldest stuck backends:
   ```sql
   SELECT pg_terminate_backend(pid)
   FROM pg_stat_activity
   WHERE state = 'idle in transaction'
     AND state_change < now() - interval '10 minutes';
   ```
   Capture the offending `application_name`/`query` first — that's the bug.
2. **Genuinely undersized for load** — scale connections deliberately:
   - lower per-pod pool size (`LANTERN_PG_MAX_CONNS`) if you have many replicas
     each holding a big pool (replicas × pool can exceed `max_connections`); OR
   - raise `max_connections` on the DB (managed Postgres: change the parameter
     group / flags); OR
   - put PgBouncer in front for connection multiplexing.
   Right-size `replicas × pool ≤ max_connections` with headroom.
3. **Exporter down** — recover `postgres_exporter` so visibility returns; it does
   not affect the DB itself, only the alerts derived from it.

Confirm recovery: saturation ratio back under ~0.6, `/readyz` green,
idle-in-transaction count near zero.

---

## Escalate

- The DB itself is unhealthy (disk full, failover, replication lag), not just
  connection count → **DB on-call**; see also `db-restore.md`.
- A service leaks connections faster than restarts buy time → the owning team to
  fix the transaction handling; **platform on-call** to coordinate.
