# Data Model

> Postgres schemas, Redis keys, S3 layout. **The reference for anyone writing a service.** Schemas here are normative; service code must match.

## Storage tiers

| Tier | Tech | What lives here | Why |
|---|---|---|---|
| **OLTP** | Postgres 16 + pgvector + pg_partman | All system-of-record state: tenants, agents, runs, journal events, vault metadata, surface sessions, connector installs | One database, transactional, well-understood |
| **Cache + queues** | Redis 7 (cluster) | Rate limits, presence, prompt cache, semantic cache index, work queue, ephemeral state | Speed |
| **Blob** | S3 (or compatible) | Agent bundles, large artifacts, run inputs/outputs over a threshold, attachments | Cheap, durable, content-addressed |
| **Search** | Postgres GIN + pgvector HNSW | Lexical + vector search across runs and memory | Avoid running yet another store |
| **Time-series** | Mimir / Prometheus | Metrics | Standard |
| **Logs** | Loki | Structured logs | Standard |
| **Traces** | Tempo | OTel traces | Standard |

**No Kafka, no Elasticsearch, no separate vector DB, no DynamoDB, no MongoDB.**

---

## Multi-tenancy

Every row in every Postgres table has a `tenant_id UUID NOT NULL`. Every query filters by it. Application-layer enforcement is enforced by `pg_policies` (Row-Level Security) as a defense-in-depth.

Per-tenant Postgres schema separation is **rejected** for the spike (operationally complex; cross-tenant analytics impossible). Per-tenant *databases* are an option for the highest enterprise tier post-launch.

---

## Postgres schemas

### Identity & tenancy

```sql
CREATE TABLE tenants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT NOT NULL UNIQUE,                  -- 'acme'
  name          TEXT NOT NULL,
  tier          TEXT NOT NULL CHECK (tier IN ('personal','team','enterprise')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  settings      JSONB NOT NULL DEFAULT '{}'::jsonb,
  k8s_namespace TEXT NOT NULL UNIQUE                   -- 'lantern-t-<uuid>'
);

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         CITEXT NOT NULL,
  display_name  TEXT,
  auth_provider TEXT NOT NULL,                          -- 'google', 'github', 'magic-link', ...
  auth_subject  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ,
  UNIQUE (auth_provider, auth_subject),
  UNIQUE (tenant_id, email)
);

CREATE TABLE roles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,                          -- 'owner', 'admin', 'developer', 'viewer'
  permissions   TEXT[] NOT NULL,
  UNIQUE (tenant_id, name)
);

CREATE TABLE memberships (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id       UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE api_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  prefix        TEXT NOT NULL,                          -- 'hlx_live_xxx' (visible)
  hash          BYTEA NOT NULL,                         -- argon2id of full key
  scopes        TEXT[] NOT NULL,
  expires_at    TIMESTAMPTZ,
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_prefix_idx ON api_keys (prefix);
```

### Agents and bundles

```sql
CREATE TABLE agents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,                          -- [a-z0-9-]{1,63}
  description   TEXT,
  current_version_id UUID,                              -- updated when a version is promoted
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at   TIMESTAMPTZ,
  labels        JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (tenant_id, name)
);

CREATE TABLE agent_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version       TEXT NOT NULL,                          -- semver
  digest        BYTEA NOT NULL,                         -- sha256 of bundle
  bundle_uri    TEXT NOT NULL,                          -- s3://...
  manifest      JSONB NOT NULL,                         -- resolved agent.yaml + lock
  signature     BYTEA,                                  -- cosign sig (optional)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  promoted_at   TIMESTAMPTZ,
  yanked_at     TIMESTAMPTZ,
  UNIQUE (agent_id, version),
  UNIQUE (agent_id, digest)
);

CREATE INDEX agent_versions_digest_idx ON agent_versions (digest);

ALTER TABLE agents
  ADD CONSTRAINT fk_current_version
  FOREIGN KEY (current_version_id) REFERENCES agent_versions(id) ON DELETE SET NULL;
```

### Runs and durable journal

```sql
CREATE TABLE runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  agent_version_id UUID NOT NULL REFERENCES agent_versions(id) ON DELETE RESTRICT,
  status        TEXT NOT NULL,                          -- queued|running|paused|succeeded|failed|cancelled
  trigger_kind  TEXT NOT NULL,                          -- api|schedule|webhook|surface|a2a|manual
  trigger_meta  JSONB NOT NULL DEFAULT '{}'::jsonb,
  input         JSONB NOT NULL,
  output        JSONB,
  error         JSONB,
  cost_usd      NUMERIC(12,6) NOT NULL DEFAULT 0,
  tokens_in     BIGINT NOT NULL DEFAULT 0,
  tokens_out    BIGINT NOT NULL DEFAULT 0,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  parent_run_id UUID REFERENCES runs(id),               -- for sub-agent child runs
  labels        JSONB NOT NULL DEFAULT '{}'::jsonb
) PARTITION BY RANGE (created_at);

-- Monthly partitions managed by pg_partman
SELECT partman.create_parent('public.runs','created_at','native','monthly');

CREATE INDEX runs_tenant_status_created_idx
  ON runs (tenant_id, status, created_at DESC);
CREATE INDEX runs_agent_created_idx
  ON runs (agent_id, created_at DESC);
```

The journal — the heart of durability:

```sql
CREATE TABLE journal_events (
  run_id        UUID NOT NULL,
  seq           BIGINT NOT NULL,                        -- monotonic per run
  kind          TEXT NOT NULL,                          -- run.started, step.started, step.completed, ...
  step_id       TEXT,                                   -- 'plan', 'search.0', 'synth'
  attempt       INT NOT NULL DEFAULT 1,
  payload       BYTEA NOT NULL,                         -- protobuf, often compressed
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
) PARTITION BY HASH (run_id);

-- 32 hash partitions for write spread
DO $$
BEGIN
  FOR i IN 0..31 LOOP
    EXECUTE format(
      'CREATE TABLE journal_events_p%s PARTITION OF journal_events FOR VALUES WITH (modulus 32, remainder %s)', i, i
    );
  END LOOP;
END$$;

CREATE INDEX journal_events_run_kind_idx ON journal_events (run_id, kind, seq);

-- Run lock for split-brain prevention (uses pg_advisory_xact_lock in code)
CREATE TABLE run_locks (
  run_id        UUID PRIMARY KEY,
  worker_id     TEXT NOT NULL,
  acquired_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);
```

`journal_events` is hash-partitioned by `run_id` to spread writes. The `(run_id, seq)` PK guarantees ordering within a run; the engine treats `seq` as monotonic and never re-uses a sequence number.

### Step state (denormalized for fast reads)

```sql
CREATE TABLE step_state (
  run_id        UUID NOT NULL,
  step_id       TEXT NOT NULL,
  attempt       INT NOT NULL,
  status        TEXT NOT NULL,                          -- pending|running|succeeded|failed|cancelled
  result        BYTEA,                                  -- protobuf-encoded result
  error         JSONB,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  PRIMARY KEY (run_id, step_id, attempt)
) PARTITION BY HASH (run_id);
```

Built from journal events on demand or maintained by an event projector.

### Triggers, schedules, webhooks

```sql
CREATE TABLE triggers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                          -- schedule|webhook|connector|a2a|surface
  config        JSONB NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE schedules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_id    UUID NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  cron          TEXT NOT NULL,
  tz            TEXT NOT NULL DEFAULT 'UTC',
  next_fire_at  TIMESTAMPTZ NOT NULL,
  last_fire_at  TIMESTAMPTZ
);

CREATE INDEX schedules_next_fire_idx ON schedules (next_fire_at) WHERE next_fire_at IS NOT NULL;

CREATE TABLE webhook_subscriptions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_id        UUID NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  ingest_url        TEXT NOT NULL UNIQUE,                -- https://hooks.lantern.run/<uuid>
  signing_secret    BYTEA NOT NULL,                      -- HMAC verification
  vendor            TEXT,                                -- 'github', 'stripe', ...
  vendor_handle     TEXT                                 -- subscription id at vendor
);
```

### Connectors

```sql
CREATE TABLE connector_installs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connector_id  TEXT NOT NULL,                          -- 'gmail', 'slack', ...
  account_label TEXT,                                   -- 'work', 'personal'
  status        TEXT NOT NULL,                          -- active|expired|revoked
  scopes        TEXT[] NOT NULL,
  vault_ref     TEXT NOT NULL,                          -- pointer into vault for token
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  installed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ
);

CREATE INDEX connector_installs_user_idx ON connector_installs (user_id, connector_id);
```

### Vault

```sql
CREATE TABLE vault_secrets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES users(id) ON DELETE CASCADE,    -- null = tenant-scoped
  alias         TEXT NOT NULL,                          -- the lantern.secret/<alias> ref
  ciphertext    BYTEA NOT NULL,                         -- envelope-encrypted
  wrapping      TEXT NOT NULL,                          -- 'tenant-kms' | 'user-key'
  kid           TEXT NOT NULL,                          -- key ID at the wrapping KMS
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at    TIMESTAMPTZ,
  UNIQUE (tenant_id, user_id, alias)
);
```

### Memory

```sql
CREATE TABLE memory_entries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope_kind    TEXT NOT NULL,                          -- tenant|user|agent|run
  scope_id      UUID NOT NULL,
  tier          TEXT NOT NULL,                          -- core|recall|archival
  key           TEXT,
  text          TEXT,                                   -- searchable text
  embedding     vector(1536),                           -- pgvector
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  blob_uri      TEXT,                                   -- s3 if large
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX memory_entries_scope_idx ON memory_entries (tenant_id, scope_kind, scope_id, tier);
CREATE INDEX memory_entries_text_gin ON memory_entries USING GIN (to_tsvector('english', text));
CREATE INDEX memory_entries_embedding_hnsw ON memory_entries USING hnsw (embedding vector_cosine_ops);
```

### Surface sessions (mobile / chat / voice / email)

```sql
CREATE TABLE surface_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  surface         TEXT NOT NULL,                        -- slack|imessage|telegram|push|...
  external_id     TEXT NOT NULL,
  active_run_id   UUID REFERENCES runs(id),
  presence        JSONB,
  e2e_pubkey      BYTEA,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, surface, external_id)
);
```

### Notifications

```sql
CREATE TABLE notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  channel         TEXT NOT NULL,                        -- email|slack|sms|push|inapp|webhook
  template_id     TEXT NOT NULL,
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL,                        -- pending|sent|failed|dropped
  sent_at         TIMESTAMPTZ,
  attempts        INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  idempotency_key TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);
```

### Billing

```sql
CREATE TABLE usage_events (
  id            BIGSERIAL,
  tenant_id     UUID NOT NULL,
  agent_id      UUID,
  run_id        UUID,
  user_id       UUID,
  metric        TEXT NOT NULL,                          -- cpu_seconds, gpu_seconds, tokens_in_<model>, ...
  qty           NUMERIC(20,6) NOT NULL,
  unit          TEXT NOT NULL,
  cost_usd      NUMERIC(12,6) NOT NULL,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);

SELECT partman.create_parent('public.usage_events','ts','native','daily');

CREATE TABLE budgets (
  tenant_id     UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  monthly_cap   NUMERIC(12,2) NOT NULL,
  hard_cutoff   BOOLEAN NOT NULL DEFAULT true,
  warn_at_pct   INT NOT NULL DEFAULT 75,
  current_spend NUMERIC(12,6) NOT NULL DEFAULT 0
);
```

---

## Redis keys

| Key pattern | Purpose | TTL |
|---|---|---|
| `rl:t:{tenant}:1m` | Per-tenant rate limit token bucket (1-minute window) | 90s |
| `rl:k:{api_key}:1m` | Per-API-key rate limit | 90s |
| `presence:s:{session_id}` | Surface session presence | 5m |
| `pcache:{tenant}:{prompt_hash}` | Model router prompt cache | 24h (configurable) |
| `pcache_idx:{tenant}` | pgvector cache lookup is in PG; this is hot index | n/a |
| `wp:{class}` | Warm pool for runtime manager (list of warm sandbox IDs) | n/a (LRU bounded) |
| `runq:{tenant}:{priority}` | Run queue for fair-share scheduler | n/a |
| `signal:{run_id}:{name}` | Pending signals waiting for delivery | until consumed |

---

## S3 layout

```
s3://lantern-bundles-prod/
  tenants/<tenant_id>/
    agents/<agent_name>/
      versions/<sha256>/
        bundle.tar.zst
        manifest.lock.json
        signature.cosign.bundle

s3://lantern-runs-prod/
  tenants/<tenant_id>/
    runs/<yyyy>/<mm>/<dd>/<run_id>/
      input.json
      output.json
      events/<seq>.bin           # large journal entry payloads spilled here
      logs/<step_id>.log.zst
      artifacts/<name>           # files the agent produced

s3://lantern-snapshots-prod/
  runtimes/firecracker/<digest>/
    snapshot.fcs
    memfile.bin

s3://lantern-attachments-prod/
  tenants/<tenant_id>/
    surface/<session_id>/<attachment_id>     # encrypted blobs from chat
```

S3 lifecycle policies:
- bundles: Standard for 30 days, then IA for 1 year, then Glacier
- run inputs/outputs: Standard for 7 days, IA for 30 days, expire at retention policy
- snapshots: Standard while in active LRU, deleted when evicted from warm pool index

---

## Migration discipline

- One sqlc-managed migration tree at `migrations/`.
- Migrations are forward-only. **Never** edit a committed migration.
- Each migration has an idempotent `up` script and a tested `down` script.
- New columns are nullable until backfilled.
- Index creates use `CONCURRENTLY` in production.
- Schema changes that touch a hot table require an ADR.

---

## What's intentionally NOT in this model

- **No `is_deleted` flag** — deletes cascade or move to `*_archive` tables.
- **No application-side joins across tenants** — the RLS policies prevent it even if you tried.
- **No JSONB-as-storage for things that should be columns** — JSONB is for genuinely variable data only.
- **No timestamps without `Z`** — every timestamp is `TIMESTAMPTZ`.
