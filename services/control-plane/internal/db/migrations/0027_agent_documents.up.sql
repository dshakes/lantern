-- 0027: per-agent knowledge base (W2-X1 support desk).
--
-- agent_documents: one uploaded doc. The primary key is (tenant_id, agent_name,
-- id) so a caller-supplied id (seeded/idempotent uploads) is unique per agent and
-- can never collide with, or reveal, another tenant's (or agent's) document.
-- agent_document_chunks: ~800-char chunks with a pgvector embedding (1536 =
-- text-embedding-3-small, same width as memory_events). embedding is NULL when
-- the tenant has no OpenAI key; retrieval then falls back to full-text.
--
-- sessions.handoff_*: human-handoff bookkeeping (sessions.status = 'handoff').
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS agent_documents (
	tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	id          UUID NOT NULL DEFAULT gen_random_uuid(),
	agent_name  TEXT NOT NULL,
	title       TEXT NOT NULL,
	source      TEXT,
	byte_size   INTEGER NOT NULL,
	chunk_count INTEGER NOT NULL DEFAULT 0,
	created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (tenant_id, agent_name, id)
);

CREATE INDEX IF NOT EXISTS agent_documents_agent_idx
	ON agent_documents (tenant_id, agent_name, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_document_chunks (
	tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	document_id UUID NOT NULL,
	agent_name  TEXT NOT NULL,
	ord         INTEGER NOT NULL,
	content     TEXT NOT NULL,
	embedding   vector(1536),
	PRIMARY KEY (tenant_id, agent_name, document_id, ord),
	FOREIGN KEY (tenant_id, agent_name, document_id) REFERENCES agent_documents(tenant_id, agent_name, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS agent_document_chunks_agent_idx
	ON agent_document_chunks (tenant_id, agent_name);
CREATE INDEX IF NOT EXISTS agent_document_chunks_embedding_idx
	ON agent_document_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS agent_document_chunks_fts_idx
	ON agent_document_chunks USING gin (to_tsvector('simple', content));

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS handoff_reason TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS handoff_at TIMESTAMPTZ;

-- Tenant isolation (invariant #7), same shape as 0003/0024.
ALTER TABLE agent_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent_documents;
CREATE POLICY tenant_isolation ON agent_documents
	USING (tenant_id::text = current_setting('app.tenant_id', true))
	WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

ALTER TABLE agent_document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_document_chunks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent_document_chunks;
CREATE POLICY tenant_isolation ON agent_document_chunks
	USING (tenant_id::text = current_setting('app.tenant_id', true))
	WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON agent_documents TO lantern_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_document_chunks TO lantern_app;
