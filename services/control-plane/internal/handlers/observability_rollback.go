package handlers

// observability_rollback.go — the Phase 6 hook for incidents (ADR 0056).
//
// POST /v1/incidents/{id}/rollback rolls PROD back through the promotion
// machinery (PromotionHandler.rollbackTx), human-initiated: a statistical
// detector suggests, a person decides. Guards: the incident must still be live
// and carry a rollback suggestion, and prod must STILL be serving the
// incident's first-bad version (someone may already have fixed it). The
// rollback and the incident audit row commit in one transaction.

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"
)

// ProdRollbacker is implemented by PromotionHandler.
type ProdRollbacker interface {
	RollbackForIncident(ctx context.Context, tx pgx.Tx, tenant, agent, servingVersion, actorID, incidentID, reason string) (rollbackResult, error)
}

func (h *ObsHandler) SetRollbacker(r ProdRollbacker) { h.rollbacker = r }

// RollbackForIncident reverts prod of `agent` if it still serves servingVersion.
func (h *PromotionHandler) RollbackForIncident(ctx context.Context, tx pgx.Tx, tenant, agent, servingVersion, actorID, incidentID, reason string) (rollbackResult, error) {
	var cur string
	err := tx.QueryRow(ctx, `SELECT version FROM agent_environments WHERE tenant_id=$1 AND agent_name=$2 AND env='prod'`,
		tenant, agent).Scan(&cur)
	if errors.Is(err, pgx.ErrNoRows) {
		return rollbackResult{}, fmt.Errorf("%w: %s has no prod environment", errConflict, agent)
	}
	if err != nil {
		return rollbackResult{}, err
	}
	if cur != servingVersion {
		return rollbackResult{}, fmt.Errorf("%w: prod now serves %q, not the incident's version %q", errConflict, cur, servingVersion)
	}
	return h.rollbackTx(ctx, tx, tenant, agent, "prod", promoActor{ID: actorID, Kind: "human"}, "incident "+incidentID+": "+reason,
		map[string]any{"incidentId": incidentID})
}

// RollbackIncident handles POST /v1/incidents/{id}/rollback.
func (h *ObsHandler) RollbackIncident(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, who, err := h.actor(r)
	if err != nil {
		unauthorized(w)
		return
	}
	id := r.PathValue("id")
	if !uuidRe.MatchString(id) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "incident not found"})
		return
	}
	if h.rollbacker == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "rollback is not available"})
		return
	}
	var res rollbackResult
	e := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		var agent, status, bad, cause string
		var suggested bool
		if err := tx.QueryRow(ctx, `SELECT agent_name, status, first_bad_version, rollback_suggested, suspected_cause
			FROM agent_incidents WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, id, tenantID).Scan(&agent, &status, &bad, &suggested, &cause); err != nil {
			return err
		}
		if status == "resolved" || !suggested {
			return fmt.Errorf("%w: incident has no live rollback suggestion", errConflict)
		}
		var err error
		if res, err = h.rollbacker.RollbackForIncident(ctx, tx, tenantID, agent, bad, who, id, cause); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO agent_incident_events (tenant_id, incident_id, actor, action, detail) VALUES ($1,$2,$3,'rollback',$4)`,
			tenantID, id, who, fmt.Sprintf("prod %s; now serving %s (promotion %s)", res.Mode, res.Version, res.PromotionID))
		return err
	})
	switch {
	case errors.Is(e, pgx.ErrNoRows):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "incident not found"})
	case errors.Is(e, errConflict):
		writeJSON(w, http.StatusConflict, map[string]string{"code": "conflict", "error": e.Error()})
	case e != nil:
		h.logger().Error("incident rollback", zap.Error(e))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "rollback failed"})
	default:
		d, _ := h.fetchIncident(ctx, tenantID, id)
		writeJSON(w, http.StatusOK, map[string]any{"rollback": res, "incident": d})
	}
}
