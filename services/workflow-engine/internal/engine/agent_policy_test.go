package engine

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
	"google.golang.org/protobuf/types/known/structpb"

	palv1 "github.com/dshakes/pal/gen/go/pal/v1"
	"github.com/dshakes/pal/services/workflow-engine/internal/db"
)

// policyTestPool applies the control-plane schema (which owns agents, runs and
// the ADR 0055 tables) plus the engine's own migrations to DATABASE_URL. Point
// DATABASE_URL at a FRESH database; it is never the shared one.
func policyTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL unset — skipping agent-policy DB test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Skipf("DB unreachable: %v", err)
	}
	t.Cleanup(pool.Close)
	files, _ := filepath.Glob("../../../control-plane/internal/db/migrations/*.up.sql")
	sort.Strings(files)
	if len(files) == 0 {
		t.Fatal("control-plane migrations not found")
	}
	var applied bool
	_ = pool.QueryRow(ctx, `SELECT to_regclass('agent_policies') IS NOT NULL`).Scan(&applied)
	if !applied {
		for _, f := range files {
			sql, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, string(sql)); err != nil {
				t.Fatalf("apply %s: %v", filepath.Base(f), err)
			}
		}
	}
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatalf("engine migrate: %v", err)
	}
	return pool
}

type policyFixture struct {
	pool                     *pgxpool.Pool
	tenantID, agentID, runID string
}

func newPolicyFixture(t *testing.T) policyFixture {
	t.Helper()
	pool := policyTestPool(t)
	ctx := context.Background()
	f := policyFixture{pool: pool}
	slug := "pe-" + uuid.NewString()[:8]
	if err := pool.QueryRow(ctx, `INSERT INTO tenants (slug, name, tier, k8s_namespace) VALUES ($1,$1,'personal','pal-t-'||$1) RETURNING id::text`, slug).Scan(&f.tenantID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO agents (tenant_id, name) VALUES ($1, 'tooler') RETURNING id::text`, f.tenantID).Scan(&f.agentID); err != nil {
		t.Fatal(err)
	}
	var versionID string
	if err := pool.QueryRow(ctx, `INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
		VALUES ($1, 'v1', '\x00', 'mem://test', '{}') RETURNING id::text`, f.agentID).Scan(&versionID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input) VALUES ($1, $2, $3, 'running', 'manual', '{}') RETURNING id::text`, f.tenantID, f.agentID, versionID).Scan(&f.runID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		c := context.Background()
		_, _ = pool.Exec(c, `DELETE FROM journal_events WHERE run_id::text = $1`, f.runID)
		_, _ = pool.Exec(c, `DELETE FROM step_state WHERE run_id::text = $1`, f.runID)
		_, _ = pool.Exec(c, `DELETE FROM runs WHERE id::text = $1`, f.runID)
		_, _ = pool.Exec(c, `DELETE FROM tenants WHERE id::text = $1`, f.tenantID)
	})
	return f
}

func (f policyFixture) setPolicy(t *testing.T, mode string, doc map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(doc)
	if _, err := f.pool.Exec(context.Background(), `UPDATE agent_policies SET mode=$2, document=$3 WHERE agent_id=$1`, f.agentID, mode, raw); err != nil {
		t.Fatal(err)
	}
}

func (f policyFixture) count(t *testing.T, q string, args ...any) int {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(context.Background(), q, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestAuthorizeToolCall_DefaultDenyJournalsAndAudits(t *testing.T) {
	f := newPolicyFixture(t)
	se := NewStepExecutor(f.pool, nil, zap.NewNop(), nil, nil)
	state := NewRunState(f.runID, f.tenantID, "")

	// A brand-new agent (insert trigger) is default-deny.
	err := se.authorizeToolCall(context.Background(), state, "s1", "shell_exec")
	if !errors.Is(err, ErrToolDeniedByPolicy) {
		t.Fatalf("new agent must be denied, got %v", err)
	}
	if n := f.count(t, `SELECT count(*) FROM journal_events WHERE run_id::text=$1 AND kind='policy_denied'`, f.runID); n != 1 {
		t.Fatalf("policy_denied journal events = %d, want 1", n)
	}
	if n := f.count(t, `SELECT count(*) FROM agent_identity_audit WHERE run_id=$1 AND decision='deny' AND target='shell_exec'`, f.runID); n != 1 {
		t.Fatalf("deny audit rows = %d, want 1", n)
	}

	f.setPolicy(t, "enforce", map[string]any{"tools": []string{"shell_exec"}})
	if err := se.authorizeToolCall(context.Background(), state, "s2", "shell_exec"); err != nil {
		t.Fatalf("allowed tool denied: %v", err)
	}
	if err := se.authorizeToolCall(context.Background(), state, "s3", "http_fetch"); !errors.Is(err, ErrToolDeniedByPolicy) {
		t.Fatalf("unlisted tool allowed: %v", err)
	}
}

func TestAuthorizeToolCall_BudgetAndLegacy(t *testing.T) {
	f := newPolicyFixture(t)
	se := NewStepExecutor(f.pool, nil, zap.NewNop(), nil, nil)
	state := NewRunState(f.runID, f.tenantID, "")
	f.setPolicy(t, "enforce", map[string]any{"tools": []string{"*"}, "budget": map[string]any{"maxToolCallsPerRun": 1}})
	if err := se.authorizeToolCall(context.Background(), state, "s1", "read_file"); err != nil {
		t.Fatalf("first call: %v", err)
	}
	if err := se.authorizeToolCall(context.Background(), state, "s2", "read_file"); !errors.Is(err, ErrToolDeniedByPolicy) {
		t.Fatalf("budget exhausted call must deny, got %v", err)
	}

	// A pre-existing agent with no policy row is classified legacy.
	if _, err := f.pool.Exec(context.Background(), `DELETE FROM agent_policies WHERE agent_id=$1`, f.agentID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(context.Background(), `UPDATE agents SET created_at = '2000-01-01' WHERE id=$1`, f.agentID); err != nil {
		t.Fatal(err)
	}
	if err := se.authorizeToolCall(context.Background(), state, "s3", "anything"); err != nil {
		t.Fatalf("legacy-classified agent must be allowed: %v", err)
	}
	// ...and a post-cutover agent with no row is denied.
	if _, err := f.pool.Exec(context.Background(), `UPDATE agents SET created_at = now() + interval '1 day' WHERE id=$1`, f.agentID); err != nil {
		t.Fatal(err)
	}
	if err := se.authorizeToolCall(context.Background(), state, "s4", "anything"); !errors.Is(err, ErrToolDeniedByPolicy) {
		t.Fatalf("post-cutover agent without a row must deny: %v", err)
	}
}

// TestExecuteToolCall_DeniedNeverReachesRuntime proves the gate sits BEFORE
// ExecTool: a denied tool never reaches the microVM.
func TestExecuteToolCall_DeniedNeverReachesRuntime(t *testing.T) {
	f := newPolicyFixture(t)
	res, _ := structpb.NewStruct(map[string]any{"ok": true})
	fake := &fakeRuntimeServer{resp: &palv1.ExecToolResponse{Status: palv1.ToolStatus_TOOL_STATUS_OK, Result: res}}
	client, cleanup := newFakeRuntimeClient(t, fake)
	defer cleanup()
	se := NewStepExecutor(f.pool, nil, zap.NewNop(), nil, client)
	state := NewRunState(f.runID, f.tenantID, "")

	_, err := se.executeToolCall(context.Background(), state, "s1", "k1", json.RawMessage(`{"tool_name":"shell_exec"}`))
	if !errors.Is(err, ErrToolDeniedByPolicy) {
		t.Fatalf("want deny, got %v", err)
	}
	if fake.lastReq != nil {
		t.Fatal("denied tool reached the runtime manager")
	}
	f.setPolicy(t, "enforce", map[string]any{"tools": []string{"shell_exec"}})
	if _, err := se.executeToolCall(context.Background(), state, "s2", "k2", json.RawMessage(`{"tool_name":"shell_exec"}`)); err != nil {
		t.Fatalf("allowed tool: %v", err)
	}
	if fake.lastReq == nil || fake.lastReq.GetToolName() != "shell_exec" {
		t.Fatal("allowed tool did not reach the runtime manager")
	}
}

func TestAuthorizeToolCall_NoDatabaseFailsClosed(t *testing.T) {
	se := NewStepExecutor(nil, nil, zap.NewNop(), nil, nil)
	if err := se.authorizeToolCall(context.Background(), NewRunState("r", "t", ""), "s", "x"); !errors.Is(err, ErrToolDeniedByPolicy) {
		t.Fatalf("got %v", err)
	}
}
