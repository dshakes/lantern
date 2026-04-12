package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Migrate runs the core CREATE TABLE statements needed by the memory service.
// All statements are idempotent.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	for i, stmt := range migrations {
		if _, err := pool.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("migration %d failed: %w", i, err)
		}
	}
	return nil
}

var migrations = []string{
	// Enable pgvector extension.
	`CREATE EXTENSION IF NOT EXISTS vector`,

	// ---------------------------------------------------------------
	// Core memory — key-value store
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS memory_core (
		id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		tenant_id  UUID NOT NULL,
		scope      TEXT NOT NULL,
		scope_id   TEXT NOT NULL,
		key        TEXT NOT NULL,
		value      JSONB NOT NULL,
		updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
		UNIQUE (tenant_id, scope, scope_id, key)
	)`,

	`CREATE INDEX IF NOT EXISTS memory_core_tenant_scope_idx
		ON memory_core (tenant_id, scope, scope_id)`,

	// ---------------------------------------------------------------
	// Recall memory — recent history with vector search
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS memory_recall (
		id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		tenant_id  UUID NOT NULL,
		scope      TEXT NOT NULL,
		scope_id   TEXT NOT NULL,
		text       TEXT NOT NULL,
		embedding  vector(1536),
		metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
		created_at TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE INDEX IF NOT EXISTS memory_recall_tenant_scope_idx
		ON memory_recall (tenant_id, scope, scope_id)`,

	// HNSW index for fast approximate nearest-neighbor search on recall embeddings.
	`DO $$
	BEGIN
		IF NOT EXISTS (
			SELECT 1 FROM pg_indexes WHERE indexname = 'memory_recall_embedding_hnsw_idx'
		) THEN
			CREATE INDEX memory_recall_embedding_hnsw_idx
				ON memory_recall USING hnsw (embedding vector_cosine_ops)
				WITH (m = 16, ef_construction = 64);
		END IF;
	END$$`,

	// ---------------------------------------------------------------
	// Archival memory — long-term knowledge with vector search
	// ---------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS memory_archival (
		id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		tenant_id  UUID NOT NULL,
		scope      TEXT NOT NULL,
		scope_id   TEXT NOT NULL,
		text       TEXT NOT NULL,
		embedding  vector(1536),
		metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
		created_at TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,

	`CREATE INDEX IF NOT EXISTS memory_archival_tenant_scope_idx
		ON memory_archival (tenant_id, scope, scope_id)`,

	// HNSW index for fast approximate nearest-neighbor search on archival embeddings.
	`DO $$
	BEGIN
		IF NOT EXISTS (
			SELECT 1 FROM pg_indexes WHERE indexname = 'memory_archival_embedding_hnsw_idx'
		) THEN
			CREATE INDEX memory_archival_embedding_hnsw_idx
				ON memory_archival USING hnsw (embedding vector_cosine_ops)
				WITH (m = 16, ef_construction = 64);
		END IF;
	END$$`,

	// ---------------------------------------------------------------
	// Row-Level Security policies
	// ---------------------------------------------------------------
	`ALTER TABLE memory_core ENABLE ROW LEVEL SECURITY`,

	`DO $$
	BEGIN
		IF NOT EXISTS (
			SELECT 1 FROM pg_policies
			WHERE tablename = 'memory_core' AND policyname = 'tenant_isolation_memory_core'
		) THEN
			CREATE POLICY tenant_isolation_memory_core ON memory_core
				USING (tenant_id::text = current_setting('app.tenant_id', true));
		END IF;
	END$$`,

	`ALTER TABLE memory_recall ENABLE ROW LEVEL SECURITY`,

	`DO $$
	BEGIN
		IF NOT EXISTS (
			SELECT 1 FROM pg_policies
			WHERE tablename = 'memory_recall' AND policyname = 'tenant_isolation_memory_recall'
		) THEN
			CREATE POLICY tenant_isolation_memory_recall ON memory_recall
				USING (tenant_id::text = current_setting('app.tenant_id', true));
		END IF;
	END$$`,

	`ALTER TABLE memory_archival ENABLE ROW LEVEL SECURITY`,

	`DO $$
	BEGIN
		IF NOT EXISTS (
			SELECT 1 FROM pg_policies
			WHERE tablename = 'memory_archival' AND policyname = 'tenant_isolation_memory_archival'
		) THEN
			CREATE POLICY tenant_isolation_memory_archival ON memory_archival
				USING (tenant_id::text = current_setting('app.tenant_id', true));
		END IF;
	END$$`,
}
