package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.uber.org/zap"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/dshakes/lantern/services/memory/internal/middleware"
	"github.com/dshakes/lantern/services/memory/internal/server"
)

var tracer = otel.Tracer("lantern.memory")

// MemoryTier represents the three tiers of memory.
type MemoryTier string

const (
	TierCore     MemoryTier = "core"
	TierRecall   MemoryTier = "recall"
	TierArchival MemoryTier = "archival"
)

// WriteRequest represents a request to write to memory.
type WriteRequest struct {
	Scope    string          `json:"scope"`
	ScopeID  string          `json:"scope_id"`
	Tier     MemoryTier      `json:"tier"`
	Key      string          `json:"key"`
	Text     string          `json:"text"`
	Metadata json.RawMessage `json:"metadata"`
}

// WriteResponse represents the result of a write operation.
type WriteResponse struct {
	ID string `json:"id"`
}

// ReadRequest represents a request to read from core memory.
type ReadRequest struct {
	Scope   string `json:"scope"`
	ScopeID string `json:"scope_id"`
	Tier    string `json:"tier"`
	Key     string `json:"key"`
}

// ReadResponse represents the result of a read operation.
type ReadResponse struct {
	Key       string          `json:"key"`
	Value     json.RawMessage `json:"value"`
	UpdatedAt time.Time       `json:"updated_at"`
}

// SearchRequest represents a vector search request.
type SearchRequest struct {
	Scope     string     `json:"scope"`
	ScopeID   string     `json:"scope_id"`
	Tier      MemoryTier `json:"tier"`
	Query     string     `json:"query"`
	TopK      int32      `json:"top_k"`
	Threshold float64    `json:"threshold"`
}

// SearchResult represents a single search result.
type SearchResult struct {
	ID         string          `json:"id"`
	Text       string          `json:"text"`
	Metadata   json.RawMessage `json:"metadata"`
	Similarity float64         `json:"similarity"`
	CreatedAt  time.Time       `json:"created_at"`
}

// SearchResponse represents the result of a search operation.
type SearchResponse struct {
	Results []*SearchResult `json:"results"`
}

// CompactRequest represents a request to compact recall tier.
type CompactRequest struct {
	Scope   string `json:"scope"`
	ScopeID string `json:"scope_id"`
}

// CompactResponse represents the result of a compact operation.
type CompactResponse struct {
	CompactedCount int32 `json:"compacted_count"`
	ArchivedCount  int32 `json:"archived_count"`
}

// DeleteRequest represents a request to delete from memory.
type DeleteRequest struct {
	Scope   string     `json:"scope"`
	ScopeID string     `json:"scope_id"`
	Tier    MemoryTier `json:"tier"`
	Key     string     `json:"key"`
	ID      string     `json:"id"`
}

// DeleteResponse represents the result of a delete operation.
type DeleteResponse struct {
	Deleted bool `json:"deleted"`
}

// EmbeddingFunc is a function type for generating embeddings.
// In production, this calls the model-router's Embed RPC.
type EmbeddingFunc func(ctx context.Context, text string) ([]float32, error)

// MemoryService implements the memory gRPC handlers.
type MemoryService struct {
	srv       *server.Server
	embedFunc EmbeddingFunc
}

// NewMemoryService creates a new MemoryService handler.
func NewMemoryService(srv *server.Server, embedFunc EmbeddingFunc) *MemoryService {
	return &MemoryService{srv: srv, embedFunc: embedFunc}
}

func (s *MemoryService) logger() *zap.Logger {
	return s.srv.Logger.Named("memory_service")
}

// setRLSTenantID sets the session variable used by Postgres RLS policies.
func setRLSTenantID(ctx context.Context, tx pgx.Tx, tenantID string) error {
	_, err := tx.Exec(ctx, fmt.Sprintf("SET LOCAL app.tenant_id = '%s'", tenantID))
	return err
}

// Write writes a memory entry to the appropriate tier.
func (s *MemoryService) Write(ctx context.Context, req *WriteRequest) (*WriteResponse, error) {
	ctx, span := tracer.Start(ctx, "MemoryService.Write")
	defer span.End()

	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}

	span.SetAttributes(
		attribute.String("tenant_id", tenantID),
		attribute.String("scope", req.Scope),
		attribute.String("tier", string(req.Tier)),
	)

	if req.Scope == "" || req.ScopeID == "" {
		return nil, status.Error(codes.InvalidArgument, "scope and scope_id are required")
	}

	switch req.Tier {
	case TierCore:
		return s.writeCore(ctx, tenantID, req)
	case TierRecall:
		return s.writeVector(ctx, tenantID, "memory_recall", req)
	case TierArchival:
		return s.writeVector(ctx, tenantID, "memory_archival", req)
	default:
		return nil, status.Errorf(codes.InvalidArgument, "invalid tier: %s", req.Tier)
	}
}

func (s *MemoryService) writeCore(ctx context.Context, tenantID string, req *WriteRequest) (*WriteResponse, error) {
	if req.Key == "" {
		return nil, status.Error(codes.InvalidArgument, "key is required for core tier")
	}

	valueJSON := req.Metadata
	if valueJSON == nil {
		// If no metadata, store text as a JSON string value.
		b, _ := json.Marshal(req.Text)
		valueJSON = b
	}

	tx, err := s.srv.Pool.Begin(ctx)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to begin transaction: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if err := setRLSTenantID(ctx, tx, tenantID); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to set tenant_id: %v", err)
	}

	var id string
	err = tx.QueryRow(ctx, `
		INSERT INTO memory_core (tenant_id, scope, scope_id, key, value, updated_at)
		VALUES ($1, $2, $3, $4, $5, now())
		ON CONFLICT (tenant_id, scope, scope_id, key)
		DO UPDATE SET value = EXCLUDED.value, updated_at = now()
		RETURNING id
	`, tenantID, req.Scope, req.ScopeID, req.Key, valueJSON).Scan(&id)
	if err != nil {
		s.logger().Error("write core failed", zap.Error(err), zap.String("tenant_id", tenantID))
		return nil, status.Errorf(codes.Internal, "failed to write core memory: %v", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to commit: %v", err)
	}

	s.logger().Info("core memory written",
		zap.String("tenant_id", tenantID),
		zap.String("scope", req.Scope),
		zap.String("key", req.Key),
	)

	return &WriteResponse{ID: id}, nil
}

func (s *MemoryService) writeVector(ctx context.Context, tenantID, table string, req *WriteRequest) (*WriteResponse, error) {
	if req.Text == "" {
		return nil, status.Error(codes.InvalidArgument, "text is required for recall/archival tier")
	}

	// Generate embedding via model-router Embed RPC.
	embedding, err := s.embedFunc(ctx, req.Text)
	if err != nil {
		s.logger().Error("embedding generation failed", zap.Error(err), zap.String("tenant_id", tenantID))
		return nil, status.Errorf(codes.Internal, "failed to generate embedding: %v", err)
	}

	metadataJSON := req.Metadata
	if metadataJSON == nil {
		metadataJSON = json.RawMessage("{}")
	}

	tx, err := s.srv.Pool.Begin(ctx)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to begin transaction: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if err := setRLSTenantID(ctx, tx, tenantID); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to set tenant_id: %v", err)
	}

	// Convert embedding to pgvector format string.
	embeddingStr := float32SliceToVectorLiteral(embedding)

	var id string
	query := fmt.Sprintf(`
		INSERT INTO %s (tenant_id, scope, scope_id, text, embedding, metadata, created_at)
		VALUES ($1, $2, $3, $4, $5::vector, $6, now())
		RETURNING id
	`, table)

	err = tx.QueryRow(ctx, query,
		tenantID, req.Scope, req.ScopeID, req.Text, embeddingStr, metadataJSON,
	).Scan(&id)
	if err != nil {
		s.logger().Error("write vector failed", zap.Error(err), zap.String("tenant_id", tenantID), zap.String("table", table))
		return nil, status.Errorf(codes.Internal, "failed to write %s memory: %v", table, err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to commit: %v", err)
	}

	s.logger().Info("vector memory written",
		zap.String("tenant_id", tenantID),
		zap.String("table", table),
		zap.String("scope", req.Scope),
		zap.String("id", id),
	)

	return &WriteResponse{ID: id}, nil
}

// Read reads a key-value entry from core memory.
func (s *MemoryService) Read(ctx context.Context, req *ReadRequest) (*ReadResponse, error) {
	ctx, span := tracer.Start(ctx, "MemoryService.Read")
	defer span.End()

	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}

	span.SetAttributes(
		attribute.String("tenant_id", tenantID),
		attribute.String("scope", req.Scope),
		attribute.String("key", req.Key),
	)

	if req.Scope == "" || req.ScopeID == "" {
		return nil, status.Error(codes.InvalidArgument, "scope and scope_id are required")
	}
	if req.Key == "" {
		return nil, status.Error(codes.InvalidArgument, "key is required")
	}

	tx, err := s.srv.Pool.Begin(ctx)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to begin transaction: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if err := setRLSTenantID(ctx, tx, tenantID); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to set tenant_id: %v", err)
	}

	var (
		value     json.RawMessage
		updatedAt time.Time
	)
	err = tx.QueryRow(ctx, `
		SELECT value, updated_at
		FROM memory_core
		WHERE tenant_id = $1 AND scope = $2 AND scope_id = $3 AND key = $4
	`, tenantID, req.Scope, req.ScopeID, req.Key).Scan(&value, &updatedAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, status.Errorf(codes.NotFound, "key %q not found in core memory", req.Key)
		}
		return nil, status.Errorf(codes.Internal, "query failed: %v", err)
	}

	return &ReadResponse{
		Key:       req.Key,
		Value:     value,
		UpdatedAt: updatedAt,
	}, nil
}

// Search performs vector similarity search on recall or archival tiers.
func (s *MemoryService) Search(ctx context.Context, req *SearchRequest) (*SearchResponse, error) {
	ctx, span := tracer.Start(ctx, "MemoryService.Search")
	defer span.End()

	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}

	span.SetAttributes(
		attribute.String("tenant_id", tenantID),
		attribute.String("scope", req.Scope),
		attribute.String("tier", string(req.Tier)),
		attribute.Int("top_k", int(req.TopK)),
	)

	if req.Scope == "" || req.ScopeID == "" {
		return nil, status.Error(codes.InvalidArgument, "scope and scope_id are required")
	}
	if req.Query == "" {
		return nil, status.Error(codes.InvalidArgument, "query is required")
	}

	var table string
	switch req.Tier {
	case TierRecall:
		table = "memory_recall"
	case TierArchival:
		table = "memory_archival"
	default:
		return nil, status.Errorf(codes.InvalidArgument, "search is only supported on recall and archival tiers, got: %s", req.Tier)
	}

	topK := req.TopK
	if topK <= 0 {
		topK = 10
	}
	if topK > 100 {
		topK = 100
	}

	threshold := req.Threshold
	if threshold <= 0 {
		threshold = 0.7
	}

	// Generate query embedding via model-router Embed RPC.
	queryEmbedding, err := s.embedFunc(ctx, req.Query)
	if err != nil {
		s.logger().Error("query embedding generation failed", zap.Error(err))
		return nil, status.Errorf(codes.Internal, "failed to generate query embedding: %v", err)
	}

	embeddingStr := float32SliceToVectorLiteral(queryEmbedding)

	tx, err := s.srv.Pool.Begin(ctx)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to begin transaction: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if err := setRLSTenantID(ctx, tx, tenantID); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to set tenant_id: %v", err)
	}

	// Cosine distance: pgvector's <=> operator returns distance (1 - similarity).
	// We filter where (1 - distance) >= threshold, i.e., distance <= (1 - threshold).
	query := fmt.Sprintf(`
		SELECT id, text, metadata, 1 - (embedding <=> $1::vector) AS similarity, created_at
		FROM %s
		WHERE tenant_id = $2
		  AND scope = $3
		  AND scope_id = $4
		  AND 1 - (embedding <=> $1::vector) >= $5
		ORDER BY embedding <=> $1::vector
		LIMIT $6
	`, table)

	rows, err := tx.Query(ctx, query, embeddingStr, tenantID, req.Scope, req.ScopeID, threshold, topK)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "search query failed: %v", err)
	}
	defer rows.Close()

	var results []*SearchResult
	for rows.Next() {
		var r SearchResult
		if err := rows.Scan(&r.ID, &r.Text, &r.Metadata, &r.Similarity, &r.CreatedAt); err != nil {
			return nil, status.Errorf(codes.Internal, "scan failed: %v", err)
		}
		results = append(results, &r)
	}
	if err := rows.Err(); err != nil {
		return nil, status.Errorf(codes.Internal, "row iteration failed: %v", err)
	}

	s.logger().Info("search completed",
		zap.String("tenant_id", tenantID),
		zap.String("table", table),
		zap.Int("results", len(results)),
	)

	return &SearchResponse{Results: results}, nil
}

// Compact compacts the recall tier: summarizes old entries and moves them to archival.
func (s *MemoryService) Compact(ctx context.Context, req *CompactRequest) (*CompactResponse, error) {
	ctx, span := tracer.Start(ctx, "MemoryService.Compact")
	defer span.End()

	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}

	span.SetAttributes(
		attribute.String("tenant_id", tenantID),
		attribute.String("scope", req.Scope),
	)

	if req.Scope == "" || req.ScopeID == "" {
		return nil, status.Error(codes.InvalidArgument, "scope and scope_id are required")
	}

	tx, err := s.srv.Pool.Begin(ctx)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to begin transaction: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if err := setRLSTenantID(ctx, tx, tenantID); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to set tenant_id: %v", err)
	}

	// Select old recall entries (older than 7 days) to compact.
	rows, err := tx.Query(ctx, `
		SELECT id, text, embedding, metadata, created_at
		FROM memory_recall
		WHERE tenant_id = $1 AND scope = $2 AND scope_id = $3
		  AND created_at < now() - interval '7 days'
		ORDER BY created_at ASC
		LIMIT 100
	`, tenantID, req.Scope, req.ScopeID)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to query recall entries: %v", err)
	}
	defer rows.Close()

	type recallEntry struct {
		id        string
		text      string
		embedding string
		metadata  json.RawMessage
		createdAt time.Time
	}

	var entries []recallEntry
	for rows.Next() {
		var e recallEntry
		if err := rows.Scan(&e.id, &e.text, &e.embedding, &e.metadata, &e.createdAt); err != nil {
			return nil, status.Errorf(codes.Internal, "scan failed: %v", err)
		}
		entries = append(entries, e)
	}
	if err := rows.Err(); err != nil {
		return nil, status.Errorf(codes.Internal, "row iteration failed: %v", err)
	}

	if len(entries) == 0 {
		return &CompactResponse{CompactedCount: 0, ArchivedCount: 0}, nil
	}

	// Move entries to archival tier, preserving their embeddings.
	var archivedCount int32
	var idsToDelete []string
	for _, e := range entries {
		_, err := tx.Exec(ctx, `
			INSERT INTO memory_archival (tenant_id, scope, scope_id, text, embedding, metadata, created_at)
			VALUES ($1, $2, $3, $4, $5::vector, $6, $7)
		`, tenantID, req.Scope, req.ScopeID, e.text, e.embedding, e.metadata, e.createdAt)
		if err != nil {
			s.logger().Error("failed to archive entry", zap.Error(err), zap.String("id", e.id))
			continue
		}
		idsToDelete = append(idsToDelete, e.id)
		archivedCount++
	}

	// Delete compacted entries from recall.
	if len(idsToDelete) > 0 {
		_, err := tx.Exec(ctx, `
			DELETE FROM memory_recall
			WHERE tenant_id = $1 AND id = ANY($2)
		`, tenantID, idsToDelete)
		if err != nil {
			return nil, status.Errorf(codes.Internal, "failed to delete compacted recall entries: %v", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to commit: %v", err)
	}

	s.logger().Info("compact completed",
		zap.String("tenant_id", tenantID),
		zap.String("scope", req.Scope),
		zap.Int32("compacted", int32(len(entries))),
		zap.Int32("archived", archivedCount),
	)

	return &CompactResponse{
		CompactedCount: int32(len(entries)),
		ArchivedCount:  archivedCount,
	}, nil
}

// Delete removes entries from memory.
func (s *MemoryService) Delete(ctx context.Context, req *DeleteRequest) (*DeleteResponse, error) {
	ctx, span := tracer.Start(ctx, "MemoryService.Delete")
	defer span.End()

	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}

	span.SetAttributes(
		attribute.String("tenant_id", tenantID),
		attribute.String("scope", req.Scope),
		attribute.String("tier", string(req.Tier)),
	)

	if req.Scope == "" || req.ScopeID == "" {
		return nil, status.Error(codes.InvalidArgument, "scope and scope_id are required")
	}

	tx, err := s.srv.Pool.Begin(ctx)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to begin transaction: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if err := setRLSTenantID(ctx, tx, tenantID); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to set tenant_id: %v", err)
	}

	var tag pgx.Rows
	switch req.Tier {
	case TierCore:
		if req.Key == "" {
			return nil, status.Error(codes.InvalidArgument, "key is required for core tier delete")
		}
		_, err = tx.Exec(ctx, `
			DELETE FROM memory_core
			WHERE tenant_id = $1 AND scope = $2 AND scope_id = $3 AND key = $4
		`, tenantID, req.Scope, req.ScopeID, req.Key)
	case TierRecall:
		if req.ID == "" {
			return nil, status.Error(codes.InvalidArgument, "id is required for recall tier delete")
		}
		_, err = tx.Exec(ctx, `
			DELETE FROM memory_recall
			WHERE tenant_id = $1 AND scope = $2 AND scope_id = $3 AND id = $4
		`, tenantID, req.Scope, req.ScopeID, req.ID)
	case TierArchival:
		if req.ID == "" {
			return nil, status.Error(codes.InvalidArgument, "id is required for archival tier delete")
		}
		_, err = tx.Exec(ctx, `
			DELETE FROM memory_archival
			WHERE tenant_id = $1 AND scope = $2 AND scope_id = $3 AND id = $4
		`, tenantID, req.Scope, req.ScopeID, req.ID)
	default:
		return nil, status.Errorf(codes.InvalidArgument, "invalid tier: %s", req.Tier)
	}

	if tag != nil {
		tag.Close()
	}

	if err != nil {
		return nil, status.Errorf(codes.Internal, "delete failed: %v", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to commit: %v", err)
	}

	s.logger().Info("memory entry deleted",
		zap.String("tenant_id", tenantID),
		zap.String("scope", req.Scope),
		zap.String("tier", string(req.Tier)),
	)

	return &DeleteResponse{Deleted: true}, nil
}

// float32SliceToVectorLiteral converts a float32 slice to a pgvector literal string.
// e.g., [0.1, 0.2, 0.3] -> "[0.1,0.2,0.3]"
func float32SliceToVectorLiteral(v []float32) string {
	buf := make([]byte, 0, len(v)*12+2)
	buf = append(buf, '[')
	for i, f := range v {
		if i > 0 {
			buf = append(buf, ',')
		}
		buf = append(buf, []byte(fmt.Sprintf("%g", f))...)
	}
	buf = append(buf, ']')
	return string(buf)
}
