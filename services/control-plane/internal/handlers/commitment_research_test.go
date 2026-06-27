package handlers

// Tests for POST /v1/commitments/{id}/research.
//
// Three cases:
//  1. Stub returns valid JSON → parsed + stored + status='suggested'.
//  2. Cross-tenant ID → 404; action_plan unchanged.
//  3. Stub returns garbage → 502; action_plan unchanged.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// researchHandlerWith builds a CommitmentHandler whose completeFn is the
// given stub. Uses the standard superuser test pool (same DB as other tests).
func researchHandlerWith(t *testing.T, stub func(ctx context.Context, tenantID, system, user string) (string, error)) (*CommitmentHandler, string) {
	t.Helper()
	pool := openTestPool(t)
	mustMigrate(t, pool)
	h := newTestCommitmentHandler(t, pool)
	h.completeFn = stub
	tenant := seedCommitmentTenant(t, pool)
	return h, tenant
}

// fireResearch POSTs /v1/commitments/{id}/research on behalf of tenant.
func fireResearch(t *testing.T, h *CommitmentHandler, tenant, id string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/commitments/"+id+"/research", strings.NewReader(""))
	req.SetPathValue("id", id)
	req.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenant, "user-x", "owner")))
	rr := httptest.NewRecorder()
	h.ResearchCommitment(rr, req)
	return rr
}

// knownPlanJSON is the stub LLM response for the happy-path test.
const knownPlanJSON = `{
  "summary": "Renew your passport at the USPS office",
  "steps": [
    {"title": "Gather documents", "detail": "Collect old passport and DS-11 form", "link": "https://travel.state.gov", "oneClick": "reminder"},
    {"title": "Book appointment", "detail": "Schedule at USPS passport centre", "oneClick": "calendar"}
  ],
  "sources": [
    {"title": "US State Dept", "url": "https://travel.state.gov"}
  ]
}`

// TestResearchCommitment_ParsesAndStores: stub returns valid JSON →
// ActionPlan returned, stored in action_plan, status='suggested'.
func TestResearchCommitment_ParsesAndStores(t *testing.T) {
	stub := func(_ context.Context, _, _, _ string) (string, error) {
		return knownPlanJSON, nil
	}
	h, tenant := researchHandlerWith(t, stub)

	id := createdID(t, postCommitment(t, h, tenant, map[string]any{
		"title":         "Renew passport",
		"source":        "self",
		"kind":          "legal",
		"sourcePreview": "Your passport expires in 3 months",
	}))

	rr := fireResearch(t, h, tenant, id)
	if rr.Code != http.StatusOK {
		t.Fatalf("research: got %d, want 200; body: %s", rr.Code, rr.Body.String())
	}

	var plan ActionPlan
	if err := json.Unmarshal(rr.Body.Bytes(), &plan); err != nil {
		t.Fatalf("decode plan: %v; body: %s", err, rr.Body.String())
	}
	if plan.Summary != "Renew your passport at the USPS office" {
		t.Errorf("summary=%q", plan.Summary)
	}
	if len(plan.Steps) != 2 {
		t.Errorf("steps=%d, want 2", len(plan.Steps))
	}
	if len(plan.Sources) != 1 {
		t.Errorf("sources=%d, want 1", len(plan.Sources))
	}
	if plan.Steps[0].OneClick != "reminder" {
		t.Errorf("step[0].oneClick=%q, want 'reminder'", plan.Steps[0].OneClick)
	}

	// DB: status='suggested', action_plan populated.
	got, code := getCommitment(t, h, tenant, id)
	if code != http.StatusOK {
		t.Fatalf("get after research: %d", code)
	}
	if got.Status != "suggested" {
		t.Errorf("status=%q after research, want 'suggested'", got.Status)
	}
	if len(got.ActionPlan) == 0 {
		t.Error("action_plan is empty after research")
	}
	var stored ActionPlan
	if err := json.Unmarshal(got.ActionPlan, &stored); err != nil {
		t.Fatalf("decode stored action_plan: %v", err)
	}
	if stored.Summary != plan.Summary {
		t.Errorf("stored summary=%q, want %q", stored.Summary, plan.Summary)
	}
}

// TestResearchCommitment_CrossTenant404: request with another tenant's token
// returns 404 and does not mutate the commitment.
func TestResearchCommitment_CrossTenant404(t *testing.T) {
	stub := func(_ context.Context, _, _, _ string) (string, error) {
		return knownPlanJSON, nil
	}
	h, tenantA := researchHandlerWith(t, stub)

	pool := openTestPool(t)
	tenantB := seedCommitmentTenant(t, pool)

	id := createdID(t, postCommitment(t, h, tenantA, map[string]any{
		"title": "Private task", "source": "self",
	}))

	// Research with tenant B's token.
	req := httptest.NewRequest(http.MethodPost, "/v1/commitments/"+id+"/research", strings.NewReader(""))
	req.SetPathValue("id", id)
	req.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenantB, "user-b", "owner")))
	rr := httptest.NewRecorder()
	h.ResearchCommitment(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Errorf("cross-tenant research: got %d, want 404", rr.Code)
	}

	// The original row must be untouched (action_plan still nil).
	got, code := getCommitment(t, h, tenantA, id)
	if code != http.StatusOK {
		t.Fatalf("get original: %d", code)
	}
	if len(got.ActionPlan) != 0 {
		t.Errorf("action_plan was mutated by cross-tenant call: %s", string(got.ActionPlan))
	}
}

// TestResearchCommitment_MalformedJSON502: stub returns unparseable text →
// 502 returned, action_plan unchanged.
func TestResearchCommitment_MalformedJSON502(t *testing.T) {
	stub := func(_ context.Context, _, _, _ string) (string, error) {
		return "I'm sorry, I cannot provide a plan right now. Please try again.", nil
	}
	h, tenant := researchHandlerWith(t, stub)

	id := createdID(t, postCommitment(t, h, tenant, map[string]any{
		"title": "Fix the leak", "source": "self",
	}))

	rr := fireResearch(t, h, tenant, id)
	if rr.Code != http.StatusBadGateway {
		t.Errorf("malformed JSON: got %d, want 502", rr.Code)
	}

	got, code := getCommitment(t, h, tenant, id)
	if code != http.StatusOK {
		t.Fatalf("get after bad LLM: %d", code)
	}
	if len(got.ActionPlan) != 0 {
		t.Errorf("garbage stored in action_plan: %s", string(got.ActionPlan))
	}
	if got.Status == "suggested" {
		t.Error("status flipped to 'suggested' despite bad LLM response")
	}
}

// ---------- Unit tests: parseActionPlan (no DB) ----------

func TestParseActionPlan_StripsFences(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		ok   bool
	}{
		{"plain json", knownPlanJSON, true},
		{"json fence", "```json\n" + knownPlanJSON + "\n```", true},
		{"plain fence", "```\n" + knownPlanJSON + "\n```", true},
		{"leading prose", "Here is the plan:\n" + knownPlanJSON, true},
		{"empty summary", `{"summary":"","steps":[],"sources":[]}`, false},
		{"not json", "sorry, I cannot help", false},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			plan, err := parseActionPlan(tc.raw)
			if tc.ok {
				if err != nil {
					t.Errorf("expected success, got error: %v", err)
				} else if plan.Summary == "" {
					t.Error("expected non-empty summary")
				}
			} else {
				if err == nil {
					t.Errorf("expected error, got plan: %+v", plan)
				}
			}
		})
	}
}
