package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Migrate runs the core CREATE TABLE statements needed by the control plane.
// This is a spike-only approach: in production, use a proper migration tool
// (e.g., golang-migrate or Atlas). All statements are idempotent.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	for i, stmt := range migrations {
		if _, err := pool.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("migration %d failed: %w", i, err)
		}
	}
	return nil
}

var migrations = []string{
	// ---------------------------------------------------------------
	// Tenants (minimal — enough for FK references)
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS tenants (
		id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		slug          TEXT NOT NULL UNIQUE,
		name          TEXT NOT NULL,
		tier          TEXT NOT NULL CHECK (tier IN ('personal','team','enterprise')),
		created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
		settings      JSONB NOT NULL DEFAULT '{}'::jsonb,
		k8s_namespace TEXT NOT NULL UNIQUE
	)`,

	// ---------------------------------------------------------------
	// Users
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS users (
		id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		email         TEXT NOT NULL,
		display_name  TEXT,
		auth_provider TEXT NOT NULL,
		auth_subject  TEXT NOT NULL,
		created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
		last_seen_at  TIMESTAMPTZ,
		UNIQUE (auth_provider, auth_subject),
		UNIQUE (tenant_id, email)
	)`,

	// ---------------------------------------------------------------
	// Agents
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS agents (
		id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		name               TEXT NOT NULL,
		description        TEXT,
		current_version_id UUID,
		created_by         UUID REFERENCES users(id),
		created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
		archived_at        TIMESTAMPTZ,
		labels             JSONB NOT NULL DEFAULT '{}'::jsonb,
		UNIQUE (tenant_id, name)
	)`,

	// ---------------------------------------------------------------
	// Agent versions
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS agent_versions (
		id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
		version     TEXT NOT NULL,
		digest      BYTEA NOT NULL,
		bundle_uri  TEXT NOT NULL,
		manifest    JSONB NOT NULL,
		signature   BYTEA,
		created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
		promoted_at TIMESTAMPTZ,
		yanked_at   TIMESTAMPTZ,
		UNIQUE (agent_id, version),
		UNIQUE (agent_id, digest)
	)`,

	// FK from agents.current_version_id -> agent_versions.id.
	// Using DO block for idempotency.
	`DO $$
	BEGIN
		IF NOT EXISTS (
			SELECT 1 FROM pg_constraint WHERE conname = 'fk_current_version'
		) THEN
			ALTER TABLE agents
				ADD CONSTRAINT fk_current_version
				FOREIGN KEY (current_version_id) REFERENCES agent_versions(id) ON DELETE SET NULL;
		END IF;
	END$$`,

	// ---------------------------------------------------------------
	// Runs (non-partitioned for the spike; production uses pg_partman)
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS runs (
		id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		agent_id         UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
		agent_version_id UUID NOT NULL REFERENCES agent_versions(id) ON DELETE RESTRICT,
		status           TEXT NOT NULL,
		trigger_kind     TEXT NOT NULL,
		trigger_meta     JSONB NOT NULL DEFAULT '{}'::jsonb,
		input            JSONB NOT NULL,
		output           JSONB,
		error            JSONB,
		cost_usd         NUMERIC(12,6) NOT NULL DEFAULT 0,
		tokens_in        BIGINT NOT NULL DEFAULT 0,
		tokens_out       BIGINT NOT NULL DEFAULT 0,
		started_at       TIMESTAMPTZ,
		finished_at      TIMESTAMPTZ,
		created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
		parent_run_id    UUID REFERENCES runs(id),
		labels           JSONB NOT NULL DEFAULT '{}'::jsonb
	)`,

	// Indexes for runs.
	`CREATE INDEX IF NOT EXISTS runs_tenant_status_created_idx
		ON runs (tenant_id, status, created_at DESC)`,

	`CREATE INDEX IF NOT EXISTS runs_agent_created_idx
		ON runs (agent_id, created_at DESC)`,

	// ---------------------------------------------------------------
	// Journal events (non-partitioned for the spike)
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS journal_events (
		run_id     UUID NOT NULL,
		seq        BIGINT NOT NULL,
		kind       TEXT NOT NULL,
		step_id    TEXT,
		attempt    INT NOT NULL DEFAULT 1,
		payload    BYTEA NOT NULL,
		created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
		PRIMARY KEY (run_id, seq)
	)`,

	`CREATE INDEX IF NOT EXISTS journal_events_run_kind_idx
		ON journal_events (run_id, kind, seq)`,

	// ---------------------------------------------------------------
	// Run locks
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS run_locks (
		run_id      UUID PRIMARY KEY,
		worker_id   TEXT NOT NULL,
		acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
		expires_at  TIMESTAMPTZ NOT NULL
	)`,

	// ---------------------------------------------------------------
	// Index on agent_versions digest
	// ---------------------------------------------------------------
	`CREATE INDEX IF NOT EXISTS agent_versions_digest_idx
		ON agent_versions (digest)`,

	// ---------------------------------------------------------------
	// Row-Level Security policies (defense-in-depth)
	// ---------------------------------------------------------------
	`ALTER TABLE agents ENABLE ROW LEVEL SECURITY`,

	`DO $$
	BEGIN
		IF NOT EXISTS (
			SELECT 1 FROM pg_policies
			WHERE tablename = 'agents' AND policyname = 'tenant_isolation_agents'
		) THEN
			CREATE POLICY tenant_isolation_agents ON agents
				USING (tenant_id::text = current_setting('app.tenant_id', true));
		END IF;
	END$$`,

	`ALTER TABLE runs ENABLE ROW LEVEL SECURITY`,

	`DO $$
	BEGIN
		IF NOT EXISTS (
			SELECT 1 FROM pg_policies
			WHERE tablename = 'runs' AND policyname = 'tenant_isolation_runs'
		) THEN
			CREATE POLICY tenant_isolation_runs ON runs
				USING (tenant_id::text = current_setting('app.tenant_id', true));
		END IF;
	END$$`,

	// ---------------------------------------------------------------
	// Add password_hash column to users (for local auth)
	// ---------------------------------------------------------------
	`DO $$
	BEGIN
		IF NOT EXISTS (
			SELECT 1 FROM information_schema.columns
			WHERE table_name = 'users' AND column_name = 'password_hash'
		) THEN
			ALTER TABLE users ADD COLUMN password_hash TEXT;
		END IF;
	END$$`,

	// ---------------------------------------------------------------
	// Add role column to users
	// ---------------------------------------------------------------
	`DO $$
	BEGIN
		IF NOT EXISTS (
			SELECT 1 FROM information_schema.columns
			WHERE table_name = 'users' AND column_name = 'role'
		) THEN
			ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member';
		END IF;
	END$$`,

	// ---------------------------------------------------------------
	// Seed default dev tenant and admin user
	// Password is "lantern" hashed with bcrypt.
	// ---------------------------------------------------------------
	`INSERT INTO tenants (id, slug, name, tier, k8s_namespace)
	 VALUES ('00000000-0000-0000-0000-000000000001', 'dev', 'Development', 'team', 'lantern-t-dev')
	 ON CONFLICT (id) DO NOTHING`,

	`INSERT INTO users (id, tenant_id, email, display_name, auth_provider, auth_subject, password_hash, role)
	 VALUES (
		'00000000-0000-0000-0000-000000000002',
		'00000000-0000-0000-0000-000000000001',
		'admin@lantern.dev',
		'Admin',
		'local',
		'admin@lantern.dev',
		'$2b$10$.hAunSjVIs5aiTYrzIAmfuLbpy1Im2N4xIvhjFVG5v3fak/eeyP7W',
		'owner'
	 )
	 ON CONFLICT DO NOTHING`,

	// ---------------------------------------------------------------
	// Connector installs
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS connector_installs (
		id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
		tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		connector_id TEXT NOT NULL,
		display_name TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'pending',
		config JSONB NOT NULL DEFAULT '{}'::jsonb,
		oauth_token_encrypted JSONB,
		scopes TEXT[],
		installed_by TEXT,
		installed_at TIMESTAMPTZ DEFAULT now(),
		updated_at TIMESTAMPTZ DEFAULT now(),
		UNIQUE(tenant_id, connector_id)
	)`,

	// ---------------------------------------------------------------
	// Surface configs
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS surface_configs (
		id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
		tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		surface_id TEXT NOT NULL,
		display_name TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'disconnected',
		config JSONB NOT NULL DEFAULT '{}'::jsonb,
		webhook_url TEXT,
		connected_at TIMESTAMPTZ,
		updated_at TIMESTAMPTZ DEFAULT now(),
		UNIQUE(tenant_id, surface_id)
	)`,

	// ---------------------------------------------------------------
	// API keys
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS api_keys (
		id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
		tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		name TEXT NOT NULL,
		key_hash TEXT NOT NULL,
		key_prefix TEXT NOT NULL,
		scopes TEXT[] NOT NULL DEFAULT '{}',
		expires_at TIMESTAMPTZ,
		last_used_at TIMESTAMPTZ,
		revoked_at TIMESTAMPTZ,
		created_by TEXT,
		created_at TIMESTAMPTZ DEFAULT now()
	)`,

	// ---------------------------------------------------------------
	// Deployments
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS deployments (
		id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
		tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		agent_name TEXT NOT NULL,
		version TEXT NOT NULL,
		environment TEXT NOT NULL DEFAULT 'development',
		status TEXT NOT NULL DEFAULT 'deploying',
		deployed_by TEXT,
		message TEXT,
		logs JSONB DEFAULT '[]'::jsonb,
		created_at TIMESTAMPTZ DEFAULT now(),
		finished_at TIMESTAMPTZ
	)`,

	// ---------------------------------------------------------------
	// Data planes
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS data_planes (
		id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
		tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		name TEXT NOT NULL,
		cloud TEXT NOT NULL,
		region TEXT NOT NULL,
		cluster_name TEXT,
		status TEXT NOT NULL DEFAULT 'provisioning',
		agent_count INTEGER DEFAULT 0,
		last_heartbeat TIMESTAMPTZ,
		config JSONB DEFAULT '{}'::jsonb,
		created_at TIMESTAMPTZ DEFAULT now()
	)`,

	// ---------------------------------------------------------------
	// LLM provider configs (stores API keys per tenant)
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS llm_provider_configs (
		id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
		tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		provider TEXT NOT NULL,
		api_key_encrypted TEXT NOT NULL,
		status TEXT DEFAULT 'active',
		created_at TIMESTAMPTZ DEFAULT now(),
		updated_at TIMESTAMPTZ DEFAULT now(),
		UNIQUE(tenant_id, provider)
	)`,
}
