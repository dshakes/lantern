package handlers

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/dshakes/lantern/services/memory/internal/db"
	"github.com/dshakes/lantern/services/memory/internal/middleware"
	"github.com/dshakes/lantern/services/memory/internal/server"
)

// Test UUIDs — arbitrary; memory_core has no FK to the tenants table.
const (
	testTenantA = "aaaa0000-0000-0000-0000-000000000001"
	testTenantB = "bbbb0000-0000-0000-0000-000000000002"
)

// openTestPool connects to the dev Postgres instance and runs migrations.
// Skips the test if the database is unreachable.
func openTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable"
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Skipf("skip: cannot connect to db: %v", err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		pool.Close()
		t.Skipf("skip: db not reachable: %v", err)
	}
	if err := db.Migrate(context.Background(), pool); err != nil {
		pool.Close()
		t.Fatalf("migration: %v", err)
	}
	t.Cleanup(func() { pool.Close() })
	return pool
}

// newTestSvc builds a MemoryService wired to pool and stubEmbed.
// Pass nil for pool to test validation paths that return before any DB access.
func newTestSvc(pool *pgxpool.Pool) *MemoryService {
	srv := &server.Server{
		Pool:   pool,
		Logger: zap.NewNop(),
	}
	return NewMemoryService(srv, stubEmbed)
}

// stubEmbed returns a fixed 1536-dim vector without calling an LLM.
func stubEmbed(_ context.Context, _ string) ([]float32, error) {
	v := make([]float32, 1536)
	for i := range v {
		v[i] = 0.1
	}
	return v, nil
}

// tenantCtx wraps a tenant ID into a context the way the interceptor would.
func tenantCtx(tid string) context.Context {
	return middleware.WithTenantID(context.Background(), tid)
}

// codeOf extracts the gRPC status code, defaulting to OK if err is nil.
func codeOf(err error) codes.Code {
	return status.Code(err)
}

// TestVectorLiteral covers the pure float32→pgvector serialiser.
func TestVectorLiteral(t *testing.T) {
	cases := []struct {
		in   []float32
		want string
	}{
		{nil, "[]"},
		{[]float32{0.5}, "[0.5]"},
		{[]float32{0.25, -0.5, 0.75}, "[0.25,-0.5,0.75]"},
		// %g trims trailing zeros: 1.0 → "1"
		{[]float32{1.0, 2.0}, "[1,2]"},
	}
	for _, c := range cases {
		got := float32SliceToVectorLiteral(c.in)
		if got != c.want {
			t.Errorf("float32SliceToVectorLiteral(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestWriteValidation checks that Write rejects bad inputs before touching the DB.
func TestWriteValidation(t *testing.T) {
	svc := newTestSvc(nil) // nil pool: validation fires before pool.Begin()

	cases := []struct {
		name     string
		ctx      context.Context
		req      *WriteRequest
		wantCode codes.Code
	}{
		{
			name:     "no tenant",
			ctx:      context.Background(),
			req:      &WriteRequest{Scope: "agent", ScopeID: "s1", Tier: TierCore, Key: "k"},
			wantCode: codes.Unauthenticated,
		},
		{
			name:     "empty scope",
			ctx:      tenantCtx(testTenantA),
			req:      &WriteRequest{Scope: "", ScopeID: "s1", Tier: TierCore, Key: "k"},
			wantCode: codes.InvalidArgument,
		},
		{
			name:     "empty scope_id",
			ctx:      tenantCtx(testTenantA),
			req:      &WriteRequest{Scope: "agent", ScopeID: "", Tier: TierCore, Key: "k"},
			wantCode: codes.InvalidArgument,
		},
		{
			name:     "invalid tier",
			ctx:      tenantCtx(testTenantA),
			req:      &WriteRequest{Scope: "agent", ScopeID: "s1", Tier: "bad"},
			wantCode: codes.InvalidArgument,
		},
		{
			name:     "core without key",
			ctx:      tenantCtx(testTenantA),
			req:      &WriteRequest{Scope: "agent", ScopeID: "s1", Tier: TierCore, Key: ""},
			wantCode: codes.InvalidArgument,
		},
		{
			name:     "recall without text",
			ctx:      tenantCtx(testTenantA),
			req:      &WriteRequest{Scope: "agent", ScopeID: "s1", Tier: TierRecall, Text: ""},
			wantCode: codes.InvalidArgument,
		},
		{
			name:     "archival without text",
			ctx:      tenantCtx(testTenantA),
			req:      &WriteRequest{Scope: "agent", ScopeID: "s1", Tier: TierArchival, Text: ""},
			wantCode: codes.InvalidArgument,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := svc.Write(tc.ctx, tc.req)
			if err == nil {
				t.Fatal("expected error, got nil")
			}
			if got := codeOf(err); got != tc.wantCode {
				t.Errorf("code = %v, want %v: %v", got, tc.wantCode, err)
			}
		})
	}
}

// TestReadSearchValidation checks that Read and Search reject bad inputs before
// touching the DB or the embedding function.
func TestReadSearchValidation(t *testing.T) {
	svc := newTestSvc(nil)

	readCases := []struct {
		name     string
		ctx      context.Context
		req      *ReadRequest
		wantCode codes.Code
	}{
		{
			"no tenant",
			context.Background(),
			&ReadRequest{Scope: "a", ScopeID: "b", Key: "k"},
			codes.Unauthenticated,
		},
		{
			"empty scope",
			tenantCtx(testTenantA),
			&ReadRequest{ScopeID: "b", Key: "k"},
			codes.InvalidArgument,
		},
		{
			"empty key",
			tenantCtx(testTenantA),
			&ReadRequest{Scope: "a", ScopeID: "b", Key: ""},
			codes.InvalidArgument,
		},
	}
	for _, tc := range readCases {
		t.Run("read/"+tc.name, func(t *testing.T) {
			_, err := svc.Read(tc.ctx, tc.req)
			if got := codeOf(err); got != tc.wantCode {
				t.Errorf("code = %v, want %v", got, tc.wantCode)
			}
		})
	}

	searchCases := []struct {
		name     string
		ctx      context.Context
		req      *SearchRequest
		wantCode codes.Code
	}{
		{
			"no tenant",
			context.Background(),
			&SearchRequest{Scope: "a", ScopeID: "b", Tier: TierRecall, Query: "q"},
			codes.Unauthenticated,
		},
		{
			"empty scope",
			tenantCtx(testTenantA),
			&SearchRequest{ScopeID: "b", Tier: TierRecall, Query: "q"},
			codes.InvalidArgument,
		},
		{
			"empty query",
			tenantCtx(testTenantA),
			&SearchRequest{Scope: "a", ScopeID: "b", Tier: TierRecall, Query: ""},
			codes.InvalidArgument,
		},
		{
			"core tier unsupported",
			tenantCtx(testTenantA),
			&SearchRequest{Scope: "a", ScopeID: "b", Tier: TierCore, Query: "q"},
			codes.InvalidArgument,
		},
	}
	for _, tc := range searchCases {
		t.Run("search/"+tc.name, func(t *testing.T) {
			_, err := svc.Search(tc.ctx, tc.req)
			if got := codeOf(err); got != tc.wantCode {
				t.Errorf("code = %v, want %v", got, tc.wantCode)
			}
		})
	}
}

// TestDeleteValidation checks Delete's scope validation (pre-DB) and its
// tier-specific field checks (inside the transaction).
// NOTE: the tier checks fire after pool.Begin(), so a real pool is required
// for those cases.
func TestDeleteValidation(t *testing.T) {
	// Scope/tenant checks return before pool.Begin() — nil pool is safe.
	t.Run("no tenant", func(t *testing.T) {
		svc := newTestSvc(nil)
		_, err := svc.Delete(context.Background(), &DeleteRequest{Scope: "a", ScopeID: "b", Tier: TierCore, Key: "k"})
		if codeOf(err) != codes.Unauthenticated {
			t.Errorf("code = %v, want Unauthenticated", codeOf(err))
		}
	})
	t.Run("empty scope", func(t *testing.T) {
		svc := newTestSvc(nil)
		_, err := svc.Delete(tenantCtx(testTenantA), &DeleteRequest{ScopeID: "b", Tier: TierCore, Key: "k"})
		if codeOf(err) != codes.InvalidArgument {
			t.Errorf("code = %v, want InvalidArgument", codeOf(err))
		}
	})

	// Tier-specific checks fire inside the transaction — need a real pool.
	pool := openTestPool(t)
	svc := newTestSvc(pool)
	ctx := tenantCtx(testTenantA)

	tierCases := []struct {
		name     string
		req      *DeleteRequest
		wantCode codes.Code
	}{
		{
			"core without key",
			&DeleteRequest{Scope: "agent", ScopeID: "s1", Tier: TierCore},
			codes.InvalidArgument,
		},
		{
			"recall without id",
			&DeleteRequest{Scope: "agent", ScopeID: "s1", Tier: TierRecall},
			codes.InvalidArgument,
		},
		{
			"archival without id",
			&DeleteRequest{Scope: "agent", ScopeID: "s1", Tier: TierArchival},
			codes.InvalidArgument,
		},
		{
			"invalid tier",
			&DeleteRequest{Scope: "agent", ScopeID: "s1", Tier: "bad"},
			codes.InvalidArgument,
		},
	}
	for _, tc := range tierCases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := svc.Delete(ctx, tc.req)
			if codeOf(err) != tc.wantCode {
				t.Errorf("code = %v, want %v: %v", codeOf(err), tc.wantCode, err)
			}
		})
	}
}

// TestCoreRoundTrip exercises Write→Read and the ON CONFLICT upsert path.
func TestCoreRoundTrip(t *testing.T) {
	pool := openTestPool(t)
	svc := newTestSvc(pool)
	ctx := tenantCtx(testTenantA)
	scope, scopeID := "agent", t.Name()

	// Initial write.
	wr, err := svc.Write(ctx, &WriteRequest{
		Scope:   scope,
		ScopeID: scopeID,
		Tier:    TierCore,
		Key:     "greeting",
		Text:    "hello",
	})
	if err != nil {
		t.Fatalf("write: %v", err)
	}
	if wr.ID == "" {
		t.Fatal("write returned empty ID")
	}

	// Read it back; the stored value is the JSON encoding of the text string.
	rr, err := svc.Read(ctx, &ReadRequest{Scope: scope, ScopeID: scopeID, Key: "greeting"})
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var got string
	if err := json.Unmarshal(rr.Value, &got); err != nil {
		t.Fatalf("unmarshal value: %v", err)
	}
	if got != "hello" {
		t.Errorf("value = %q, want hello", got)
	}

	// Upsert — same key, new value.
	if _, err := svc.Write(ctx, &WriteRequest{
		Scope:   scope,
		ScopeID: scopeID,
		Tier:    TierCore,
		Key:     "greeting",
		Text:    "world",
	}); err != nil {
		t.Fatalf("upsert: %v", err)
	}

	rr2, err := svc.Read(ctx, &ReadRequest{Scope: scope, ScopeID: scopeID, Key: "greeting"})
	if err != nil {
		t.Fatalf("read after upsert: %v", err)
	}
	var got2 string
	if err := json.Unmarshal(rr2.Value, &got2); err != nil {
		t.Fatalf("unmarshal updated value: %v", err)
	}
	if got2 != "world" {
		t.Errorf("updated value = %q, want world", got2)
	}
}

// TestCoreDeleteNotFound verifies that a deleted key is no longer readable.
func TestCoreDeleteNotFound(t *testing.T) {
	pool := openTestPool(t)
	svc := newTestSvc(pool)
	ctx := tenantCtx(testTenantA)
	scope, scopeID := "agent", t.Name()

	if _, err := svc.Write(ctx, &WriteRequest{
		Scope:   scope,
		ScopeID: scopeID,
		Tier:    TierCore,
		Key:     "bye",
		Text:    "farewell",
	}); err != nil {
		t.Fatalf("write: %v", err)
	}

	dr, err := svc.Delete(ctx, &DeleteRequest{Scope: scope, ScopeID: scopeID, Tier: TierCore, Key: "bye"})
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	if !dr.Deleted {
		t.Error("Deleted = false, want true")
	}

	_, err = svc.Read(ctx, &ReadRequest{Scope: scope, ScopeID: scopeID, Key: "bye"})
	if codeOf(err) != codes.NotFound {
		t.Errorf("post-delete read: code = %v, want NotFound", codeOf(err))
	}
}

// TestTenantIsolation ensures that tenant A's core memory is invisible to tenant B.
// The service scopes reads by tenant_id via WHERE clause; this covers that guard
// without RLS enforcement (RLS is an additional layer on top).
func TestTenantIsolation(t *testing.T) {
	pool := openTestPool(t)
	svc := newTestSvc(pool)
	ctxA := tenantCtx(testTenantA)
	ctxB := tenantCtx(testTenantB)
	scope, scopeID := "agent", t.Name()

	if _, err := svc.Write(ctxA, &WriteRequest{
		Scope:   scope,
		ScopeID: scopeID,
		Tier:    TierCore,
		Key:     "secret",
		Text:    "for-a-only",
	}); err != nil {
		t.Fatalf("tenant A write: %v", err)
	}

	_, err := svc.Read(ctxB, &ReadRequest{Scope: scope, ScopeID: scopeID, Key: "secret"})
	if codeOf(err) != codes.NotFound {
		t.Errorf("tenant B read: code = %v, want NotFound (cross-tenant leak)", codeOf(err))
	}
}

// TestRecallWriteDeleteByID writes a recall-tier entry (vector) and deletes it by ID.
func TestRecallWriteDeleteByID(t *testing.T) {
	pool := openTestPool(t)
	svc := newTestSvc(pool)
	ctx := tenantCtx(testTenantA)
	scope, scopeID := "agent", t.Name()

	wr, err := svc.Write(ctx, &WriteRequest{
		Scope:   scope,
		ScopeID: scopeID,
		Tier:    TierRecall,
		Text:    "some context to remember",
	})
	if err != nil {
		t.Fatalf("write recall: %v", err)
	}
	if wr.ID == "" {
		t.Fatal("write recall returned empty ID")
	}

	dr, err := svc.Delete(ctx, &DeleteRequest{
		Scope:   scope,
		ScopeID: scopeID,
		Tier:    TierRecall,
		ID:      wr.ID,
	})
	if err != nil {
		t.Fatalf("delete recall: %v", err)
	}
	if !dr.Deleted {
		t.Error("Deleted = false, want true")
	}
}

// TestCompactNoOldEntries verifies that compacting a fresh scope (no entries older
// than 7 days) returns zero counts without error.
func TestCompactNoOldEntries(t *testing.T) {
	pool := openTestPool(t)
	svc := newTestSvc(pool)
	ctx := tenantCtx(testTenantA)
	scope, scopeID := "agent", t.Name()

	// Write a recent recall entry — it must NOT be compacted.
	if _, err := svc.Write(ctx, &WriteRequest{
		Scope:   scope,
		ScopeID: scopeID,
		Tier:    TierRecall,
		Text:    "recent memory, should survive compact",
	}); err != nil {
		t.Fatalf("write recall: %v", err)
	}

	cr, err := svc.Compact(ctx, &CompactRequest{Scope: scope, ScopeID: scopeID})
	if err != nil {
		t.Fatalf("compact: %v", err)
	}
	if cr.CompactedCount != 0 || cr.ArchivedCount != 0 {
		t.Errorf("compact fresh entries: CompactedCount=%d ArchivedCount=%d, want (0, 0)",
			cr.CompactedCount, cr.ArchivedCount)
	}
}
