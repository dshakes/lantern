//go:build e2e

// Package runtime_e2e exercises the W12 headless-runtime control path
// end-to-end against a LIVE local stack: real HTTP on :8080, real JWT
// auth, real Postgres rows — no httptest, no mocks.
//
// It automates the manual flow documented in
// examples/headless-agents/MANUAL-TEST.md against the single-tier
// (stub-scheduler) topology that works on macOS without KVM. On a
// two-tier stack (scheduler + Docker-backend runtime-manager wired via
// LANTERN_SCHEDULER_GRPC_ADDR) the real backend pulls the image, so set
// LANTERN_E2E_IMAGE_DIGEST to a locally pullable image — the default
// placeholder digest makes schedule return 500 there (verified).
//
// Preconditions (see e2e/README.md):
//   - make dev-infra        (Postgres + Redis + MinIO)
//   - make run-api          (control-plane on :8080)
//
// When :8080 is unreachable every test SKIPS with a clear message so CI
// stays green when the stack is down. Run via:
//
//	make test-e2e
//
// Override the target / credentials with:
//
//	LANTERN_E2E_API_URL   (default http://localhost:8080)
//	LANTERN_E2E_EMAIL     (default admin@lantern.dev)
//	LANTERN_E2E_PASSWORD  (default lantern)
package runtime_e2e

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------- config ----------

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func baseURL() string {
	return strings.TrimRight(envOr("LANTERN_E2E_API_URL", "http://localhost:8080"), "/")
}

// testImageDigest is the image-digest form the Schedule handler accepts
// (same shape as examples/headless-agents/01-hello/agent.yaml). The
// default placeholder works on the single-tier (stub-scheduler) topology,
// where nothing pulls it. On a two-tier stack (LANTERN_SCHEDULER_GRPC_ADDR
// wired) the real Docker backend tries to pull the image and schedule
// returns 500 for a non-existent one — set LANTERN_E2E_IMAGE_DIGEST to a
// locally pullable image there.
func testImageDigest() string {
	return envOr("LANTERN_E2E_IMAGE_DIGEST",
		"lantern/demos/hello@sha256:0000000000000000000000000000000000000000000000000000000000000001")
}

// ---------- stack probe (skip-not-fail when the stack is down) ----------

var (
	probeOnce sync.Once
	probeErr  error
)

// requireStack skips the calling test when the control-plane is not
// listening. This is the contract that keeps CI green when the dev
// stack isn't running.
func requireStack(t *testing.T) {
	t.Helper()
	probeOnce.Do(func() {
		c := &http.Client{Timeout: 2 * time.Second}
		resp, err := c.Get(baseURL() + "/healthz")
		if err != nil {
			probeErr = err
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			probeErr = fmt.Errorf("healthz returned HTTP %d", resp.StatusCode)
		}
	})
	if probeErr != nil {
		t.Skipf("SKIP: control-plane not reachable at %s (%v) — start it with `make dev-infra` + `make run-api`, then re-run `make test-e2e`", baseURL(), probeErr)
	}
}

// ---------- tiny API client ----------

type apiClient struct {
	t        *testing.T
	http     *http.Client
	token    string
	tenantID string
	userID   string
	role     string
}

func newClient(t *testing.T) *apiClient {
	t.Helper()
	requireStack(t)
	c := &apiClient{t: t, http: &http.Client{Timeout: 15 * time.Second}}
	c.login()
	return c
}

// login uses the documented dev-credential flow (the same one
// examples/headless-agents/MANUAL-TEST.md §0 uses) to mint a JWT.
func (c *apiClient) login() {
	c.t.Helper()
	body := map[string]string{
		"email":    envOr("LANTERN_E2E_EMAIL", "admin@lantern.dev"),
		"password": envOr("LANTERN_E2E_PASSWORD", "lantern"),
	}
	var resp struct {
		Token string `json:"token"`
		User  struct {
			ID       string `json:"id"`
			TenantID string `json:"tenantId"`
			Role     string `json:"role"`
		} `json:"user"`
	}
	status := c.doJSON(http.MethodPost, "/auth/login", body, &resp, false)
	if status != http.StatusOK {
		c.t.Fatalf("login failed: HTTP %d (stack is up but dev credentials rejected — is the dev tenant seeded?)", status)
	}
	if resp.Token == "" || resp.User.TenantID == "" {
		c.t.Fatalf("login returned empty token/tenant: %+v", resp)
	}
	c.token = resp.Token
	c.tenantID = resp.User.TenantID
	c.userID = resp.User.ID
	c.role = resp.User.Role
}

// doJSON issues a request with an optional JSON body, decodes the JSON
// response into out (when non-nil), and returns the HTTP status.
func (c *apiClient) doJSON(method, path string, body any, out any, auth bool) int {
	c.t.Helper()
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			c.t.Fatalf("marshal request body: %v", err)
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, baseURL()+path, rdr)
	if err != nil {
		c.t.Fatalf("build request %s %s: %v", method, path, err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if auth {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		c.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		c.t.Fatalf("%s %s: read body: %v", method, path, err)
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			c.t.Fatalf("%s %s: decode %q: %v", method, path, truncate(raw, 300), err)
		}
	}
	return resp.StatusCode
}

func truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "…"
}

// ---------- response DTOs (mirror runtime.go's JSON shapes) ----------

type vmRow struct {
	VmID           string          `json:"vmId"`
	TenantID       string          `json:"tenantId"`
	Node           *string         `json:"node,omitempty"`
	Az             *string         `json:"az,omitempty"`
	IsolationClass *string         `json:"isolationClass,omitempty"`
	State          string          `json:"state"`
	Spec           json.RawMessage `json:"spec"`
	CreatedAt      time.Time       `json:"createdAt"`
	TerminatedAt   *time.Time      `json:"terminatedAt,omitempty"`
}

type auditEvent struct {
	ID       int64           `json:"id"`
	TenantID string          `json:"tenantId"`
	VmID     *string         `json:"vmId,omitempty"`
	Action   string          `json:"action"`
	Attrs    json.RawMessage `json:"attrs"`
	At       time.Time       `json:"at"`
}

type quotaDTO struct {
	MaxConcurrentVMs      int     `json:"maxConcurrentVms"`
	MaxComputeHoursPerDay float64 `json:"maxComputeHoursPerDay"`
	MaxEgressGBPerDay     int     `json:"maxEgressGbPerDay"`
	MaxCostUsdPerDay      float64 `json:"maxCostUsdPerDay"`
	HardFail              bool    `json:"hardFail"`
}

type scheduleResponse struct {
	VmID      string    `json:"vmId"`
	Node      string    `json:"node"`
	Az        string    `json:"az"`
	CreatedAt time.Time `json:"createdAt"`
}

// ---------- helpers ----------

func (c *apiClient) schedule(spec map[string]any) (int, scheduleResponse) {
	c.t.Helper()
	var out scheduleResponse
	status := c.doJSON(http.MethodPost, "/v1/runtime/schedule", spec, &out, true)
	return status, out
}

func (c *apiClient) listVMs() []vmRow {
	c.t.Helper()
	var out []vmRow
	if status := c.doJSON(http.MethodGet, "/v1/runtime/vms?limit=1000", nil, &out, true); status != http.StatusOK {
		c.t.Fatalf("GET /v1/runtime/vms: HTTP %d", status)
	}
	return out
}

func (c *apiClient) getVM(id string) (int, vmRow, []auditEvent) {
	c.t.Helper()
	var out struct {
		VM     vmRow        `json:"vm"`
		Events []auditEvent `json:"events"`
	}
	status := c.doJSON(http.MethodGet, "/v1/runtime/vms/"+id, nil, &out, true)
	return status, out.VM, out.Events
}

func (c *apiClient) terminate(id string) int {
	c.t.Helper()
	var out struct {
		VmID   string `json:"vmId"`
		Status string `json:"status"`
	}
	status := c.doJSON(http.MethodDelete, "/v1/runtime/vms/"+id+"?grace=5s", nil, &out, true)
	if status == http.StatusOK && out.Status != "terminated" {
		c.t.Fatalf("DELETE vm %s: HTTP 200 but status=%q (want terminated)", id, out.Status)
	}
	return status
}

func (c *apiClient) getQuota() quotaDTO {
	c.t.Helper()
	var q quotaDTO
	if status := c.doJSON(http.MethodGet, "/v1/runtime/quota", nil, &q, true); status != http.StatusOK {
		c.t.Fatalf("GET /v1/runtime/quota: HTTP %d", status)
	}
	return q
}

func (c *apiClient) putQuota(q quotaDTO) {
	c.t.Helper()
	var out struct {
		Status string `json:"status"`
	}
	if status := c.doJSON(http.MethodPut, "/v1/runtime/quota", q, &out, true); status != http.StatusOK {
		c.t.Fatalf("PUT /v1/runtime/quota: HTTP %d", status)
	}
	if out.Status != "saved" {
		c.t.Fatalf("PUT /v1/runtime/quota: status=%q (want saved)", out.Status)
	}
}

func (c *apiClient) listAudit(limit int) []auditEvent {
	c.t.Helper()
	var out struct {
		Events []auditEvent `json:"events"`
	}
	if status := c.doJSON(http.MethodGet, fmt.Sprintf("/v1/runtime/audit?limit=%d", limit), nil, &out, true); status != http.StatusOK {
		c.t.Fatalf("GET /v1/runtime/audit: HTTP %d", status)
	}
	return out.Events
}

// liveVMCount mirrors the quota handler's "concurrent VMs" predicate
// (state IN pending/spawning/running AND terminated_at IS NULL).
func liveVMCount(vms []vmRow) int {
	n := 0
	for _, v := range vms {
		switch v.State {
		case "pending", "spawning", "running":
			if v.TerminatedAt == nil {
				n++
			}
		}
	}
	return n
}

func findAudit(events []auditEvent, action, vmID string) *auditEvent {
	for i := range events {
		if events[i].Action != action {
			continue
		}
		if vmID == "" || (events[i].VmID != nil && *events[i].VmID == vmID) {
			return &events[i]
		}
	}
	return nil
}

// ---------- tests ----------

// TestRuntime_AuthRequired proves the runtime surface rejects
// unauthenticated and garbage-token callers.
func TestRuntime_AuthRequired(t *testing.T) {
	requireStack(t)
	c := &apiClient{t: t, http: &http.Client{Timeout: 15 * time.Second}}

	cases := []struct {
		name   string
		method string
		path   string
		body   any
	}{
		{"list vms", http.MethodGet, "/v1/runtime/vms", nil},
		{"quota", http.MethodGet, "/v1/runtime/quota", nil},
		{"audit", http.MethodGet, "/v1/runtime/audit", nil},
		{"schedule", http.MethodPost, "/v1/runtime/schedule", map[string]any{"imageDigest": testImageDigest()}},
	}
	for _, tc := range cases {
		t.Run(tc.name+"/no token", func(t *testing.T) {
			if status := c.doJSON(tc.method, tc.path, tc.body, nil, false); status != http.StatusUnauthorized {
				t.Fatalf("%s %s without token: HTTP %d (want 401)", tc.method, tc.path, status)
			}
		})
	}

	t.Run("garbage token", func(t *testing.T) {
		bad := &apiClient{t: t, http: c.http, token: "not-a-jwt"}
		if status := bad.doJSON(http.MethodGet, "/v1/runtime/vms", nil, nil, true); status != http.StatusUnauthorized {
			t.Fatalf("garbage token: HTTP %d (want 401)", status)
		}
	})
}

// TestRuntime_Lifecycle walks the full documented manual flow:
// quota baseline → schedule → list → detail+audit → logs SSE →
// terminate → audit trail. Subtests share state and run in order.
func TestRuntime_Lifecycle(t *testing.T) {
	c := newClient(t)

	var vmID string

	t.Run("quota baseline", func(t *testing.T) {
		q := c.getQuota()
		// The handler returns defaults (or the stored row); either way
		// every ceiling must be a positive number — the PUT handler
		// clamps non-positive values, so zeros here mean a broken read.
		if q.MaxConcurrentVMs <= 0 || q.MaxCostUsdPerDay <= 0 {
			t.Fatalf("quota baseline has non-positive ceilings: %+v", q)
		}
	})

	// Register cleanup BEFORE scheduling: if an assertion fails after the
	// server already created the VM, the row is still terminated.
	t.Cleanup(func() {
		if vmID != "" {
			_ = c.terminate(vmID)
		}
	})

	t.Run("schedule", func(t *testing.T) {
		status, resp := c.schedule(map[string]any{
			"imageDigest": testImageDigest(),
			"isolation":   "trusted",
			"labels":      map[string]string{"e2e": "runtime-lifecycle"},
		})
		vmID = resp.VmID // capture first so cleanup runs even on assert failure
		if status != http.StatusCreated {
			t.Fatalf("POST /v1/runtime/schedule: HTTP %d (want 201) — if 402, a leftover tight quota row exists; if 500 on a two-tier stack, set LANTERN_E2E_IMAGE_DIGEST to a pullable image", status)
		}
		if resp.VmID == "" {
			t.Fatalf("schedule returned empty vmId: %+v", resp)
		}
		if resp.Node == "" {
			t.Errorf("schedule returned empty node (stub path should report node-stub): %+v", resp)
		}
		t.Logf("scheduled vm_id=%s node=%s az=%s", resp.VmID, resp.Node, resp.Az)
	})
	if vmID == "" {
		t.Fatal("schedule subtest did not produce a vmID; aborting lifecycle")
	}

	t.Run("schedule rejects missing imageDigest", func(t *testing.T) {
		status, _ := c.schedule(map[string]any{"isolation": "trusted"})
		if status != http.StatusBadRequest {
			t.Fatalf("schedule without imageDigest: HTTP %d (want 400)", status)
		}
	})

	t.Run("list shows new vm, tenant-scoped", func(t *testing.T) {
		vms := c.listVMs()
		var found *vmRow
		for i := range vms {
			if vms[i].VmID == vmID {
				found = &vms[i]
			}
			if vms[i].TenantID != c.tenantID {
				t.Fatalf("tenant isolation violation: list returned vm %s of tenant %s (caller tenant %s)",
					vms[i].VmID, vms[i].TenantID, c.tenantID)
			}
		}
		if found == nil {
			t.Fatalf("scheduled vm %s not in GET /v1/runtime/vms (%d rows)", vmID, len(vms))
		}
		switch found.State {
		case "pending", "spawning", "running":
		default:
			t.Fatalf("fresh vm state = %q (want pending/spawning/running)", found.State)
		}
	})

	t.Run("detail includes spec and schedule audit event", func(t *testing.T) {
		status, vm, events := c.getVM(vmID)
		if status != http.StatusOK {
			t.Fatalf("GET vm detail: HTTP %d", status)
		}
		if vm.VmID != vmID || vm.TenantID != c.tenantID {
			t.Fatalf("detail mismatch: got vmId=%s tenant=%s", vm.VmID, vm.TenantID)
		}
		if len(vm.Spec) == 0 || string(vm.Spec) == "{}" {
			t.Fatalf("detail spec is empty: %q", vm.Spec)
		}
		if !strings.Contains(string(vm.Spec), testImageDigest()) {
			t.Fatalf("persisted spec lost image_digest: %s", truncate(vm.Spec, 300))
		}
		if findAudit(events, "schedule", vmID) == nil {
			t.Fatalf("vm detail audit events missing 'schedule' for %s: %+v", vmID, events)
		}
	})

	t.Run("detail 404 for unknown vm", func(t *testing.T) {
		status, _, _ := c.getVM("vm-does-not-exist-e2e")
		if status != http.StatusNotFound {
			t.Fatalf("GET unknown vm: HTTP %d (want 404)", status)
		}
	})

	t.Run("logs SSE emits a frame", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL()+"/v1/runtime/vms/"+vmID+"/logs", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+c.token)
		// No client timeout here — SSE is long-lived; the ctx bounds it.
		resp, err := (&http.Client{}).Do(req)
		if err != nil {
			t.Fatalf("open logs SSE: %v", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("logs SSE: HTTP %d", resp.StatusCode)
		}
		if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
			t.Fatalf("logs SSE Content-Type = %q (want text/event-stream)", ct)
		}
		sc := bufio.NewScanner(resp.Body)
		for sc.Scan() {
			line := sc.Text()
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			var frame struct {
				VmID   string `json:"vmId"`
				Stream string `json:"stream"`
				Text   string `json:"text"`
			}
			if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &frame); err != nil {
				t.Fatalf("logs SSE frame is not JSON: %q (%v)", line, err)
			}
			if frame.VmID != vmID {
				t.Fatalf("logs SSE frame for wrong vm: %q (want %s)", frame.VmID, vmID)
			}
			t.Logf("logs SSE frame: stream=%s text=%q", frame.Stream, frame.Text)
			return // got a frame — done (stub emits exactly one; real stream is unbounded)
		}
		t.Fatalf("logs SSE closed without a data frame (scan err: %v, ctx err: %v)", sc.Err(), ctx.Err())
	})

	t.Run("terminate transitions state", func(t *testing.T) {
		if status := c.terminate(vmID); status != http.StatusOK {
			t.Fatalf("DELETE vm: HTTP %d (want 200)", status)
		}
		status, vm, _ := c.getVM(vmID)
		if status != http.StatusOK {
			t.Fatalf("GET vm after terminate: HTTP %d", status)
		}
		if vm.State != "terminated" {
			t.Fatalf("post-terminate state = %q (want terminated)", vm.State)
		}
		if vm.TerminatedAt == nil {
			t.Fatal("post-terminate terminatedAt is nil")
		}
	})

	t.Run("terminate unknown vm is 404", func(t *testing.T) {
		if status := c.terminate("vm-does-not-exist-e2e"); status != http.StatusNotFound {
			t.Fatalf("DELETE unknown vm: HTTP %d (want 404)", status)
		}
	})

	t.Run("audit trail records schedule and terminate", func(t *testing.T) {
		events := c.listAudit(200)
		if findAudit(events, "schedule", vmID) == nil {
			t.Fatalf("audit log missing 'schedule' for %s", vmID)
		}
		if findAudit(events, "terminate", vmID) == nil {
			t.Fatalf("audit log missing 'terminate' for %s", vmID)
		}
		for _, e := range events {
			if e.TenantID != c.tenantID {
				t.Fatalf("tenant isolation violation in audit: event %d belongs to %s", e.ID, e.TenantID)
			}
		}
	})
}

// TestRuntime_QuotaHardFail402 pins the concurrent-VM ceiling at the
// current live count (the PUT handler clamps values <= 0 back to
// defaults, so "quota 0" is expressed as "cap == already-live"), then
// proves the next schedule is denied with HTTP 402 and audited as
// schedule_denied. The baseline quota is restored afterwards even on
// failure.
func TestRuntime_QuotaHardFail402(t *testing.T) {
	c := newClient(t)
	if c.role != "owner" {
		t.Skipf("PUT /v1/runtime/quota is owner-only; dev user role is %q", c.role)
	}

	baseline := c.getQuota()
	t.Cleanup(func() {
		// Restore the pre-test ceilings. (If no row existed before, this
		// persists a row with the same values GET was already reporting
		// as defaults — behaviorally identical.)
		c.putQuota(baseline)
	})

	var helperVM string
	t.Cleanup(func() {
		if helperVM != "" {
			_ = c.terminate(helperVM)
		}
	})

	live := liveVMCount(c.listVMs())
	capVMs := live
	if capVMs < 1 {
		capVMs = 1
	}
	c.putQuota(quotaDTO{
		MaxConcurrentVMs:      capVMs,
		MaxComputeHoursPerDay: baseline.MaxComputeHoursPerDay,
		MaxEgressGBPerDay:     baseline.MaxEgressGBPerDay,
		MaxCostUsdPerDay:      baseline.MaxCostUsdPerDay,
		HardFail:              true,
	})

	if live == 0 {
		// Fill the single slot so the next schedule exceeds the cap.
		status, resp := c.schedule(map[string]any{
			"imageDigest": testImageDigest(),
			"isolation":   "trusted",
			"labels":      map[string]string{"e2e": "quota-filler"},
		})
		if status != http.StatusCreated {
			t.Fatalf("filler schedule: HTTP %d (want 201)", status)
		}
		helperVM = resp.VmID
	}

	// At the cap now — this one must be denied.
	var denied struct {
		Error  string `json:"error"`
		Reason string `json:"reason"`
	}
	status := c.doJSON(http.MethodPost, "/v1/runtime/schedule", map[string]any{
		"imageDigest": testImageDigest(),
		"isolation":   "trusted",
		"labels":      map[string]string{"e2e": "quota-denied"},
	}, &denied, true)
	if status != http.StatusPaymentRequired {
		t.Fatalf("over-cap schedule: HTTP %d (want 402)", status)
	}
	if denied.Error != "quota exceeded" {
		t.Fatalf("402 error = %q (want \"quota exceeded\")", denied.Error)
	}
	if !strings.Contains(denied.Reason, "concurrent VM limit") {
		t.Fatalf("402 reason = %q (want concurrent VM limit)", denied.Reason)
	}
	t.Logf("denied as expected: %s", denied.Reason)

	if findAudit(c.listAudit(100), "schedule_denied", "") == nil {
		t.Fatal("audit log missing 'schedule_denied' after 402")
	}
}
