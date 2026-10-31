-- Post-deployment observability (ADR 0056): per-agent SLOs, sampled production
-- evals, anomaly/SLO incidents and their append-only audit trail. All four
-- tables are tenant-scoped with RLS (invariant #7).

CREATE TABLE IF NOT EXISTS agent_slos (
	tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	agent_name       TEXT NOT NULL,
	objective        NUMERIC(5,4) NOT NULL DEFAULT 0.95 CHECK (objective > 0 AND objective < 1),
	latency_ms       BIGINT,
	cost_usd         NUMERIC(12,6),
	min_score        NUMERIC(4,3) CHECK (min_score IS NULL OR (min_score >= 0 AND min_score <= 1)),
	window_days      INT NOT NULL DEFAULT 28 CHECK (window_days BETWEEN 1 AND 90),
	updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (tenant_id, agent_name)
);

CREATE TABLE IF NOT EXISTS prod_eval_config (
	tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	agent_name        TEXT NOT NULL,
	enabled           BOOLEAN NOT NULL DEFAULT false,
	sample_rate       NUMERIC(5,4) NOT NULL DEFAULT 0.05 CHECK (sample_rate >= 0 AND sample_rate <= 1),
	rubric            TEXT NOT NULL DEFAULT '',
	judge_model       TEXT NOT NULL DEFAULT '',
	daily_budget_usd  NUMERIC(12,6) NOT NULL DEFAULT 1.0 CHECK (daily_budget_usd >= 0),
	updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (tenant_id, agent_name)
);

CREATE TABLE IF NOT EXISTS prod_eval_scores (
	tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	run_id           UUID NOT NULL,
	agent_name       TEXT NOT NULL,
	agent_version    TEXT NOT NULL DEFAULT '',
	score            NUMERIC(5,4) NOT NULL,
	passed           BOOLEAN NOT NULL,
	rationale        TEXT NOT NULL DEFAULT '',
	judge_model      TEXT NOT NULL DEFAULT '',
	cost_usd         NUMERIC(12,6) NOT NULL DEFAULT 0,
	created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (tenant_id, run_id)
);
CREATE INDEX IF NOT EXISTS prod_eval_scores_agent_idx
	ON prod_eval_scores (tenant_id, agent_name, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_incidents (
	id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	agent_name         TEXT NOT NULL,
	-- 'anomaly:<metric>' or 'slo:<sli>'
	kind               TEXT NOT NULL,
	severity           TEXT NOT NULL DEFAULT 'ticket' CHECK (severity IN ('page','ticket')),
	status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
	title              TEXT NOT NULL,
	summary            TEXT NOT NULL DEFAULT '',
	summary_source     TEXT NOT NULL DEFAULT 'deterministic' CHECK (summary_source IN ('deterministic','model')),
	first_bad_version  TEXT NOT NULL DEFAULT '',
	last_good_version  TEXT NOT NULL DEFAULT '',
	suspected_cause    TEXT NOT NULL DEFAULT '',
	affected_run_ids   JSONB NOT NULL DEFAULT '[]'::jsonb,
	evidence           JSONB NOT NULL DEFAULT '{}'::jsonb,
	rollback_suggested BOOLEAN NOT NULL DEFAULT false,
	opened_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
	acknowledged_at    TIMESTAMPTZ,
	acknowledged_by    TEXT,
	resolved_at        TIMESTAMPTZ,
	resolved_by        TEXT
);
-- One live incident per (agent, kind): repeated detections never stack.
CREATE UNIQUE INDEX IF NOT EXISTS agent_incidents_live_uq
	ON agent_incidents (tenant_id, agent_name, kind) WHERE status <> 'resolved';
CREATE INDEX IF NOT EXISTS agent_incidents_list_idx
	ON agent_incidents (tenant_id, status, opened_at DESC);

-- Append-only audit trail + timeline.
CREATE TABLE IF NOT EXISTS agent_incident_events (
	id           BIGSERIAL PRIMARY KEY,
	tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	incident_id  UUID NOT NULL REFERENCES agent_incidents(id) ON DELETE CASCADE,
	at           TIMESTAMPTZ NOT NULL DEFAULT now(),
	actor        TEXT NOT NULL,
	action       TEXT NOT NULL,
	detail       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS agent_incident_events_idx ON agent_incident_events (incident_id, id);

DO $$
DECLARE t TEXT;
BEGIN
	FOREACH t IN ARRAY ARRAY['agent_slos','prod_eval_config','prod_eval_scores','agent_incidents','agent_incident_events']
	LOOP
		EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
		EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
		EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
		EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
			USING (tenant_id::text = current_setting('app.tenant_id', true))
			WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true))$p$, t);
	END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON agent_slos, prod_eval_config TO pal_app;
GRANT SELECT, INSERT, UPDATE ON prod_eval_scores, agent_incidents TO pal_app;
GRANT SELECT, INSERT ON agent_incident_events TO pal_app;
GRANT USAGE, SELECT ON SEQUENCE agent_incident_events_id_seq TO pal_app;
