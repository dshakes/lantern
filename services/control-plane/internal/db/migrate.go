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

	// ---------------------------------------------------------------
	// Schedules (cron-based agent execution)
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS schedules (
		id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
		tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		agent_name TEXT NOT NULL,
		cron_expr TEXT NOT NULL,
		input_template JSONB DEFAULT '{}'::jsonb,
		config JSONB DEFAULT '{}'::jsonb,
		enabled BOOLEAN NOT NULL DEFAULT true,
		next_fire_at TIMESTAMPTZ,
		last_fired_at TIMESTAMPTZ,
		created_at TIMESTAMPTZ DEFAULT now(),
		updated_at TIMESTAMPTZ DEFAULT now(),
		UNIQUE(tenant_id, agent_name)
	)`,

	`CREATE INDEX IF NOT EXISTS schedules_due_idx
		ON schedules (enabled, next_fire_at)
		WHERE enabled = true`,

	// ---------------------------------------------------------------
	// Sessions (interactive, long-lived agent sessions)
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS sessions (
		id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		agent_name TEXT NOT NULL,
		status     TEXT NOT NULL DEFAULT 'active',
		messages   JSONB NOT NULL DEFAULT '[]'::jsonb,
		created_at TIMESTAMPTZ DEFAULT now(),
		updated_at TIMESTAMPTZ DEFAULT now()
	)`,

	`CREATE INDEX IF NOT EXISTS sessions_tenant_agent_idx
		ON sessions (tenant_id, agent_name, updated_at DESC)`,

	// ---------------------------------------------------------------
	// Add workflow JSONB column to agents (visual editor persistence)
	// ---------------------------------------------------------------
	`DO $$
	BEGIN
		IF NOT EXISTS (
			SELECT 1 FROM information_schema.columns
			WHERE table_name = 'agents' AND column_name = 'workflow'
		) THEN
			ALTER TABLE agents ADD COLUMN workflow JSONB;
		END IF;
	END$$`,

	// ---------------------------------------------------------------
	// Add system_prompt TEXT column to agents for session/chat wiring.
	// ---------------------------------------------------------------
	`DO $$
	BEGIN
		IF NOT EXISTS (
			SELECT 1 FROM information_schema.columns
			WHERE table_name = 'agents' AND column_name = 'system_prompt'
		) THEN
			ALTER TABLE agents ADD COLUMN system_prompt TEXT;
		END IF;
	END$$`,

	// ---------------------------------------------------------------
	// Avatar + per-agent style prompt. Avatar is a URL (we may upload
	// to MinIO later and store the ref). style_prompt overrides the
	// bridge's baseline persona; it captures "my voice" rules.
	// ---------------------------------------------------------------
	`DO $$
	BEGIN
		IF NOT EXISTS (
			SELECT 1 FROM information_schema.columns
			WHERE table_name = 'agents' AND column_name = 'avatar_url'
		) THEN
			ALTER TABLE agents ADD COLUMN avatar_url TEXT;
		END IF;
		IF NOT EXISTS (
			SELECT 1 FROM information_schema.columns
			WHERE table_name = 'agents' AND column_name = 'style_prompt'
		) THEN
			ALTER TABLE agents ADD COLUMN style_prompt TEXT;
		END IF;
	END$$`,

	// ---------------------------------------------------------------
	// Agent budgets — policy-as-code per-tool rate + cost limits.
	// Enforced at step-executor before any LLM call or tool dispatch.
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS agent_budgets (
		id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		tenant_id                UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		agent_name               TEXT NOT NULL,
		max_cost_usd_per_day     NUMERIC(12,4),
		max_cost_usd_per_run     NUMERIC(12,4),
		max_tokens_per_day       BIGINT,
		max_runs_per_day         INTEGER,
		tool_limits              JSONB NOT NULL DEFAULT '{}'::jsonb,
		hard_fail                BOOLEAN NOT NULL DEFAULT true,
		notify_at_pct            INTEGER NOT NULL DEFAULT 80 CHECK (notify_at_pct BETWEEN 1 AND 100),
		created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
		updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
		UNIQUE (tenant_id, agent_name)
	)`,

	`CREATE INDEX IF NOT EXISTS agent_budgets_tenant_idx
		ON agent_budgets (tenant_id, agent_name)`,

	// ---------------------------------------------------------------
	// Cost forecasts — pre-run predictions, kept for calibration.
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS cost_forecasts (
		id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		agent_name          TEXT NOT NULL,
		run_id              UUID,
		estimated_tokens_in BIGINT NOT NULL,
		estimated_tokens_out BIGINT NOT NULL,
		estimated_cost_usd  NUMERIC(12,4) NOT NULL,
		actual_cost_usd     NUMERIC(12,4),
		confidence          NUMERIC(4,2) NOT NULL,
		reasoning           JSONB NOT NULL DEFAULT '{}'::jsonb,
		blocked_by_budget   BOOLEAN NOT NULL DEFAULT false,
		created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE INDEX IF NOT EXISTS cost_forecasts_agent_idx
		ON cost_forecasts (tenant_id, agent_name, created_at DESC)`,

	// ---------------------------------------------------------------
	// Marketplace — publicly published agents available for forking.
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS marketplace_agents (
		id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		slug                 TEXT NOT NULL UNIQUE,
		source_tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		source_agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
		name                 TEXT NOT NULL,
		description          TEXT NOT NULL,
		category             TEXT NOT NULL DEFAULT 'general',
		tags                 TEXT[] NOT NULL DEFAULT '{}',
		manifest             JSONB NOT NULL,
		card                 JSONB NOT NULL,
		readme               TEXT,
		forks_count          INTEGER NOT NULL DEFAULT 0,
		stars_count          INTEGER NOT NULL DEFAULT 0,
		published_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
		unpublished_at       TIMESTAMPTZ
	)`,

	`CREATE INDEX IF NOT EXISTS marketplace_agents_category_idx
		ON marketplace_agents (category) WHERE unpublished_at IS NULL`,

	`CREATE TABLE IF NOT EXISTS marketplace_stars (
		tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		marketplace_id  UUID NOT NULL REFERENCES marketplace_agents(id) ON DELETE CASCADE,
		starred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
		PRIMARY KEY (tenant_id, marketplace_id)
	)`,

	// ---------------------------------------------------------------
	// MCP server registry — browsable catalog of MCP servers.
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS mcp_servers (
		id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		slug         TEXT NOT NULL UNIQUE,
		name         TEXT NOT NULL,
		description  TEXT NOT NULL,
		category     TEXT NOT NULL DEFAULT 'general',
		transport    TEXT NOT NULL DEFAULT 'stdio',
		url          TEXT,
		command      TEXT,
		auth_type    TEXT NOT NULL DEFAULT 'none',
		manifest     JSONB NOT NULL DEFAULT '{}'::jsonb,
		tags         TEXT[] NOT NULL DEFAULT '{}',
		official     BOOLEAN NOT NULL DEFAULT false,
		installs_count INTEGER NOT NULL DEFAULT 0,
		created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE TABLE IF NOT EXISTS agent_mcp_attachments (
		tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		agent_name     TEXT NOT NULL,
		mcp_server_id  UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
		config         JSONB NOT NULL DEFAULT '{}'::jsonb,
		attached_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
		PRIMARY KEY (tenant_id, agent_name, mcp_server_id)
	)`,

	// Seed the MCP registry with curated first-party entries.
	`INSERT INTO mcp_servers (slug, name, description, category, transport, command, auth_type, official, tags) VALUES
		('filesystem', 'Filesystem', 'Read and write files with scoped paths. First-party.', 'core', 'stdio', 'npx -y @modelcontextprotocol/server-filesystem', 'none', true, ARRAY['files','io']),
		('github', 'GitHub', 'Query issues, PRs, code, and create comments.', 'devtools', 'stdio', 'npx -y @modelcontextprotocol/server-github', 'bearer', true, ARRAY['git','code','reviews']),
		('postgres', 'Postgres', 'Read-only Postgres queries over schema and tables.', 'data', 'stdio', 'npx -y @modelcontextprotocol/server-postgres', 'connection-string', true, ARRAY['sql','database']),
		('slack', 'Slack', 'Search channels, post messages, read threads.', 'communication', 'stdio', 'npx -y @modelcontextprotocol/server-slack', 'bearer', true, ARRAY['chat','team']),
		('brave-search', 'Brave Search', 'Web search over Brave''s API.', 'research', 'stdio', 'npx -y @modelcontextprotocol/server-brave-search', 'api-key', true, ARRAY['web','search']),
		('puppeteer', 'Puppeteer', 'Headless Chrome browsing, screenshots, scraping.', 'automation', 'stdio', 'npx -y @modelcontextprotocol/server-puppeteer', 'none', true, ARRAY['browser','web']),
		('memory', 'Memory', 'Persistent knowledge graph across agent runs.', 'core', 'stdio', 'npx -y @modelcontextprotocol/server-memory', 'none', true, ARRAY['memory','kv']),
		('sqlite', 'SQLite', 'Embedded SQLite database access.', 'data', 'stdio', 'npx -y @modelcontextprotocol/server-sqlite', 'none', true, ARRAY['sql','embedded'])
	ON CONFLICT (slug) DO NOTHING`,

	// ---------------------------------------------------------------
	// Eval suites + runs + baselines (eval-in-CI).
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS eval_suites (
		id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		agent_name   TEXT NOT NULL,
		name         TEXT NOT NULL,
		description  TEXT,
		cases        JSONB NOT NULL,
		created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
		updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
		UNIQUE (tenant_id, agent_name, name)
	)`,

	`CREATE TABLE IF NOT EXISTS eval_runs (
		id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		suite_id         UUID NOT NULL REFERENCES eval_suites(id) ON DELETE CASCADE,
		agent_name       TEXT NOT NULL,
		agent_version    TEXT,
		commit_sha       TEXT,
		branch           TEXT,
		passed           BOOLEAN NOT NULL,
		score            NUMERIC(5,4) NOT NULL,
		cases_total      INTEGER NOT NULL,
		cases_passed     INTEGER NOT NULL,
		cases_result     JSONB NOT NULL DEFAULT '[]'::jsonb,
		duration_ms      BIGINT NOT NULL DEFAULT 0,
		total_cost_usd   NUMERIC(12,4) NOT NULL DEFAULT 0,
		created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE INDEX IF NOT EXISTS eval_runs_suite_idx
		ON eval_runs (suite_id, created_at DESC)`,

	`CREATE INDEX IF NOT EXISTS eval_runs_branch_idx
		ON eval_runs (tenant_id, agent_name, branch, created_at DESC)`,

	`CREATE TABLE IF NOT EXISTS eval_baselines (
		tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		agent_name    TEXT NOT NULL,
		branch        TEXT NOT NULL,
		eval_run_id   UUID NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
		set_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
		set_by        TEXT,
		PRIMARY KEY (tenant_id, agent_name, branch)
	)`,

	// ---------------------------------------------------------------
	// A/B experiments — traffic splitting with auto-promotion.
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS agent_experiments (
		id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		agent_name            TEXT NOT NULL,
		name                  TEXT NOT NULL,
		variant_a_version     TEXT NOT NULL,
		variant_b_version     TEXT NOT NULL,
		traffic_split_b       INTEGER NOT NULL CHECK (traffic_split_b BETWEEN 0 AND 100),
		eval_suite_id         UUID REFERENCES eval_suites(id) ON DELETE SET NULL,
		auto_promote          BOOLEAN NOT NULL DEFAULT false,
		min_runs_to_promote   INTEGER NOT NULL DEFAULT 100,
		status                TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','paused','concluded')),
		winner                TEXT CHECK (winner IS NULL OR winner IN ('a','b','tie')),
		a_runs                INTEGER NOT NULL DEFAULT 0,
		b_runs                INTEGER NOT NULL DEFAULT 0,
		a_score               NUMERIC(5,4),
		b_score               NUMERIC(5,4),
		started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
		concluded_at          TIMESTAMPTZ,
		UNIQUE (tenant_id, agent_name, name)
	)`,

	`CREATE INDEX IF NOT EXISTS agent_experiments_active_idx
		ON agent_experiments (tenant_id, agent_name)
		WHERE status = 'running'`,

	// ---------------------------------------------------------------
	// Daily usage rollups — fast budget enforcement.
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS agent_usage_daily (
		tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		agent_name    TEXT NOT NULL,
		usage_date    DATE NOT NULL,
		runs_count    INTEGER NOT NULL DEFAULT 0,
		tokens_in     BIGINT NOT NULL DEFAULT 0,
		tokens_out    BIGINT NOT NULL DEFAULT 0,
		cost_usd      NUMERIC(12,4) NOT NULL DEFAULT 0,
		tool_counts   JSONB NOT NULL DEFAULT '{}'::jsonb,
		PRIMARY KEY (tenant_id, agent_name, usage_date)
	)`,

	// ---------------------------------------------------------------
	// Verifiable execution receipts (HMAC-signed run summaries).
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS run_receipts (
		tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		run_id      UUID NOT NULL PRIMARY KEY,
		signature   TEXT NOT NULL,
		payload     JSONB NOT NULL,
		issued_at   TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE INDEX IF NOT EXISTS run_receipts_tenant_idx
		ON run_receipts (tenant_id, issued_at DESC)`,

	// ---------------------------------------------------------------
	// Run feedback (RLHF: per-run human reactions + preferred outputs).
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS run_feedback (
		id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		run_id            UUID NOT NULL,
		agent_name        TEXT,
		score             INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
		comment           TEXT,
		preferred_output  TEXT,
		source            TEXT NOT NULL DEFAULT 'dashboard',
		created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE INDEX IF NOT EXISTS run_feedback_run_idx
		ON run_feedback (run_id, created_at DESC)`,

	`CREATE INDEX IF NOT EXISTS run_feedback_agent_idx
		ON run_feedback (tenant_id, agent_name, created_at DESC)`,

	// ---------------------------------------------------------------
	// Marketplace invocations — W11c. Records every cross-tenant agent
	// invocation that goes through the marketplace. Each row captures
	// the buyer + seller tenants, the invocation payload, the seller's
	// signed receipt (HMAC) for verifiable settlement, and the price
	// agreed against the buyer's budget. The table is append-only —
	// invocations are the unit of cross-tenant trust.
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS marketplace_invocations (
		id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		buyer_tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		seller_tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		marketplace_slug TEXT NOT NULL,
		agent_name      TEXT NOT NULL,
		input           JSONB NOT NULL DEFAULT '{}'::jsonb,
		output          JSONB,
		status          TEXT NOT NULL DEFAULT 'pending',
		cost_usd        DOUBLE PRECISION NOT NULL DEFAULT 0,
		signature       TEXT,
		receipt         JSONB,
		error_message   TEXT,
		created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
		completed_at    TIMESTAMPTZ
	)`,

	`CREATE INDEX IF NOT EXISTS marketplace_invocations_buyer_idx
		ON marketplace_invocations (buyer_tenant_id, created_at DESC)`,

	`CREATE INDEX IF NOT EXISTS marketplace_invocations_seller_idx
		ON marketplace_invocations (seller_tenant_id, created_at DESC)`,

	// ---------------------------------------------------------------
	// Takeover requests — W11a. A workflow's approval / human_takeover
	// step pauses the run until a human acknowledges; this table is the
	// rendezvous point. Status transitions:
	//   pending → granted → released  (normal happy path)
	//   pending → denied              (request rejected)
	//   pending → expired             (no human acted within deadline)
	//
	// sdp_offer + sdp_answer hold the WebRTC SDP exchange when a live
	// VM stream is available (runtime-manager + Firecracker). Without a
	// real microVM these stay NULL and the takeover is "approval-only".
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS takeover_requests (
		id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		run_id          UUID NOT NULL,
		tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		step_id         TEXT,
		reason          TEXT,
		status          TEXT NOT NULL DEFAULT 'pending',
		sdp_offer       TEXT,
		sdp_answer      TEXT,
		ice_candidates  JSONB DEFAULT '[]'::jsonb,
		notes           TEXT,
		expires_at      TIMESTAMPTZ,
		created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
		granted_at      TIMESTAMPTZ,
		released_at     TIMESTAMPTZ
	)`,

	`CREATE INDEX IF NOT EXISTS takeover_requests_run_idx
		ON takeover_requests (run_id, created_at DESC)`,

	`CREATE INDEX IF NOT EXISTS takeover_requests_tenant_open_idx
		ON takeover_requests (tenant_id, status)
		WHERE status = 'pending' OR status = 'granted'`,

	// ---------------------------------------------------------------
	// Voice channel — W11d. Phone numbers a tenant has linked (either
	// purchased through a provider or BYO via SIP trunk import) that
	// route inbound calls to a Lantern agent. The provider column
	// selects which adapter handles transport (twilio | livekit |
	// vapi). Per-call state lives in voice_calls below.
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS voice_numbers (
		id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		agent_name      TEXT NOT NULL,
		provider        TEXT NOT NULL,            -- twilio | livekit | vapi | sip
		phone_number    TEXT NOT NULL,            -- E.164 (+15551234567)
		display_name    TEXT,
		provider_config JSONB NOT NULL DEFAULT '{}'::jsonb,  -- per-provider keys/SIDs/URLs
		voice_id        TEXT,                     -- TTS voice handle (provider-specific)
		greeting        TEXT,                     -- spoken on pickup
		status          TEXT NOT NULL DEFAULT 'inactive',  -- inactive | active | error
		last_error      TEXT,
		created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
		updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
		UNIQUE (tenant_id, phone_number)
	)`,

	`CREATE INDEX IF NOT EXISTS voice_numbers_tenant_idx
		ON voice_numbers (tenant_id)`,

	`CREATE TABLE IF NOT EXISTS voice_calls (
		id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		voice_number_id UUID NOT NULL REFERENCES voice_numbers(id) ON DELETE CASCADE,
		agent_name      TEXT NOT NULL,
		direction       TEXT NOT NULL DEFAULT 'inbound',
		from_number     TEXT,
		to_number       TEXT,
		provider_call_id TEXT,
		session_id      TEXT,        -- maps to sessions.id if a session was created
		status          TEXT NOT NULL DEFAULT 'ringing',  -- ringing | active | completed | failed
		duration_ms     BIGINT,
		transcript      JSONB DEFAULT '[]'::jsonb,
		cost_usd        DOUBLE PRECISION NOT NULL DEFAULT 0,
		started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
		ended_at        TIMESTAMPTZ
	)`,

	`CREATE INDEX IF NOT EXISTS voice_calls_tenant_started_idx
		ON voice_calls (tenant_id, started_at DESC)`,

	// ---------------------------------------------------------------
	// Surface heartbeat columns (additive — back-compat with existing DBs).
	// The WhatsApp bridge pushes its current pairing state here every 30s
	// so the control-plane (not just the bridge box) can answer
	// "is tenant X paired right now" — which is what the dashboard needs
	// when bridge and dashboard run on different hosts (prod).
	// ---------------------------------------------------------------
	`ALTER TABLE surface_configs ADD COLUMN IF NOT EXISTS phone_number TEXT`,
	`ALTER TABLE surface_configs ADD COLUMN IF NOT EXISTS display_handle TEXT`,
	`ALTER TABLE surface_configs ADD COLUMN IF NOT EXISTS bridge_state TEXT`,
	`ALTER TABLE surface_configs ADD COLUMN IF NOT EXISTS bridge_version TEXT`,
	`ALTER TABLE surface_configs ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ`,
	`ALTER TABLE surface_configs ADD COLUMN IF NOT EXISTS last_connection_event_at TIMESTAMPTZ`,
	`ALTER TABLE surface_configs ADD COLUMN IF NOT EXISTS last_error TEXT`,

	// ---------------------------------------------------------------
	// Contact memory + VIP contacts + pending drafts. These power the
	// "futuristic" upgrades for the personal-assistant flows on WhatsApp
	// and iMessage:
	//   - whatsapp_contact_facts: durable facts the assistant has
	//     learned (or the user has manually added) about each contact —
	//     "her daughter is Maya", "works at Stripe", etc. Injected into
	//     the persona prompt so cold-start awkwardness disappears.
	//   - whatsapp_vip_contacts: contacts where auto-send is OFF; the
	//     assistant drafts but posts to the dashboard for one-tap
	//     approval. Stops the most-feared scenario: bot sends something
	//     awkward to your boss.
	//   - whatsapp_pending_drafts: append-only log of VIP drafts +
	//     their status (pending → approved/discarded). Survives bridge
	//     restarts.
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS whatsapp_contact_facts (
		id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		jid             TEXT NOT NULL,
		content         TEXT NOT NULL,
		source          TEXT NOT NULL DEFAULT 'manual',  -- manual | inferred
		created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
		updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE INDEX IF NOT EXISTS whatsapp_contact_facts_tenant_jid_idx
		ON whatsapp_contact_facts (tenant_id, jid, updated_at DESC)`,

	`CREATE TABLE IF NOT EXISTS whatsapp_vip_contacts (
		tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		jid             TEXT NOT NULL,
		display_name    TEXT,
		added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
		PRIMARY KEY (tenant_id, jid)
	)`,

	`CREATE TABLE IF NOT EXISTS whatsapp_pending_drafts (
		id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		jid             TEXT NOT NULL,
		display_name    TEXT,
		inbound_text    TEXT NOT NULL,
		draft_text      TEXT NOT NULL,
		status          TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | edited | discarded
		final_text      TEXT,
		created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
		acted_at        TIMESTAMPTZ
	)`,

	`CREATE INDEX IF NOT EXISTS whatsapp_pending_drafts_tenant_status_idx
		ON whatsapp_pending_drafts (tenant_id, status, created_at DESC)`,

	// VIPs + drafts are GLOBAL across messaging channels (one VIP list
	// applies to both WhatsApp and iMessage). The draft row records
	// which channel queued it so the dashboard can show the right
	// badge and the approval endpoint sends back via the right bridge.
	`ALTER TABLE whatsapp_pending_drafts ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp'`,

	// ---------------------------------------------------------------
	// Headless-agent runtime governance.
	//
	// Three tables form the contract surface between the control-plane
	// and the (Firecracker-backed) runtime scheduler at :50055:
	//
	//   * runtime_quotas       — per-tenant ceilings (concurrent VMs,
	//                            compute hours/day, egress GB/day,
	//                            cost USD/day). Enforced by
	//                            checkRuntimeQuota before /schedule.
	//   * runtime_vms          — canonical record of every VM the
	//                            scheduler has accepted. The
	//                            dashboard reads list/detail from
	//                            here; the scheduler reconciles state
	//                            against this table.
	//   * runtime_audit_events — append-only audit log. Every
	//                            schedule/terminate/exec/quota-deny
	//                            writes a row keyed by tenant_id so
	//                            cross-VM forensics is one query.
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS runtime_quotas (
		tenant_id                   UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
		max_concurrent_vms          INTEGER NOT NULL DEFAULT 20,
		max_compute_hours_per_day   NUMERIC(10,2) NOT NULL DEFAULT 10.0,
		max_egress_gb_per_day       INTEGER NOT NULL DEFAULT 5,
		max_cost_usd_per_day        NUMERIC(12,4) NOT NULL DEFAULT 5.0,
		hard_fail                   BOOLEAN NOT NULL DEFAULT true,
		updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE TABLE IF NOT EXISTS runtime_audit_events (
		id            BIGSERIAL PRIMARY KEY,
		tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		vm_id         TEXT,
		action        TEXT NOT NULL,
		attrs         JSONB NOT NULL DEFAULT '{}'::jsonb,
		principal_id  UUID,
		at            TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE INDEX IF NOT EXISTS runtime_audit_events_tenant_at_idx
		ON runtime_audit_events (tenant_id, at DESC)`,

	`CREATE INDEX IF NOT EXISTS runtime_audit_events_vm_idx
		ON runtime_audit_events (vm_id, at DESC)`,

	`CREATE TABLE IF NOT EXISTS runtime_vms (
		vm_id              TEXT PRIMARY KEY,
		tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		agent_version_id   UUID,
		run_id             UUID,
		node               TEXT,
		az                 TEXT,
		region             TEXT,
		isolation_class    TEXT,
		state              TEXT NOT NULL DEFAULT 'pending',
		spec               JSONB NOT NULL DEFAULT '{}'::jsonb,
		last_heartbeat_at  TIMESTAMPTZ,
		created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
		terminated_at      TIMESTAMPTZ
	)`,

	`CREATE INDEX IF NOT EXISTS runtime_vms_tenant_state_idx
		ON runtime_vms (tenant_id, state)`,

	`CREATE INDEX IF NOT EXISTS runtime_vms_tenant_created_idx
		ON runtime_vms (tenant_id, created_at DESC)`,

	// ---------------------------------------------------------------
	// Identity graph + unified cross-channel timeline (Jarvis memory).
	//
	// The keystone for "context memory across channels". Today facts +
	// episodes are keyed by a single channel handle (a WhatsApp JID),
	// so something learned on WhatsApp is invisible on iMessage/SMS/
	// email. These tables introduce a canonical PERSON that unifies all
	// of a contact's handles, and a single timeline keyed by that
	// person — so one conversation that spans WhatsApp + email + a call
	// is one history.
	//
	//   * people          — canonical contact (+ the owner as is_owner).
	//   * person_handles  — every channel handle that maps to a person
	//                       (phone/whatsapp/imessage/sms/voice/email).
	//                       Phone-like channels unify by digits.
	//   * memory_events   — the unified timeline. Recency + keyword
	//                       retrieval today; a vector embedding column is
	//                       added in a later migration when semantic
	//                       recall is wired (kept out here so startup
	//                       never depends on the vector extension).
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS people (
		id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		display_name TEXT,
		relationship TEXT,
		is_owner     BOOLEAN NOT NULL DEFAULT false,
		notes        TEXT,
		created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
		updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE INDEX IF NOT EXISTS people_tenant_idx ON people (tenant_id)`,

	`CREATE TABLE IF NOT EXISTS person_handles (
		id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		person_id   UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
		channel     TEXT NOT NULL,
		handle      TEXT NOT NULL,
		created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
		UNIQUE (tenant_id, channel, handle)
	)`,

	`CREATE INDEX IF NOT EXISTS person_handles_person_idx ON person_handles (person_id)`,

	// Fast cross-channel phone unification: match any phone-like handle
	// by its normalized digits regardless of which channel stored it.
	`CREATE INDEX IF NOT EXISTS person_handles_tenant_handle_idx
		ON person_handles (tenant_id, handle)`,

	`CREATE TABLE IF NOT EXISTS memory_events (
		id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
		person_id   UUID REFERENCES people(id) ON DELETE CASCADE,
		channel     TEXT NOT NULL,
		kind        TEXT NOT NULL,
		direction   TEXT,
		content     TEXT NOT NULL,
		occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
		metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
		created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE INDEX IF NOT EXISTS memory_events_person_time_idx
		ON memory_events (tenant_id, person_id, occurred_at DESC)`,

	`CREATE INDEX IF NOT EXISTS memory_events_tenant_time_idx
		ON memory_events (tenant_id, occurred_at DESC)`,

	// Link existing facts to the identity graph. Nullable + backfilled
	// as handles resolve; jid stays for backward-compat.
	`ALTER TABLE whatsapp_contact_facts ADD COLUMN IF NOT EXISTS person_id UUID REFERENCES people(id) ON DELETE SET NULL`,

	`CREATE INDEX IF NOT EXISTS whatsapp_contact_facts_person_idx
		ON whatsapp_contact_facts (tenant_id, person_id, updated_at DESC)`,

	// ---------------------------------------------------------------
	// Semantic recall + external ingestion (Phase 2c).
	//
	// pgvector embeddings on the unified timeline turn "what did Madhu
	// and I discuss about jobs" into a similarity search instead of a
	// keyword match. The embedding column is nullable: rows are written
	// immediately and embedded asynchronously, so ingestion never blocks
	// on the embedding provider, and recency/keyword retrieval works for
	// rows that haven't been embedded yet.
	//
	// external_id dedups events pulled from external sources (Gmail
	// message id, Calendar event id) so the periodic ingestor is
	// idempotent — re-pulling the same message is a no-op.
	//
	// Dimension 1536 = OpenAI text-embedding-3-small (cheap, good). If a
	// different embed model is configured its vectors must match this
	// width or the insert is skipped (logged), never crashing ingest.
	// ---------------------------------------------------------------
	`CREATE EXTENSION IF NOT EXISTS vector`,

	`ALTER TABLE memory_events ADD COLUMN IF NOT EXISTS embedding vector(1536)`,

	`ALTER TABLE memory_events ADD COLUMN IF NOT EXISTS external_id TEXT`,

	`CREATE UNIQUE INDEX IF NOT EXISTS memory_events_external_idx
		ON memory_events (tenant_id, kind, external_id)
		WHERE external_id IS NOT NULL`,

	`CREATE INDEX IF NOT EXISTS memory_events_embedding_idx
		ON memory_events USING hnsw (embedding vector_cosine_ops)`,
}
