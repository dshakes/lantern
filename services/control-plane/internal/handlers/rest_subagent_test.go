package handlers

// DB-gated tests for the subagent wiring and replay hooks in rest.go.
//
// Skipped automatically when DATABASE_URL is unset (same convention as
// runtime_test.go / telemetry_test.go). Run with:
//
//	DATABASE_URL=postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable \
//	  go test -run TestSubagentRunRow ./internal/handlers/ -v

import (
	"context"
	"encoding/json"
	"testing"

	"go.uber.org/zap"
	"google.golang.org/grpc/metadata"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// newRESTHandlerForTest builds a minimal RESTHandler backed by a real pool.
// llmProxy is nil so executeRunInlineSync short-circuits on LLM resolution;
// the DB-gated tests only need createSubAgentRunRow and the pool.
func newRESTHandlerForTest(t *testing.T) *RESTHandler {
	t.Helper()
	pool := openTestPool(t)
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	agentSvc := NewAgentService(srv)
	runSvc := NewRunService(srv)
	return &RESTHandler{srv: srv, agentSvc: agentSvc, runSvc: runSvc}
}

// tenantCtx returns a context with the dev tenant injected, matching what
// executeRunInlineSync expects.
func tenantCtx(tenantID string) context.Context {
	ctx := context.Background()
	ctx = middleware.InjectTenantID(ctx, tenantID)
	md := metadata.Pairs("tenant_id", tenantID)
	return metadata.NewIncomingContext(ctx, md)
}

// TestSubagentRunRow_CreatesChildRun verifies that createSubAgentRunRow
// inserts a runs row with the correct parent_run_id and trigger_kind.
func TestSubagentRunRow_CreatesChildRun(t *testing.T) {
	h := newRESTHandlerForTest(t)
	ctx := tenantCtx(devTenantID)

	// Use a well-known agent from the dev seed. If it doesn't have a
	// promoted version the helper returns an error — acceptable.
	// We create a throwaway agent with an auto-version so the test is
	// self-contained.
	agentName := "subagent-test-" + t.Name()
	// Auto-create agent so the row exists.
	_, _ = h.agentSvc.CreateAgent(ctx, &lanternv1.CreateAgentRequest{
		Name:        agentName,
		Description: "subagent test agent",
	})

	// Manually ensure the agent row exists and has a version so we can
	// insert directly.
	pool := h.srv.Pool
	var agentID string
	qErr := pool.QueryRow(ctx, `
		SELECT id FROM agents WHERE tenant_id = $1 AND name = $2
	`, devTenantID, agentName).Scan(&agentID)
	if qErr != nil {
		t.Skipf("agent %q not found (seed issue): %v", agentName, qErr)
	}

	// Insert a dummy version and promote it so createSubAgentRunRow can resolve it.
	var versionID string
	vErr := pool.QueryRow(ctx, `
		INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
		VALUES ($1, '0.1.0-test', 'sha256:test', 's3://test/bundle.tar.gz', '{}'::jsonb)
		ON CONFLICT (agent_id, version) DO UPDATE SET digest = EXCLUDED.digest
		RETURNING id
	`, agentID).Scan(&versionID)
	if vErr != nil {
		t.Fatalf("insert version: %v", vErr)
	}
	if _, uErr := pool.Exec(ctx, `UPDATE agents SET current_version_id = $1 WHERE id = $2`, versionID, agentID); uErr != nil {
		t.Fatalf("promote version: %v", uErr)
	}

	// Insert a fake parent run row to satisfy the FK constraint.
	var parentRunID string
	prErr := pool.QueryRow(ctx, `
		INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input)
		VALUES ($1, $2, $3, 'running', 'api', '{}'::jsonb)
		RETURNING id
	`, devTenantID, agentID, versionID).Scan(&parentRunID)
	if prErr != nil {
		t.Fatalf("insert parent run: %v", prErr)
	}

	// Now call the helper under test.
	childRunID, err := h.createSubAgentRunRow(ctx, devTenantID, agentName, parentRunID, map[string]any{"q": "test"})
	if err != nil {
		t.Fatalf("createSubAgentRunRow: %v", err)
	}
	if childRunID == "" {
		t.Fatal("expected non-empty child run ID")
	}

	// Verify the row was written correctly.
	var (
		gotTenantID  string
		gotStatus    string
		gotTrigger   string
		gotParentID  string
		gotInputJSON []byte
	)
	sErr := pool.QueryRow(ctx, `
		SELECT tenant_id, status, trigger_kind, COALESCE(parent_run_id::text,''), input::text::bytea
		FROM runs WHERE id = $1
	`, childRunID).Scan(&gotTenantID, &gotStatus, &gotTrigger, &gotParentID, &gotInputJSON)
	if sErr != nil {
		t.Fatalf("query child run: %v", sErr)
	}

	if gotTenantID != devTenantID {
		t.Errorf("tenant_id: got %q, want %q", gotTenantID, devTenantID)
	}
	if gotStatus != "queued" {
		t.Errorf("status: got %q, want %q", gotStatus, "queued")
	}
	if gotTrigger != "subagent" {
		t.Errorf("trigger_kind: got %q, want %q", gotTrigger, "subagent")
	}
	if gotParentID != parentRunID {
		t.Errorf("parent_run_id: got %q, want %q", gotParentID, parentRunID)
	}

	// Input must be the marshalled map we passed.
	var inputMap map[string]any
	if err := json.Unmarshal(gotInputJSON, &inputMap); err != nil {
		t.Fatalf("unmarshal input: %v", err)
	}
	if q, _ := inputMap["q"].(string); q != "test" {
		t.Errorf("input.q: got %q, want %q", q, "test")
	}

	// Cleanup: remove our test rows so the DB stays tidy across runs.
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM runs WHERE id = $1`, childRunID)
		_, _ = pool.Exec(ctx, `DELETE FROM runs WHERE id = $1`, parentRunID)
		_, _ = pool.Exec(ctx, `DELETE FROM agent_versions WHERE id = $1`, versionID)
		_, _ = pool.Exec(ctx, `DELETE FROM agents WHERE id = $1`, agentID)
	})
}

// TestSubagentRunRow_UnknownAgentErrors verifies that createSubAgentRunRow
// returns an error rather than panicking when the named agent doesn't exist.
func TestSubagentRunRow_UnknownAgentErrors(t *testing.T) {
	h := newRESTHandlerForTest(t)
	ctx := tenantCtx(devTenantID)

	_, err := h.createSubAgentRunRow(ctx, devTenantID, "no-such-agent-xyz-"+t.Name(), "fake-parent-id", nil)
	if err == nil {
		t.Fatal("expected error for unknown agent, got nil")
	}
}
