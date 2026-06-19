package handlers

// DB-gated tests for the session_id grouping feature (UX feature #1).
//
// Skipped automatically when DATABASE_URL is unset (same convention as
// rest_subagent_test.go / runtime_test.go). Run with:
//
//	DATABASE_URL=postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable \
//	  go test -run TestSession ./internal/handlers/ -v -count=1

import (
	"testing"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
)

// ensureAgentWithVersionForSession creates (or reuses) a test agent with a
// promoted version. Returns (agentID, versionID). Registers a cleanup that
// removes the created rows.
func ensureAgentWithVersionForSession(t *testing.T, h *RESTHandler, agentName string) (agentID, versionID string) {
	t.Helper()
	ctx := tenantCtx(devTenantID)
	pool := h.srv.Pool

	_, _ = h.agentSvc.CreateAgent(ctx, &lanternv1.CreateAgentRequest{
		Name:        agentName,
		Description: "session grouping test agent",
	})

	if err := pool.QueryRow(ctx,
		`SELECT id FROM agents WHERE tenant_id = $1 AND name = $2`,
		devTenantID, agentName,
	).Scan(&agentID); err != nil {
		t.Fatalf("resolve agent %q: %v", agentName, err)
	}

	if err := pool.QueryRow(ctx, `
		INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
		VALUES ($1, '0.1.0-sess-test', 'sha256:sess-test', 's3://test/bundle.tar.gz', '{}'::jsonb)
		ON CONFLICT (agent_id, version) DO UPDATE SET digest = EXCLUDED.digest
		RETURNING id
	`, agentID).Scan(&versionID); err != nil {
		t.Fatalf("insert version: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE agents SET current_version_id = $1 WHERE id = $2`, versionID, agentID,
	); err != nil {
		t.Fatalf("promote version: %v", err)
	}

	t.Cleanup(func() {
		bg := tenantCtx(devTenantID)
		_, _ = pool.Exec(bg, `DELETE FROM runs WHERE agent_id = $1`, agentID)
		_, _ = pool.Exec(bg, `DELETE FROM agent_versions WHERE id = $1`, versionID)
		_, _ = pool.Exec(bg, `DELETE FROM agents WHERE id = $1`, agentID)
	})
	return agentID, versionID
}

// insertBareRun inserts a run row directly with the given optional session_id.
func insertBareRun(t *testing.T, h *RESTHandler, agentID, versionID string, sessionID *string) string {
	t.Helper()
	ctx := tenantCtx(devTenantID)
	var runID string
	if err := h.srv.Pool.QueryRow(ctx, `
		INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input, session_id)
		VALUES ($1, $2, $3, 'queued', 'api', '{}'::jsonb, $4)
		RETURNING id
	`, devTenantID, agentID, versionID, sessionID).Scan(&runID); err != nil {
		t.Fatalf("insertBareRun: %v", err)
	}
	return runID
}

// -----------------------------------------------------------------------
// TestRunService_CreateRun_ExplicitSessionId
// A run created with an explicit sessionId carries it through to the DB;
// a run without one → NULL.
// -----------------------------------------------------------------------
func TestRunService_CreateRun_ExplicitSessionId(t *testing.T) {
	h := newRESTHandlerForTest(t)
	ctx := tenantCtx(devTenantID)
	pool := h.srv.Pool

	agentName := "sess-create-test-" + t.Name()
	_, _ = ensureAgentWithVersionForSession(t, h, agentName)

	fakeSessionID := "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

	run, err := h.runSvc.CreateRun(ctx, &lanternv1.CreateRunRequest{
		AgentName:   agentName,
		SessionId:   fakeSessionID,
		TriggerKind: lanternv1.TriggerKind_TRIGGER_KIND_API,
	})
	if err != nil {
		t.Fatalf("CreateRun with sessionId: %v", err)
	}
	if run.GetSessionId() != fakeSessionID {
		t.Errorf("returned proto sessionId: got %q, want %q", run.GetSessionId(), fakeSessionID)
	}

	// Verify persisted in DB.
	var dbSID *string
	if err := pool.QueryRow(ctx,
		`SELECT session_id::text FROM runs WHERE id = $1`, run.GetId(),
	).Scan(&dbSID); err != nil {
		t.Fatalf("query session_id: %v", err)
	}
	if dbSID == nil || *dbSID != fakeSessionID {
		got := "<nil>"
		if dbSID != nil {
			got = *dbSID
		}
		t.Errorf("db session_id: got %q, want %q", got, fakeSessionID)
	}

	// Run without sessionId → NULL in DB, empty string in proto.
	run2, err := h.runSvc.CreateRun(ctx, &lanternv1.CreateRunRequest{
		AgentName:   agentName,
		TriggerKind: lanternv1.TriggerKind_TRIGGER_KIND_API,
	})
	if err != nil {
		t.Fatalf("CreateRun without sessionId: %v", err)
	}
	if run2.GetSessionId() != "" {
		t.Errorf("expected empty sessionId for run without one, got %q", run2.GetSessionId())
	}
	var dbSID2 *string
	if err := pool.QueryRow(ctx,
		`SELECT session_id::text FROM runs WHERE id = $1`, run2.GetId(),
	).Scan(&dbSID2); err != nil {
		t.Fatalf("query session_id for run2: %v", err)
	}
	if dbSID2 != nil {
		t.Errorf("expected NULL session_id in DB, got %q", *dbSID2)
	}
}

// -----------------------------------------------------------------------
// TestSubagentRun_InheritsParentSessionId
// Child run inherits parent's session_id; falls back to parent_run_id when
// parent has NULL session_id.
// -----------------------------------------------------------------------
func TestSubagentRun_InheritsParentSessionId(t *testing.T) {
	h := newRESTHandlerForTest(t)
	ctx := tenantCtx(devTenantID)
	pool := h.srv.Pool

	agentName := "sess-subagent-test-" + t.Name()
	agentID, versionID := ensureAgentWithVersionForSession(t, h, agentName)

	t.Run("parent_has_session_id", func(t *testing.T) {
		parentSessionID := "11111111-2222-3333-4444-555555555555"
		parentRunID := insertBareRun(t, h, agentID, versionID, &parentSessionID)
		t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM runs WHERE id = $1`, parentRunID) })

		childRunID, err := h.createSubAgentRunRow(ctx, devTenantID, agentName, parentRunID, map[string]any{"k": "v"})
		if err != nil {
			t.Fatalf("createSubAgentRunRow: %v", err)
		}
		t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM runs WHERE id = $1`, childRunID) })

		var childSID *string
		if err := pool.QueryRow(ctx,
			`SELECT session_id::text FROM runs WHERE id = $1`, childRunID,
		).Scan(&childSID); err != nil {
			t.Fatalf("query child session_id: %v", err)
		}
		if childSID == nil || *childSID != parentSessionID {
			got := "<nil>"
			if childSID != nil {
				got = *childSID
			}
			t.Errorf("child session_id: got %q, want %q (parent session)", got, parentSessionID)
		}
	})

	t.Run("parent_has_no_session_id", func(t *testing.T) {
		parentRunID := insertBareRun(t, h, agentID, versionID, nil)
		t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM runs WHERE id = $1`, parentRunID) })

		childRunID, err := h.createSubAgentRunRow(ctx, devTenantID, agentName, parentRunID, map[string]any{"k": "v"})
		if err != nil {
			t.Fatalf("createSubAgentRunRow: %v", err)
		}
		t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM runs WHERE id = $1`, childRunID) })

		var childSID *string
		if err := pool.QueryRow(ctx,
			`SELECT session_id::text FROM runs WHERE id = $1`, childRunID,
		).Scan(&childSID); err != nil {
			t.Fatalf("query child session_id: %v", err)
		}
		// No parent session_id → child.session_id = parent_run_id.
		if childSID == nil || *childSID != parentRunID {
			got := "<nil>"
			if childSID != nil {
				got = *childSID
			}
			t.Errorf("child session_id: got %q, want parent_run_id %q", got, parentRunID)
		}
	})
}

// -----------------------------------------------------------------------
// TestRunService_GetAndListRun_IncludeSessionId
// GetRun and ListRuns return sessionId + parentRunId via the Run proto.
// -----------------------------------------------------------------------
func TestRunService_GetAndListRun_IncludeSessionId(t *testing.T) {
	h := newRESTHandlerForTest(t)
	ctx := tenantCtx(devTenantID)
	pool := h.srv.Pool

	agentName := "sess-get-test-" + t.Name()
	agentID, versionID := ensureAgentWithVersionForSession(t, h, agentName)

	wantSessionID := "cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa"

	var runID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input, session_id)
		VALUES ($1, $2, $3, 'queued', 'api', '{}'::jsonb, $4::uuid)
		RETURNING id
	`, devTenantID, agentID, versionID, wantSessionID).Scan(&runID); err != nil {
		t.Fatalf("insert run: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM runs WHERE id = $1`, runID) })

	// GetRun.
	run, err := h.runSvc.GetRun(ctx, &lanternv1.GetRunRequest{Id: runID})
	if err != nil {
		t.Fatalf("GetRun: %v", err)
	}
	if run.GetSessionId() != wantSessionID {
		t.Errorf("GetRun sessionId: got %q, want %q", run.GetSessionId(), wantSessionID)
	}

	// ListRuns — find our run in the response and verify sessionId.
	resp, err := h.runSvc.ListRuns(ctx, &lanternv1.ListRunsRequest{PageSize: 100})
	if err != nil {
		t.Fatalf("ListRuns: %v", err)
	}
	found := false
	for _, r := range resp.GetRuns() {
		if r.GetId() == runID {
			found = true
			if r.GetSessionId() != wantSessionID {
				t.Errorf("ListRuns sessionId: got %q, want %q", r.GetSessionId(), wantSessionID)
			}
			break
		}
	}
	if !found {
		t.Errorf("run %q not found in ListRuns response", runID)
	}
}

// -----------------------------------------------------------------------
// TestListRuns_SessionIdFilter
// ListRuns with a SessionId filter returns only that session's runs,
// tenant-scoped, and excludes runs from other sessions.
// -----------------------------------------------------------------------
func TestListRuns_SessionIdFilter(t *testing.T) {
	h := newRESTHandlerForTest(t)
	ctx := tenantCtx(devTenantID)
	pool := h.srv.Pool

	agentName := "sess-filter-test-" + t.Name()
	agentID, versionID := ensureAgentWithVersionForSession(t, h, agentName)

	sessA := "aaaaaaaa-0000-0000-0000-000000000001"
	sessB := "bbbbbbbb-0000-0000-0000-000000000002"

	// 2 runs under sessA, 1 run under sessB.
	runA1 := insertBareRun(t, h, agentID, versionID, &sessA)
	runA2 := insertBareRun(t, h, agentID, versionID, &sessA)
	runB := insertBareRun(t, h, agentID, versionID, &sessB)
	t.Cleanup(func() {
		bg := tenantCtx(devTenantID)
		_, _ = pool.Exec(bg, `DELETE FROM runs WHERE id IN ($1, $2, $3)`, runA1, runA2, runB)
	})

	resp, err := h.runSvc.ListRuns(ctx, &lanternv1.ListRunsRequest{
		PageSize:  100,
		SessionId: sessA,
	})
	if err != nil {
		t.Fatalf("ListRuns sessionId filter: %v", err)
	}

	ids := make(map[string]bool)
	for _, r := range resp.GetRuns() {
		ids[r.GetId()] = true
	}
	for _, wantID := range []string{runA1, runA2} {
		if !ids[wantID] {
			t.Errorf("expected run %q in sessA results, not found", wantID)
		}
	}
	if ids[runB] {
		t.Errorf("run %q (sessB) must NOT appear in sessA filter results", runB)
	}
}

// -----------------------------------------------------------------------
// TestRunToMap_IncludesSessionIdAndParentRunId  (no DB required)
// runToMap always includes sessionId and parentRunId when non-empty, and
// omits both keys when empty.
// -----------------------------------------------------------------------
func TestRunToMap_IncludesSessionIdAndParentRunId(t *testing.T) {
	run := &lanternv1.Run{
		Id:          "run-1",
		SessionId:   "sess-1",
		ParentRunId: "parent-1",
	}
	m := runToMap(run)

	if v, ok := m["sessionId"]; !ok || v != "sess-1" {
		t.Errorf("sessionId: got %v (ok=%v), want sess-1", v, ok)
	}
	if v, ok := m["parentRunId"]; !ok || v != "parent-1" {
		t.Errorf("parentRunId: got %v (ok=%v), want parent-1", v, ok)
	}

	// Empty → keys absent.
	m2 := runToMap(&lanternv1.Run{Id: "run-2"})
	if _, ok := m2["sessionId"]; ok {
		t.Error("sessionId key should be absent when empty")
	}
	if _, ok := m2["parentRunId"]; ok {
		t.Error("parentRunId key should be absent when empty")
	}
}

// -----------------------------------------------------------------------
// TestIsValidUUID  (no DB required)
// -----------------------------------------------------------------------
func TestIsValidUUID(t *testing.T) {
	cases := []struct {
		input string
		want  bool
	}{
		{"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", true},
		{"00000000-0000-0000-0000-000000000001", true},
		{"AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", true}, // uppercase OK
		{"not-a-uuid", false},
		{"", false},
		{"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee", false},   // one char short
		{"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeeeg", false}, // one char long
	}
	for _, tc := range cases {
		got := isValidUUID(tc.input)
		if got != tc.want {
			t.Errorf("isValidUUID(%q): got %v, want %v", tc.input, got, tc.want)
		}
	}
}
