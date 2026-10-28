ALTER TABLE sessions DROP COLUMN IF EXISTS handoff_at;
ALTER TABLE sessions DROP COLUMN IF EXISTS handoff_reason;
DROP TABLE IF EXISTS agent_document_chunks;
DROP TABLE IF EXISTS agent_documents;
