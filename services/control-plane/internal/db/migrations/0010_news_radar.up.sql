-- 0010_news_radar.up.sql
--
-- Backing store for the news_radar loop agent: a tenant-scoped feed of AI
-- news items gathered from RSS/Atom feeds, GitHub releases, HN, Reddit, and
-- podcasts. URL-level dedup via UNIQUE(tenant_id, url).
--
-- RLS posture mirrors 0007 exactly: ENABLE + FORCE + tenant_isolation policy
-- with USING and WITH CHECK, plus GRANT to lantern_app.

CREATE TABLE IF NOT EXISTS news_items (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid        NOT NULL,
    source       text        NOT NULL,  -- e.g. "Anthropic Blog", "HackerNews", "GitHub:anthropics/claude-code"
    category     text        NOT NULL,  -- labs|people|coding-tools|aggregators
    title        text        NOT NULL,
    url          text        NOT NULL,
    summary      text,                  -- LLM-generated "why it matters" or original snippet
    author       text,
    score        int         NOT NULL DEFAULT 0,  -- HN points / GitHub stars / LLM importance rank
    published_at timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- Dedup guard: same URL never inserted twice per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS news_items_tenant_url
    ON news_items (tenant_id, url);

-- Feed query index: newest first per tenant, optionally filtered by category.
CREATE INDEX IF NOT EXISTS news_items_tenant_created
    ON news_items (tenant_id, created_at DESC);

-- Grant DML to the non-superuser app role (same as 0005–0007).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE news_items TO lantern_app;

DO $$
BEGIN
    EXECUTE 'ALTER TABLE news_items ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE news_items FORCE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON news_items';
    EXECUTE
        'CREATE POLICY tenant_isolation ON news_items '
        || 'USING (tenant_id::text = current_setting(''app.tenant_id'', true)) '
        || 'WITH CHECK (tenant_id::text = current_setting(''app.tenant_id'', true))';
END$$;
