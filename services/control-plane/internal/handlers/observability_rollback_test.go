package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
)

func TestObsIncidentRollback_UsesPromotionRollbackAndAudits(t *testing.T) {
	f := newPromoFixture(t)
	f.ready("v2")
	_, out := f.promote(f.apikey, "prod", "v2", nil)
	f.call("POST", "/v1/promotions/"+promoID(out)+"/approve", f.owner, nil)
	if f.prodVersion() != "v2" {
		t.Fatal("setup: v2 not serving prod")
	}
	oh := NewObsHandler(f.e.srv, f.h.auth)
	oh.SetRollbacker(f.h)

	var inc string
	must(t, f.e.superPool.QueryRow(context.Background(), `INSERT INTO agent_incidents
		(tenant_id, agent_name, kind, severity, title, first_bad_version, last_good_version, suspected_cause, rollback_suggested)
		VALUES ($1,$2,'anomaly:cost','ticket','t','v2','v1','cost 5x',true) RETURNING id::text`, f.tenant, f.agent).Scan(&inc))
	call := func(tok, id string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/x", nil)
		req.SetPathValue("id", id)
		req.Header.Set("Authorization", bearerHeader(tok))
		rr := httptest.NewRecorder()
		oh.RollbackIncident(rr, req)
		return rr
	}

	// Another tenant cannot see the incident: 404, and prod is untouched.
	other := seedEnforcedTenant(t, f.e, "obs-rb-"+uuid.NewString()[:8])
	if rr := call(mintTestToken(t, other, "u", "owner"), inc); rr.Code != http.StatusNotFound || f.prodVersion() != "v2" {
		t.Fatalf("cross-tenant rollback: %d, prod=%s", rr.Code, f.prodVersion())
	}

	rr := call(f.owner, inc)
	if rr.Code != 200 || f.prodVersion() != "v1" || f.currentVersion() != "v1" {
		t.Fatalf("rollback: %d %s prod=%s current=%s", rr.Code, rr.Body, f.prodVersion(), f.currentVersion())
	}
	var detail string
	must(t, f.e.superPool.QueryRow(context.Background(), `SELECT detail FROM agent_incident_events WHERE incident_id=$1 AND action='rollback'`, inc).Scan(&detail))
	var got string
	must(t, f.e.superPool.QueryRow(context.Background(), `SELECT detail->>'incidentId' FROM agent_promotion_audit WHERE tenant_id=$1 AND action='rolled_back' LIMIT 1`, f.tenant).Scan(&got))
	if got != inc {
		t.Fatalf("promotion audit must carry the incident id, got %q", got)
	}

	// Prod no longer serves the incident's bad version: a repeat is refused, not applied twice.
	if rr := call(f.owner, inc); rr.Code != http.StatusConflict {
		t.Fatalf("repeat rollback: want 409 got %d %s", rr.Code, rr.Body)
	}
	// An incident without a suggestion cannot roll anything back.
	var plain string
	must(t, f.e.superPool.QueryRow(context.Background(), `INSERT INTO agent_incidents (tenant_id, agent_name, kind, severity, title)
		VALUES ($1,$2,'slo:success','page','t') RETURNING id::text`, f.tenant, f.agent).Scan(&plain))
	if rr := call(f.owner, plain); rr.Code != http.StatusConflict {
		t.Fatalf("no-suggestion rollback: want 409 got %d", rr.Code)
	}
}
