package handlers

// RBAC scope-enforcement tests for the runtime handler.
//
// These tests exercise authorizeRuntimeScope and requireRuntimeScope without
// touching the database. They use the same helpers (mintTestToken,
// newTestRuntimeHandler) defined in runtime_test.go and extend them with a
// scoped-service-token variant.
//
// Coverage:
//   - authorizeRuntimeScope pure-function table (all role × scope combinations)
//   - HTTP-level gate: 403 body contains required_scope
//   - owner allowed on write + admin routes
//   - member denied on write/admin, allowed on read
//   - service with runtime:write allowed on Schedule but denied on ExecVM
//   - service with runtime:admin allowed on ExecVM and UpsertQuota
//   - service with no matching scope → 403 with expected body
//   - missing auth → 401 (regression: RBAC gate must not shadow 401)

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// mintSvcToken returns a signed JWT with Role="service" and the given scopes.
// An empty scopes slice means an unrestricted API key (all scopes allowed).
func mintSvcToken(t *testing.T, tenantID string, scopes []string) string {
	t.Helper()
	now := time.Now()
	claims := LanternClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   "svc-key-id",
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(24 * time.Hour)),
			Issuer:    "lantern-test",
		},
		TenantID: tenantID,
		Email:    "svc@test.example",
		Name:     "Service Key",
		Role:     "service",
		Scopes:   scopes,
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	s, err := tok.SignedString([]byte(testJWTSecret))
	if err != nil {
		t.Fatalf("mintSvcToken: %v", err)
	}
	return s
}

// ---------------------------------------------------------------------------
// Pure-function tests for authorizeRuntimeScope
// ---------------------------------------------------------------------------

func TestAuthorizeRuntimeScope(t *testing.T) {
	cases := []struct {
		name     string
		role     string
		scopes   []string
		required string
		want     bool
	}{
		// owner: always allowed
		{"owner/read", "owner", nil, ScopeRuntimeRead, true},
		{"owner/write", "owner", nil, ScopeRuntimeWrite, true},
		{"owner/admin", "owner", nil, ScopeRuntimeAdmin, true},

		// admin: always allowed
		{"admin/read", "admin", nil, ScopeRuntimeRead, true},
		{"admin/write", "admin", nil, ScopeRuntimeWrite, true},
		{"admin/admin", "admin", nil, ScopeRuntimeAdmin, true},

		// member: read only
		{"member/read", "member", nil, ScopeRuntimeRead, true},
		{"member/write", "member", nil, ScopeRuntimeWrite, false},
		{"member/admin", "member", nil, ScopeRuntimeAdmin, false},

		// service, unrestricted (empty scopes)
		{"svc-unrestricted/read", "service", []string{}, ScopeRuntimeRead, true},
		{"svc-unrestricted/write", "service", []string{}, ScopeRuntimeWrite, true},
		{"svc-unrestricted/admin", "service", []string{}, ScopeRuntimeAdmin, true},

		// service with runtime:read only
		{"svc-read/read", "service", []string{ScopeRuntimeRead}, ScopeRuntimeRead, true},
		{"svc-read/write", "service", []string{ScopeRuntimeRead}, ScopeRuntimeWrite, false},
		{"svc-read/admin", "service", []string{ScopeRuntimeRead}, ScopeRuntimeAdmin, false},

		// service with runtime:write (implies read)
		{"svc-write/read", "service", []string{ScopeRuntimeWrite}, ScopeRuntimeRead, true},
		{"svc-write/write", "service", []string{ScopeRuntimeWrite}, ScopeRuntimeWrite, true},
		{"svc-write/admin", "service", []string{ScopeRuntimeWrite}, ScopeRuntimeAdmin, false},

		// service with runtime:admin (implies write and read)
		{"svc-admin/read", "service", []string{ScopeRuntimeAdmin}, ScopeRuntimeRead, true},
		{"svc-admin/write", "service", []string{ScopeRuntimeAdmin}, ScopeRuntimeWrite, true},
		{"svc-admin/admin", "service", []string{ScopeRuntimeAdmin}, ScopeRuntimeAdmin, true},

		// service with mismatched scope
		{"svc-other/read", "service", []string{"agents:write"}, ScopeRuntimeRead, false},
		{"svc-other/write", "service", []string{"agents:write"}, ScopeRuntimeWrite, false},

		// unknown role — treated like member (read only)
		{"unknown/read", "analyst", nil, ScopeRuntimeRead, true},
		{"unknown/write", "analyst", nil, ScopeRuntimeWrite, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := &LanternClaims{Role: tc.role, Scopes: tc.scopes}
			got := authorizeRuntimeScope(c, tc.required)
			if got != tc.want {
				t.Errorf("authorizeRuntimeScope(role=%q scopes=%v required=%q) = %v, want %v",
					tc.role, tc.scopes, tc.required, got, tc.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// HTTP-level tests: 403 body shape
// ---------------------------------------------------------------------------

func assert403WithScope(t *testing.T, w *httptest.ResponseRecorder, requiredScope string) {
	t.Helper()
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d (body: %s)", w.Code, w.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("403 body is not JSON: %v — body: %s", err, w.Body.String())
	}
	if resp["error"] != "forbidden" {
		t.Errorf("expected error=forbidden, got %v", resp["error"])
	}
	if resp["required_scope"] != requiredScope {
		t.Errorf("expected required_scope=%q, got %v", requiredScope, resp["required_scope"])
	}
}

// ---------------------------------------------------------------------------
// Schedule (POST /v1/runtime/schedule) — requires runtime:write
// ---------------------------------------------------------------------------

func TestScheduleRBAC_OwnerAllowed(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	tok := mintTestToken(t, "tenant-1", "user-1", "owner")
	// Will reach imageDigest validation (no DB hit), not an auth denial.
	w := doSchedule(h, tok, map[string]any{})
	if w.Code == http.StatusUnauthorized || w.Code == http.StatusForbidden {
		t.Errorf("owner must not be denied on Schedule: got %d body=%s", w.Code, w.Body.String())
	}
}

func TestScheduleRBAC_MemberDenied(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	tok := mintTestToken(t, "tenant-1", "user-1", "member")
	w := doSchedule(h, tok, map[string]any{"imageDigest": "sha256:test"})
	assert403WithScope(t, w, ScopeRuntimeWrite)
}

func TestScheduleRBAC_SvcWithWriteAllowed(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	tok := mintSvcToken(t, "tenant-1", []string{ScopeRuntimeWrite})
	// imageDigest present; will panic on nil pool quota check — that means
	// the scope gate passed. Recover and confirm no 403 was returned.
	var w *httptest.ResponseRecorder
	func() {
		defer func() { recover() }() //nolint:errcheck
		w = doSchedule(h, tok, map[string]any{"imageDigest": "sha256:test"})
	}()
	if w != nil && (w.Code == http.StatusUnauthorized || w.Code == http.StatusForbidden) {
		t.Errorf("service with runtime:write must not be denied on Schedule: got %d", w.Code)
	}
}

func TestScheduleRBAC_SvcWithReadOnlyDenied(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	tok := mintSvcToken(t, "tenant-1", []string{ScopeRuntimeRead})
	w := doSchedule(h, tok, map[string]any{"imageDigest": "sha256:test"})
	assert403WithScope(t, w, ScopeRuntimeWrite)
}

func TestScheduleRBAC_SvcWithAdminAllowed(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	tok := mintSvcToken(t, "tenant-1", []string{ScopeRuntimeAdmin})
	var w *httptest.ResponseRecorder
	func() {
		defer func() { recover() }() //nolint:errcheck
		w = doSchedule(h, tok, map[string]any{"imageDigest": "sha256:test"})
	}()
	if w != nil && (w.Code == http.StatusUnauthorized || w.Code == http.StatusForbidden) {
		t.Errorf("service with runtime:admin must not be denied on Schedule: got %d", w.Code)
	}
}

func TestScheduleRBAC_SvcUnrestrictedAllowed(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	tok := mintSvcToken(t, "tenant-1", []string{}) // empty = unrestricted
	var w *httptest.ResponseRecorder
	func() {
		defer func() { recover() }() //nolint:errcheck
		w = doSchedule(h, tok, map[string]any{"imageDigest": "sha256:test"})
	}()
	if w != nil && (w.Code == http.StatusUnauthorized || w.Code == http.StatusForbidden) {
		t.Errorf("unrestricted service key must not be denied on Schedule: got %d", w.Code)
	}
}

// ---------------------------------------------------------------------------
// ExecVM (POST /v1/runtime/vms/{id}/exec) — requires runtime:admin
// ---------------------------------------------------------------------------

func doExec(h *RuntimeHandler, tok, vmID string) *httptest.ResponseRecorder {
	body := strings.NewReader(`{"command":"ls"}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/runtime/vms/"+vmID+"/exec", body)
	req.Header.Set("Content-Type", "application/json")
	if tok != "" {
		req.Header.Set("Authorization", bearerHeader(tok))
	}
	req.SetPathValue("id", vmID)
	w := httptest.NewRecorder()
	h.ExecVM(w, req)
	return w
}

func TestExecVMRBAC_OwnerAllowed(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	tok := mintTestToken(t, "tenant-1", "user-1", "owner")
	// Scope gate passes, then nil pool panics on the DB ownership check.
	// Recover inside an inner func; either we get a non-403 response or we
	// panic — both prove the scope gate was not the blocker.
	func() {
		defer func() { recover() }() //nolint:errcheck
		w := doExec(h, tok, "vm-1")
		if w.Code == http.StatusForbidden {
			t.Errorf("owner must not be denied on ExecVM: got 403 body=%s", w.Body.String())
		}
	}()
}

func TestExecVMRBAC_MemberDenied(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	tok := mintTestToken(t, "tenant-1", "user-1", "member")
	w := doExec(h, tok, "vm-1")
	assert403WithScope(t, w, ScopeRuntimeAdmin)
}

func TestExecVMRBAC_SvcWithWriteDenied(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	tok := mintSvcToken(t, "tenant-1", []string{ScopeRuntimeWrite})
	w := doExec(h, tok, "vm-1")
	assert403WithScope(t, w, ScopeRuntimeAdmin)
}

func TestExecVMRBAC_SvcWithAdminAllowed(t *testing.T) {
	// Scope gate should pass; nil pool will panic on the DB ownership check.
	// We recover to confirm the 403 path is NOT taken.
	h := newTestRuntimeHandler(t, &recScheduler{})
	tok := mintSvcToken(t, "tenant-1", []string{ScopeRuntimeAdmin})
	panicked := false
	func() {
		defer func() {
			if r := recover(); r != nil {
				panicked = true // hit DB, which means scope gate passed
			}
		}()
		w := doExec(h, tok, "vm-1")
		if w.Code == http.StatusForbidden {
			t.Errorf("service with runtime:admin must not be denied on ExecVM: got 403 body=%s", w.Body.String())
		}
	}()
	// Either we got a non-403 response OR we panicked on the nil pool —
	// both indicate the scope gate was passed.
	_ = panicked
}

// ---------------------------------------------------------------------------
// UpsertQuota (PUT /v1/runtime/quota) — requires runtime:admin
// ---------------------------------------------------------------------------

func doUpsertQuota(h *RuntimeHandler, tok string) *httptest.ResponseRecorder {
	body := strings.NewReader(`{"maxConcurrentVms":5}`)
	req := httptest.NewRequest(http.MethodPut, "/v1/runtime/quota", body)
	req.Header.Set("Content-Type", "application/json")
	if tok != "" {
		req.Header.Set("Authorization", bearerHeader(tok))
	}
	w := httptest.NewRecorder()
	h.UpsertQuota(w, req)
	return w
}

func TestUpsertQuotaRBAC_OwnerAllowed(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	tok := mintTestToken(t, "tenant-1", "user-1", "owner")
	// Reaches DB upsert (nil pool panics) — recover to confirm scope gate passed.
	panicked := false
	func() {
		defer func() {
			if r := recover(); r != nil {
				panicked = true
			}
		}()
		w := doUpsertQuota(h, tok)
		if w.Code == http.StatusForbidden {
			t.Errorf("owner must not be denied on UpsertQuota: got 403 body=%s", w.Body.String())
		}
	}()
	_ = panicked
}

func TestUpsertQuotaRBAC_MemberDenied(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	tok := mintTestToken(t, "tenant-1", "user-1", "member")
	w := doUpsertQuota(h, tok)
	assert403WithScope(t, w, ScopeRuntimeAdmin)
}

func TestUpsertQuotaRBAC_SvcWithWriteDenied(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	tok := mintSvcToken(t, "tenant-1", []string{ScopeRuntimeWrite})
	w := doUpsertQuota(h, tok)
	assert403WithScope(t, w, ScopeRuntimeAdmin)
}

func TestUpsertQuotaRBAC_SvcWithAdminAllowed(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	tok := mintSvcToken(t, "tenant-1", []string{ScopeRuntimeAdmin})
	panicked := false
	func() {
		defer func() {
			if r := recover(); r != nil {
				panicked = true
			}
		}()
		w := doUpsertQuota(h, tok)
		if w.Code == http.StatusForbidden {
			t.Errorf("service with runtime:admin must not be denied on UpsertQuota: got 403 body=%s", w.Body.String())
		}
	}()
	_ = panicked
}

// ---------------------------------------------------------------------------
// Cluster (GET /v1/runtime/cluster) — requires runtime:admin
// ---------------------------------------------------------------------------

func doCluster(h *RuntimeHandler, tok string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/v1/runtime/cluster", nil)
	if tok != "" {
		req.Header.Set("Authorization", bearerHeader(tok))
	}
	w := httptest.NewRecorder()
	h.Cluster(w, req)
	return w
}

func TestClusterRBAC_OwnerAllowed(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	tok := mintTestToken(t, "tenant-1", "user-1", "owner")
	w := doCluster(h, tok)
	if w.Code != http.StatusOK {
		t.Errorf("owner must be allowed on Cluster: got %d body=%s", w.Code, w.Body.String())
	}
}

func TestClusterRBAC_MemberDenied(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	tok := mintTestToken(t, "tenant-1", "user-1", "member")
	w := doCluster(h, tok)
	assert403WithScope(t, w, ScopeRuntimeAdmin)
}

func TestClusterRBAC_SvcWithReadDenied(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	tok := mintSvcToken(t, "tenant-1", []string{ScopeRuntimeRead})
	w := doCluster(h, tok)
	assert403WithScope(t, w, ScopeRuntimeAdmin)
}

func TestClusterRBAC_SvcWithWriteDenied(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	tok := mintSvcToken(t, "tenant-1", []string{ScopeRuntimeWrite})
	w := doCluster(h, tok)
	assert403WithScope(t, w, ScopeRuntimeAdmin)
}

func TestClusterRBAC_SvcWithAdminAllowed(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	tok := mintSvcToken(t, "tenant-1", []string{ScopeRuntimeAdmin})
	w := doCluster(h, tok)
	if w.Code == http.StatusForbidden {
		t.Errorf("service with runtime:admin must not be denied on Cluster: got 403 body=%s", w.Body.String())
	}
}

// ---------------------------------------------------------------------------
// ListVMs (GET /v1/runtime/vms) — requires runtime:read
// ---------------------------------------------------------------------------

func doListVMs(h *RuntimeHandler, tok string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/v1/runtime/vms", nil)
	if tok != "" {
		req.Header.Set("Authorization", bearerHeader(tok))
	}
	w := httptest.NewRecorder()
	h.ListVMs(w, req)
	return w
}

func TestListVMsRBAC_MemberAllowed(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	tok := mintTestToken(t, "tenant-1", "user-1", "member")
	// ListVMs will panic on nil pool query — recover to confirm scope passed.
	panicked := false
	func() {
		defer func() {
			if r := recover(); r != nil {
				panicked = true
			}
		}()
		w := doListVMs(h, tok)
		if w.Code == http.StatusForbidden {
			t.Errorf("member must be allowed on ListVMs (read): got 403 body=%s", w.Body.String())
		}
	}()
	_ = panicked
}

func TestListVMsRBAC_SvcReadAllowed(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	tok := mintSvcToken(t, "tenant-1", []string{ScopeRuntimeRead})
	panicked := false
	func() {
		defer func() {
			if r := recover(); r != nil {
				panicked = true
			}
		}()
		w := doListVMs(h, tok)
		if w.Code == http.StatusForbidden {
			t.Errorf("service with runtime:read must be allowed on ListVMs: got 403 body=%s", w.Body.String())
		}
	}()
	_ = panicked
}

func TestListVMsRBAC_SvcWrongScopeDenied(t *testing.T) {
	// A service key with a completely unrelated scope should be denied.
	h := newTestRuntimeHandler(t, &recScheduler{})
	tok := mintSvcToken(t, "tenant-1", []string{"billing:read"})
	w := doListVMs(h, tok)
	assert403WithScope(t, w, ScopeRuntimeRead)
}

// ---------------------------------------------------------------------------
// Missing auth → 401 (regression: scope gate must not shadow the 401)
// ---------------------------------------------------------------------------

func TestRBAC_MissingAuth_Returns401(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})

	tests := []struct {
		name string
		fn   func() *httptest.ResponseRecorder
	}{
		{"Schedule", func() *httptest.ResponseRecorder { return doSchedule(h, "", map[string]any{"imageDigest": "sha256:x"}) }},
		{"ListVMs", func() *httptest.ResponseRecorder { return doListVMs(h, "") }},
		{"Cluster", func() *httptest.ResponseRecorder { return doCluster(h, "") }},
		{"UpsertQuota", func() *httptest.ResponseRecorder { return doUpsertQuota(h, "") }},
		{"ExecVM", func() *httptest.ResponseRecorder { return doExec(h, "", "vm-1") }},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			w := tc.fn()
			if w.Code != http.StatusUnauthorized {
				t.Errorf("%s: missing auth should return 401, got %d body=%s",
					tc.name, w.Code, w.Body.String())
			}
		})
	}
}

// ---------------------------------------------------------------------------
// 403 body always has required_scope — cross-handler table
// ---------------------------------------------------------------------------

func TestRBAC_403BodyAlwaysHasRequiredScope(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	memberTok := mintTestToken(t, "tenant-1", "user-1", "member")

	cases := []struct {
		name          string
		fn            func() *httptest.ResponseRecorder
		requiredScope string
	}{
		{
			"Schedule",
			func() *httptest.ResponseRecorder {
				return doSchedule(h, memberTok, map[string]any{"imageDigest": "sha256:x"})
			},
			ScopeRuntimeWrite,
		},
		{
			"ExecVM",
			func() *httptest.ResponseRecorder { return doExec(h, memberTok, "vm-1") },
			ScopeRuntimeAdmin,
		},
		{
			"UpsertQuota",
			func() *httptest.ResponseRecorder { return doUpsertQuota(h, memberTok) },
			ScopeRuntimeAdmin,
		},
		{
			"Cluster",
			func() *httptest.ResponseRecorder { return doCluster(h, memberTok) },
			ScopeRuntimeAdmin,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := tc.fn()
			assert403WithScope(t, w, tc.requiredScope)
		})
	}
}

// ---------------------------------------------------------------------------
// Verify TerminateVM scope gate (write) without DB
// ---------------------------------------------------------------------------

func doTerminate(h *RuntimeHandler, tok, vmID string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodDelete, "/v1/runtime/vms/"+vmID, bytes.NewReader(nil))
	if tok != "" {
		req.Header.Set("Authorization", bearerHeader(tok))
	}
	req.SetPathValue("id", vmID)
	w := httptest.NewRecorder()
	h.TerminateVM(w, req)
	return w
}

func TestTerminateVMRBAC_MemberDenied(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	tok := mintTestToken(t, "tenant-1", "user-1", "member")
	w := doTerminate(h, tok, "vm-1")
	assert403WithScope(t, w, ScopeRuntimeWrite)
}

func TestTerminateVMRBAC_SvcReadOnlyDenied(t *testing.T) {
	h := newTestRuntimeHandler(t, &recScheduler{})
	tok := mintSvcToken(t, "tenant-1", []string{ScopeRuntimeRead})
	w := doTerminate(h, tok, "vm-1")
	assert403WithScope(t, w, ScopeRuntimeWrite)
}
