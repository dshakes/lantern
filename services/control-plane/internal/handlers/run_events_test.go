package handlers

// run_events_test.go — tests for GET /v1/runs/{id}/events (SSE).
//
// DB-gated tests are skipped when DATABASE_URL is unset (same convention as
// rest_subagent_test.go / runtime_test.go). Run with:
//
//	DATABASE_URL=postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable \
//	  go test -race -run TestRunEvents ./internal/handlers/ -v -count=1

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// ---------------------------------------------------------------------------
// Pure-function tests — no DB needed
// ---------------------------------------------------------------------------

func TestIsRunTerminal(t *testing.T) {
	cases := []struct {
		status string
		want   bool
	}{
		{"succeeded", true},
		{"failed", true},
		{"canceled", true},
		{"queued", false},
		{"running", false},
		{"", false},
		{"pending", false},
	}
	for _, tc := range cases {
		got := isRunTerminal(tc.status)
		if got != tc.want {
			t.Errorf("isRunTerminal(%q): got %v, want %v", tc.status, got, tc.want)
		}
	}
}

// ---------------------------------------------------------------------------
// DB-gated integration tests
// ---------------------------------------------------------------------------

// newRESTHandlerForRunEventsTest builds a minimal RESTHandler backed by a real
// pool. Auth is nil — tests call GetRunEvents directly with pre-built requests
// that carry a token extracted from a real JWT, or we bypass auth by
// constructing the handler differently. We opt for the same pattern as
// newRESTHandlerForTest: the auth is non-nil so the handler doesn't panic, but
// we stub the JWT secret to a well-known value used by the test token helper.
func newRESTHandlerForRunEventsTest(t *testing.T) *RESTHandler {
	t.Helper()
	pool := openTestPool(t) // skips when DATABASE_URL unset
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	agentSvc := NewAgentService(srv)
	runSvc := NewRunService(srv)
	auth := NewAuthHandler(srv, "test-jwt-secret-for-run-events")
	return &RESTHandler{srv: srv, agentSvc: agentSvc, runSvc: runSvc, auth: auth}
}

// insertRunForEvents creates an agent+version then inserts a runs row with the
// given status. Registers cleanup for all created rows.
func insertRunForEvents(t *testing.T, h *RESTHandler, tenantID, status string) string {
	t.Helper()

	// Reuse the session-test helper which creates an agent with a promoted
	// version. We need a unique agent name per test to avoid conflicts.
	agentName := "run-events-agent-" + t.Name()
	agentID, versionID := ensureAgentWithVersionForSession(t, h, agentName)

	ctx := context.Background()
	var runID string
	if err := h.srv.Pool.QueryRow(ctx, `
		INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input)
		VALUES ($1, $2, $3, $4, 'api', '{}'::jsonb)
		RETURNING id
	`, tenantID, agentID, versionID, status).Scan(&runID); err != nil {
		t.Fatalf("insertRunForEvents: %v", err)
	}
	t.Cleanup(func() {
		_, _ = h.srv.Pool.Exec(ctx, `DELETE FROM journal_events WHERE run_id = $1`, runID)
		_, _ = h.srv.Pool.Exec(ctx, `DELETE FROM runs WHERE id = $1`, runID)
	})
	return runID
}

// insertJournalEvent inserts a single journal_events row for a run.
func insertJournalEvent(t *testing.T, h *RESTHandler, runID string, seq int64, kind, stepID string, payload []byte) {
	t.Helper()
	ctx := context.Background()
	if _, err := h.srv.Pool.Exec(ctx, `
		INSERT INTO journal_events (run_id, seq, kind, step_id, attempt, payload)
		VALUES ($1, $2, $3, $4, 1, $5)
		ON CONFLICT (run_id, seq) DO NOTHING
	`, runID, seq, kind, stepID, payload); err != nil {
		t.Fatalf("insertJournalEvent(run=%s, seq=%d): %v", runID, seq, err)
	}
}

// makeRunEventsRequest builds an http.Request for GET /v1/runs/{id}/events
// with a valid JWT for the given tenantID, using the test auth handler's secret.
func makeRunEventsRequest(t *testing.T, h *RESTHandler, tenantID, runID string) *http.Request {
	t.Helper()
	// Mint a JWT using the auth handler's internal helper via a temp user row
	// — or just embed the token in the query param. For simplicity we use the
	// query param path which calls ValidateToken directly.
	token, err := h.auth.generateToken("test-user-id", tenantID, "test@example.com", "Test User", "owner")
	if err != nil {
		t.Fatalf("mintToken: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/runs/"+runID+"/events?token="+token, nil)
	// Set PathValue so r.PathValue("id") works.
	req.SetPathValue("id", runID)
	return req
}

// ---------------------------------------------------------------------------
// TestRunEvents_Ownership — a tenant cannot stream another tenant's run events
// ---------------------------------------------------------------------------

func TestRunEvents_Ownership(t *testing.T) {
	h := newRESTHandlerForRunEventsTest(t)

	// Insert a run under devTenantID.
	runID := insertRunForEvents(t, h, devTenantID, "succeeded")

	// Create a request authenticated as a DIFFERENT tenant ("other-tenant").
	// We need a second tenant row to mint a valid JWT for it.
	otherTenantID := "00000000-0000-0000-0000-000000000099"
	ctx := context.Background()
	_, _ = h.srv.Pool.Exec(ctx, `
		INSERT INTO tenants (id, slug, name, tier, k8s_namespace)
		VALUES ($1, 'other-events-test', 'Other', 'personal', 'lantern-t-other-evt')
		ON CONFLICT (id) DO NOTHING
	`, otherTenantID)
	t.Cleanup(func() {
		_, _ = h.srv.Pool.Exec(ctx, `DELETE FROM tenants WHERE id = $1`, otherTenantID)
	})

	otherToken, err := h.auth.generateToken("other-user-id", otherTenantID, "other@example.com", "Other User", "owner")
	if err != nil {
		t.Fatalf("mintToken for other tenant: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/runs/"+runID+"/events?token="+otherToken, nil)
	req.SetPathValue("id", runID)

	rr := httptest.NewRecorder()
	h.GetRunEvents(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Errorf("expected 404 for cross-tenant run events, got %d (body: %s)", rr.Code, rr.Body.String())
	}
}

// ---------------------------------------------------------------------------
// TestRunEvents_Replay — seed N journal_events, stream a terminal run, get N
// events in seq order then handler closes.
// ---------------------------------------------------------------------------

func TestRunEvents_Replay(t *testing.T) {
	h := newRESTHandlerForRunEventsTest(t)

	// Terminal run so the handler closes after replaying without needing a
	// context deadline for the tail loop.
	runID := insertRunForEvents(t, h, devTenantID, "succeeded")

	// Seed 3 journal_events.
	type seed struct {
		seq  int64
		kind string
	}
	seeds := []seed{
		{1, "step_started"},
		{2, "step_completed"},
		{3, "run_completed"},
	}
	for _, s := range seeds {
		insertJournalEvent(t, h, runID, s.seq, s.kind, "llm:main", []byte(`{"ok":true}`))
	}

	req := makeRunEventsRequest(t, h, devTenantID, runID)
	// Short deadline — handler should return before it hits since the run is terminal.
	ctx, cancel := context.WithTimeout(req.Context(), 5*time.Second)
	defer cancel()
	req = req.WithContext(ctx)

	rr := httptest.NewRecorder()
	h.GetRunEvents(rr, req)

	// Verify SSE headers.
	if ct := rr.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Errorf("Content-Type: got %q, want text/event-stream", ct)
	}

	// Parse SSE events from body.
	body := rr.Body.String()
	var got []journalEventRow
	scanner := bufio.NewScanner(strings.NewReader(body))
	var dataLine string
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "data: ") {
			dataLine = strings.TrimPrefix(line, "data: ")
		} else if line == "" && dataLine != "" {
			var row journalEventRow
			if err := json.Unmarshal([]byte(dataLine), &row); err == nil {
				got = append(got, row)
			}
			dataLine = ""
		}
	}

	if len(got) != len(seeds) {
		t.Fatalf("expected %d SSE events, got %d\nbody:\n%s", len(seeds), len(got), body)
	}
	for i, row := range got {
		if row.Seq != seeds[i].seq {
			t.Errorf("event[%d].seq: got %d, want %d", i, row.Seq, seeds[i].seq)
		}
		if row.Kind != seeds[i].kind {
			t.Errorf("event[%d].kind: got %q, want %q", i, row.Kind, seeds[i].kind)
		}
	}

	// Verify events appear in the SSE body as "event: <kind>" lines.
	for _, s := range seeds {
		if !strings.Contains(body, "event: "+s.kind) {
			t.Errorf("expected SSE event: line for kind %q, not found in body", s.kind)
		}
	}
}

// ---------------------------------------------------------------------------
// TestRunEvents_NoAuth — missing token returns 401
// ---------------------------------------------------------------------------

func TestRunEvents_NoAuth(t *testing.T) {
	h := newRESTHandlerForRunEventsTest(t)

	req := httptest.NewRequest(http.MethodGet, "/v1/runs/some-run-id/events", nil)
	req.SetPathValue("id", "some-run-id")

	rr := httptest.NewRecorder()
	h.GetRunEvents(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 for missing token, got %d", rr.Code)
	}
}

// ---------------------------------------------------------------------------
// TestRunEvents_UnknownRun — valid auth but non-existent run_id returns 404
// ---------------------------------------------------------------------------

func TestRunEvents_UnknownRun(t *testing.T) {
	h := newRESTHandlerForRunEventsTest(t)

	nonExistentID := "ffffffff-ffff-ffff-ffff-ffffffffffff"
	req := makeRunEventsRequest(t, h, devTenantID, nonExistentID)

	rr := httptest.NewRecorder()
	h.GetRunEvents(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Errorf("expected 404 for unknown run, got %d", rr.Code)
	}
}

// ---------------------------------------------------------------------------
// TestRunEvents_EmptyReplay — terminal run with no journal_events → 200 + empty
// ---------------------------------------------------------------------------

func TestRunEvents_EmptyReplay(t *testing.T) {
	h := newRESTHandlerForRunEventsTest(t)

	runID := insertRunForEvents(t, h, devTenantID, "failed")

	req := makeRunEventsRequest(t, h, devTenantID, runID)
	ctx, cancel := context.WithTimeout(req.Context(), 5*time.Second)
	defer cancel()
	req = req.WithContext(ctx)

	rr := httptest.NewRecorder()
	h.GetRunEvents(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rr.Code)
	}
	// No data: lines expected — body should be empty (no events to emit).
	body := rr.Body.String()
	if strings.Contains(body, "data:") {
		t.Errorf("expected no data events for empty run, got body: %s", body)
	}
}

// ---------------------------------------------------------------------------
// TestRunEvents_Tail_CtxCancel — non-terminal run: handler exits on ctx cancel
// ---------------------------------------------------------------------------

func TestRunEvents_Tail_CtxCancel(t *testing.T) {
	h := newRESTHandlerForRunEventsTest(t)

	// Insert a running (non-terminal) run.
	runID := insertRunForEvents(t, h, devTenantID, "running")

	req := makeRunEventsRequest(t, h, devTenantID, runID)
	// Cancel the context quickly so the tail loop exits.
	ctx, cancel := context.WithTimeout(req.Context(), 200*time.Millisecond)
	defer cancel()
	req = req.WithContext(ctx)

	start := time.Now()
	rr := httptest.NewRecorder()
	h.GetRunEvents(rr, req)
	elapsed := time.Since(start)

	// Handler must return promptly after ctx is cancelled — not hang.
	if elapsed > 3*time.Second {
		t.Errorf("GetRunEvents did not exit within 3s after ctx cancel (took %s)", elapsed)
	}
	if rr.Header().Get("Content-Type") != "text/event-stream" {
		t.Errorf("Content-Type: got %q, want text/event-stream", rr.Header().Get("Content-Type"))
	}
}
