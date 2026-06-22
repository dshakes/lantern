# Runbook — Postgres backup & restore

> **Audience:** operators running Lantern in production.
> **Goal:** never lose tenant data, and have a *tested* restore path before you need it.

Lantern's primary datastore is Postgres (`runs`, `agents`, `journal_events`, receipts,
connector credentials, …). Losing it is unrecoverable without a backup. This runbook
covers the two supported topologies.

---

## TL;DR — what to run in production

**Use managed Postgres.** Set `postgresql.enabled=false` and `externalDatabase.enabled=true`
in the control-plane Helm values, pointing at an RDS / Cloud SQL / Azure Database instance.
Managed Postgres gives you **automated snapshots + WAL archiving + point-in-time recovery
(PITR) + failover** with no extra moving parts. The in-cluster Bitnami Postgres is **dev /
evaluation only** — a single pod on a PVC with no backups.

If you must self-host the in-cluster Postgres, enable the logical-backup CronJob
(`backup.enabled=true`) as a floor, and understand its limits (below).

---

## Topology A — Managed Postgres (recommended, GA path)

### Setup
```yaml
# values.yaml
postgresql:
  enabled: false
externalDatabase:
  enabled: true
  host: lantern-prod.xxxx.us-west-2.rds.amazonaws.com
  port: 5432
  database: lantern
  user: lantern
  sslmode: require
  existingSecret: lantern-db
  existingSecretPasswordKey: postgres-password
  appUser: lantern_app           # for RLS enforcement (LANTERN_RLS_ENFORCE=1)
  appExistingSecretPasswordKey: lantern-app-password
```

Provision on the managed instance:
1. The `pgvector` extension: `CREATE EXTENSION IF NOT EXISTS vector;`
2. The non-superuser app role for RLS — run [`infra/db/least-privilege.sql`](../../infra/db/least-privilege.sql).
3. **Enable automated backups + PITR** in the provider:
   - **RDS:** set the backup retention window (e.g. 7–35 days); PITR is automatic.
   - **Cloud SQL:** enable automated backups + point-in-time recovery (WAL).

### Backup verification (do this monthly)
- RDS: confirm `Latest restorable time` is within minutes of now (console → the instance).
- Cloud SQL: confirm the most recent automated backup succeeded and PITR is on.

### Restore (PITR)
1. **Stop writes** — scale the control-plane to 0 (`kubectl scale deploy/<cp> --replicas=0`)
   so nothing writes during the restore.
2. Restore to a **new** instance at the target timestamp:
   - **RDS:** "Restore to point in time" → new instance → pick the timestamp.
   - **Cloud SQL:** `gcloud sql backups restore` or PITR clone to a new instance.
3. Re-point `externalDatabase.host` at the restored instance, re-apply the Helm release.
4. Scale the control-plane back up; verify `/readyz` is green and a known run/agent is present.
5. Decommission the old instance once verified.

> Restore to a **new** instance, never in place — it preserves the corrupted/old one for
> forensics and lets you roll back the restore itself if it's wrong.

---

## Topology B — In-cluster Postgres + logical backup CronJob (self-host floor)

### Setup
```yaml
backup:
  enabled: true
  schedule: "0 2 * * *"     # 02:00 daily
  s3Bucket: lantern-backups
  s3Endpoint: ""            # empty = AWS S3; set to the MinIO endpoint for in-cluster
  retentionDays: 14
```
The CronJob (`*-pg-backup`) runs `pg_dump --clean --if-exists | gzip`, uploads to
`s3://<bucket>/postgres/lantern-<ts>.sql.gz`, and prunes objects older than
`retentionDays`.

> **Limits — read before relying on this.** A logical `pg_dump` is a point-in-time
> snapshot taken on the schedule. You **lose every write between the last dump and the
> failure** (no PITR). It also takes a consistent snapshot but is heavier on large DBs.
> This is a *floor*, not a GA backup strategy — prefer Topology A.

### Verify a backup exists
```bash
aws s3 ls s3://lantern-backups/postgres/        # newest object should be < 24h old
```

### Restore from a dump
1. **Stop writes**: `kubectl scale deploy/<control-plane> --replicas=0`.
2. Pull the dump:
   ```bash
   aws s3 cp s3://lantern-backups/postgres/lantern-<ts>.sql.gz ./restore.sql.gz
   ```
3. Restore into a fresh database (do NOT restore over the live one in place):
   ```bash
   # create a clean target DB, then:
   gunzip -c restore.sql.gz | psql "postgres://lantern:***@<host>:5432/lantern_restore?sslmode=require"
   ```
   The dump uses `--clean --if-exists`, so it drops+recreates objects; restoring into an
   empty DB is cleanest.
4. Re-point `DATABASE_URL` (or the restored DB name) and re-apply the release.
5. Scale the control-plane up; verify `/readyz` + a known run/agent.

---

## The restore DRILL (do this BEFORE you need it)

A backup you've never restored is a hope, not a backup. Quarterly:

1. Take/identify a recent backup.
2. Restore it into a **scratch** database/instance (never prod).
3. Point a *staging* control-plane at it; confirm `/readyz`, list runs, open an agent,
   verify a signed receipt still verifies (proves `journal_events` integrity survived).
4. Record the **RTO** (time to restore) and **RPO** (data-loss window) you observed.
5. File any gaps. Tear down the scratch instance.

Target SLOs to write down for your deployment: **RPO ≤ 5 min** (PITR) / **RTO ≤ 30 min**.
The in-cluster logical-backup path cannot meet RPO ≤ 5 min — that's the reason Topology A
is the GA recommendation.
