package handlers

// Agent promotion: named environments, approval, canary, rollback (ADR 0054).
//
// A model may PROPOSE a promotion (an API key / agent principal can call
// Promote); only deterministic gates (promotion_logic.go) plus an explicit
// approval by a human owner/admin session move prod. Every decision is written
// to the append-only agent_promotion_audit table in the same transaction as the
// state change it describes.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
	"go.uber.org/zap"

	"github.com/dshakes/pal/services/control-plane/internal/middleware"
	"github.com/dshakes/pal/services/control-plane/internal/server"
)

type PromotionHandler struct {
	srv  *server.Server
	auth *AuthHandler
}

func NewPromotionHandler(srv *server.Server, auth *AuthHandler) *PromotionHandler {
	return &PromotionHandler{srv: srv, auth: auth}
}

func (h *PromotionHandler) logger() *zap.Logger { return h.srv.Logger.Named("promotion") }

// ---------- principals ----------

type promoActor struct {
	ID    string
	Kind  string // human | agent | system
	Admin bool   // owner/admin human session: may approve
}

// actorFrom classifies the caller from verified claims only. API keys (role
// "service") are agent principals; they can propose and roll back but never approve.
func (h *PromotionHandler) actorFrom(r *http.Request) (context.Context, string, promoActor, int) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		return nil, "", promoActor{}, http.StatusUnauthorized
	}
	ctx := middleware.InjectTenantID(r.Context(), claims.TenantID)
	id := firstNonEmpty(claims.Email, claims.Subject, "unknown")
	switch claims.Role {
	case "kiosk":
		return nil, "", promoActor{}, http.StatusForbidden
	case "service":
		return ctx, claims.TenantID, promoActor{ID: "api-key", Kind: "agent"}, 0
	case "owner", "admin":
		return ctx, claims.TenantID, promoActor{ID: id, Kind: "human", Admin: true}, 0
	}
	return ctx, claims.TenantID, promoActor{ID: id, Kind: "human"}, 0
}

var (
	errGate      = errors.New("gate_failed")
	errConflict  = errors.New("conflict")
	errNotFound  = errors.New("not_found")
	errForbidden = errors.New("forbidden")
)

type gateErr struct{ Gates []gateResult }

func (e *gateErr) Error() string { return "gate_failed: " + failedGates(e.Gates) }
func (e *gateErr) Unwrap() error { return errGate }

func (h *PromotionHandler) fail(w http.ResponseWriter, err error) {
	var ge *gateErr
	switch {
	case errors.As(err, &ge):
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"code": "gate_failed", "error": ge.Error(), "gates": ge.Gates})
	case errors.Is(err, errConflict):
		writeJSON(w, http.StatusConflict, map[string]string{"code": "conflict", "error": err.Error()})
	case errors.Is(err, errNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	case errors.Is(err, errForbidden):
		writeJSON(w, http.StatusForbidden, map[string]string{"code": "forbidden", "error": err.Error()})
	default:
		h.logger().Error("promotion failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
	}
}

// ---------- audit ----------

func (h *PromotionHandler) audit(ctx context.Context, tx pgx.Tx, tenant, agent, env, promoID string, a promoActor, action string, detail map[string]any) error {
	if detail == nil {
		detail = map[string]any{}
	}
	b, _ := json.Marshal(detail)
	var pid any
	if promoID != "" {
		pid = promoID
	}
	if span := trace.SpanFromContext(ctx); span.IsRecording() {
		span.SetAttributes(attribute.String("pal.agent_name", agent), attribute.String("pal.env", env),
			attribute.String("pal.promotion.action", action), attribute.String("pal.actor_kind", a.Kind))
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO agent_promotion_audit (tenant_id, agent_name, env, promotion_id, action, actor, actor_kind, detail)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, tenant, agent, env, pid, action, a.ID, a.Kind, string(b))
	return err
}

// ---------- gates ----------

func (h *PromotionHandler) gateInput(ctx context.Context, tx pgx.Tx, tenant, agent, env, version string) (gateInput, error) {
	in := gateInput{Env: env, Now: time.Now(), PriorEnvOK: env == "sandbox"}
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM agent_versions av JOIN agents a ON a.id = av.agent_id
		               WHERE a.tenant_id = $1 AND a.name = $2 AND av.version = $3 AND av.yanked_at IS NULL)`,
		tenant, agent, version).Scan(&in.VersionExists); err != nil {
		return in, err
	}
	if env != "sandbox" {
		var n int
		earlier := "'sandbox','staging'"
		if env == "staging" {
			earlier = "'sandbox'"
		}
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM agent_environments WHERE tenant_id=$1 AND agent_name=$2 AND version=$3 AND env IN (`+earlier+`)`,
			tenant, agent, version).Scan(&n); err != nil {
			return in, err
		}
		in.PriorEnvOK = n > 0

		var e evalEvidence
		err := tx.QueryRow(ctx, `
			SELECT passed, score::float8, created_at FROM eval_runs
			WHERE tenant_id=$1 AND agent_name=$2 AND agent_version=$3 AND source='hermetic'
			ORDER BY created_at DESC LIMIT 1`, tenant, agent, version).Scan(&e.Passed, &e.Score, &e.CreatedAt)
		if err == nil {
			in.Eval = &e
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return in, err
		}
		var bs float64
		err = tx.QueryRow(ctx, `
			SELECT r.score::float8 FROM eval_baselines b JOIN eval_runs r ON r.id = b.eval_run_id
			WHERE b.tenant_id=$1 AND b.agent_name=$2 AND b.branch=$3`, tenant, agent, env).Scan(&bs)
		if err == nil {
			in.BaselineScore = &bs
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return in, err
		}
	}
	// rls-exempt: CheckBudget is a shared helper that self-scopes by tenant_id.
	bc := CheckBudget(ctx, h.srv.Pool, tenant, agent, 0)
	in.BudgetOK = (bc.Allowed || !bc.HardFail) && !bc.Unavailable
	in.BudgetReason = bc.Reason
	if bc.Unavailable {
		in.BudgetReason = "budget could not be read (fail closed)"
	}
	if v := strings.ToLower(os.Getenv("PAL_PROMOTE_REQUIRE_SANDBOX_RUN")); v == "1" || v == "true" || v == "on" {
		in.SandboxRunRequired = true
		_ = tx.QueryRow(ctx, `
			SELECT COALESCE(last_sandbox_run->>'ok' = 'true', false) FROM agent_environments
			WHERE tenant_id=$1 AND agent_name=$2 AND env='sandbox' AND version=$3`,
			tenant, agent, version).Scan(&in.SandboxRunOK)
	}
	return in, nil
}

// ---------- DTOs ----------

type promotionDTO struct {
	ID          string          `json:"id"`
	AgentName   string          `json:"agentName"`
	Env         string          `json:"env"`
	Version     string          `json:"version"`
	FromVersion string          `json:"fromVersion,omitempty"`
	Status      string          `json:"status"`
	CanaryPct   int             `json:"canaryPct"`
	Guards      json.RawMessage `json:"guards"`
	Gates       json.RawMessage `json:"gates"`
	RequestedBy string          `json:"requestedBy"`
	RequestKind string          `json:"requestedByKind"`
	Approver    string          `json:"approver,omitempty"`
	ApprovedAt  *time.Time      `json:"approvedAt,omitempty"`
	Note        string          `json:"note,omitempty"`
	CreatedAt   time.Time       `json:"createdAt"`
	CompletedAt *time.Time      `json:"completedAt,omitempty"`
}

const promoCols = `id::text, agent_name, env, version, COALESCE(from_version,''), status, canary_pct, guards, gate_report,
	requested_by, requested_by_kind, COALESCE(approver,''), approved_at, COALESCE(decision_note,''), created_at, completed_at`

func scanPromo(row pgx.Row) (promotionDTO, error) {
	var p promotionDTO
	err := row.Scan(&p.ID, &p.AgentName, &p.Env, &p.Version, &p.FromVersion, &p.Status, &p.CanaryPct, &p.Guards, &p.Gates,
		&p.RequestedBy, &p.RequestKind, &p.Approver, &p.ApprovedAt, &p.Note, &p.CreatedAt, &p.CompletedAt)
	return p, err
}

// ---------- apply (state machine) ----------

// applyPromotion moves environment state for an approved/auto promotion. The
// caller holds the promotion row lock and has written nothing else yet.
func (h *PromotionHandler) applyPromotion(ctx context.Context, tx pgx.Tx, tenant string, p promotionDTO, a promoActor) (string, error) {
	var curVer string
	var curStatus string
	err := tx.QueryRow(ctx, `SELECT version, status FROM agent_environments WHERE tenant_id=$1 AND agent_name=$2 AND env=$3 FOR UPDATE`,
		tenant, p.AgentName, p.Env).Scan(&curVer, &curStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		curVer = ""
	} else if err != nil {
		return "", err
	}
	if curStatus == "canary" {
		return "", fmt.Errorf("%w: a canary is already running in %s", errConflict, p.Env)
	}
	if p.Env == "prod" && curVer == "" {
		// First prod promotion adopts the live version as the stable baseline.
		_ = tx.QueryRow(ctx, `SELECT av.version FROM agents a JOIN agent_versions av ON av.id = a.current_version_id
			WHERE a.tenant_id=$1 AND a.name=$2`, tenant, p.AgentName).Scan(&curVer)
	}

	if p.Env == "prod" && p.CanaryPct > 0 && curVer != "" && curVer != p.Version {
		var expID string
		if err := tx.QueryRow(ctx, `
			INSERT INTO agent_experiments (tenant_id, agent_name, name, variant_a_version, variant_b_version,
			                               traffic_split_b, auto_promote, min_runs_to_promote)
			VALUES ($1,$2,$3,$4,$5,$6,false,100) RETURNING id::text`,
			tenant, p.AgentName, "canary-"+p.ID[:8], curVer, p.Version, p.CanaryPct).Scan(&expID); err != nil {
			return "", err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO agent_environments (tenant_id, agent_name, env, version, previous_version, status, canary_experiment_id, promotion_id, updated_by)
			VALUES ($1,$2,'prod',$3,NULL,'canary',$4,$5,$6)
			ON CONFLICT (tenant_id, agent_name, env) DO UPDATE SET version=EXCLUDED.version, status='canary',
			  canary_experiment_id=EXCLUDED.canary_experiment_id, promotion_id=EXCLUDED.promotion_id,
			  updated_by=EXCLUDED.updated_by, updated_at=now()`,
			tenant, p.AgentName, curVer, expID, p.ID, a.ID); err != nil {
			return "", err
		}
		if _, err := tx.Exec(ctx, `UPDATE agent_promotions SET status='canary', from_version=$2 WHERE id=$1`, p.ID, curVer); err != nil {
			return "", err
		}
		return "canary", h.audit(ctx, tx, tenant, p.AgentName, p.Env, p.ID, a, "canary_started",
			map[string]any{"version": p.Version, "stable": curVer, "pct": p.CanaryPct, "experiment": expID})
	}
	return "promoted", h.fullRollout(ctx, tx, tenant, p, curVer, a, "promoted")
}

// fullRollout makes p.Version the env's only version (also used when a canary passes).
func (h *PromotionHandler) fullRollout(ctx context.Context, tx pgx.Tx, tenant string, p promotionDTO, prev string, a promoActor, action string) error {
	if prev == p.Version {
		prev = ""
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO agent_environments (tenant_id, agent_name, env, version, previous_version, status, promotion_id, updated_by)
		VALUES ($1,$2,$3,$4,NULLIF($5,''),'active',$6,$7)
		ON CONFLICT (tenant_id, agent_name, env) DO UPDATE SET version=EXCLUDED.version,
		  previous_version=EXCLUDED.previous_version, status='active', canary_experiment_id=NULL,
		  promotion_id=EXCLUDED.promotion_id, updated_by=EXCLUDED.updated_by, updated_at=now()`,
		tenant, p.AgentName, p.Env, p.Version, prev, p.ID, a.ID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_promotions SET status='promoted', from_version=NULLIF($2,''), completed_at=now() WHERE id=$1`, p.ID, prev); err != nil {
		return err
	}
	if p.Env == "prod" {
		// Keep legacy readers (A2A card, receipts) on the same version.
		if err := syncCurrentVersion(ctx, tx, tenant, p.AgentName, p.Version); err != nil {
			return err
		}
	}
	// Pin the evidence run as this environment's baseline so the next promotion is compared to it.
	if _, err := tx.Exec(ctx, `
		INSERT INTO eval_baselines (tenant_id, agent_name, branch, eval_run_id)
		SELECT $1,$2,$3,id FROM eval_runs WHERE tenant_id=$1 AND agent_name=$2 AND agent_version=$4
		  AND source='hermetic' AND passed ORDER BY created_at DESC LIMIT 1
		ON CONFLICT (tenant_id, agent_name, branch) DO UPDATE SET eval_run_id=EXCLUDED.eval_run_id, set_at=now()`,
		tenant, p.AgentName, p.Env, p.Version); err != nil {
		return err
	}
	return h.audit(ctx, tx, tenant, p.AgentName, p.Env, p.ID, a, action, map[string]any{"version": p.Version, "previous": prev})
}

func syncCurrentVersion(ctx context.Context, tx pgx.Tx, tenant, agent, version string) error {
	_, err := tx.Exec(ctx, `
		UPDATE agents a SET current_version_id = (SELECT av.id FROM agent_versions av WHERE av.agent_id = a.id AND av.version = $3)
		WHERE a.tenant_id=$1 AND a.name=$2
		  AND EXISTS (SELECT 1 FROM agent_versions av WHERE av.agent_id = a.id AND av.version = $3)`,
		tenant, agent, version)
	return err
}

// ---------- Promote ----------

type promoteRequest struct {
	Env             string       `json:"env"`
	Version         string       `json:"version"`
	CanaryPct       int          `json:"canaryPct"`
	Guards          canaryGuards `json:"guards"`
	RequireApproval bool         `json:"requireApproval"`
	Reason          string       `json:"reason"`
}

// Promote handles POST /v1/agents/{name}/promote.
func (h *PromotionHandler) Promote(w http.ResponseWriter, r *http.Request) {
	ctx, tenant, a, code := h.actorFrom(r)
	if code != 0 {
		writeJSON(w, code, map[string]string{"error": http.StatusText(code)})
		return
	}
	agent := r.PathValue("name")
	var req promoteRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if !validPromotionEnv(req.Env) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "env must be sandbox, staging or prod"})
		return
	}
	if req.CanaryPct < 0 || req.CanaryPct > 99 || (req.CanaryPct > 0 && req.Env != "prod") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "canaryPct must be 0-99 and applies to prod only"})
		return
	}
	if err := req.Guards.validate(); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	req.Guards.defaults()
	if len(req.Reason) > 500 {
		req.Reason = req.Reason[:500]
	}

	var out promotionDTO
	var gates []gateResult
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		if req.Version == "" {
			// Default: the newest frozen version (the one the builder just created).
			if err := tx.QueryRow(ctx, `SELECT av.version FROM agent_versions av JOIN agents a ON a.id = av.agent_id
				WHERE a.tenant_id=$1 AND a.name=$2 AND a.archived_at IS NULL AND av.yanked_at IS NULL
				ORDER BY av.created_at DESC LIMIT 1`, tenant, agent).Scan(&req.Version); err != nil {
				return errNotFound
			}
		}
		in, err := h.gateInput(ctx, tx, tenant, agent, req.Env, req.Version)
		if err != nil {
			return err
		}
		gates = evaluateGates(in)
		return nil
	})
	if err != nil {
		h.fail(w, err)
		return
	}
	if !gatesPass(gates) {
		// A blocked attempt is itself an auditable decision; commit it.
		_ = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
			return h.audit(ctx, tx, tenant, agent, req.Env, "", a, "promote_blocked",
				map[string]any{"version": req.Version, "gates": gates, "reason": req.Reason})
		})
		h.fail(w, &gateErr{gates})
		return
	}

	pending := needsApproval(req.Env, req.RequireApproval)
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		gj, _ := json.Marshal(gates)
		guards, _ := json.Marshal(req.Guards)
		status := "pending_approval"
		if !pending {
			status = "promoted" // provisional; applyPromotion sets the final status
		}
		row := tx.QueryRow(ctx, `
			INSERT INTO agent_promotions (tenant_id, agent_name, env, version, status, canary_pct, guards, gate_report,
			                              requested_by, requested_by_kind, decision_note)
			VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,NULLIF($11,''))
			RETURNING `+promoCols, tenant, agent, req.Env, req.Version, status, req.CanaryPct, string(guards), string(gj), a.ID, a.Kind, req.Reason)
		p, err := scanPromo(row)
		if err != nil {
			var pe interface{ SQLState() string }
			if errors.As(err, &pe) && pe.SQLState() == "23505" {
				return fmt.Errorf("%w: a promotion for %s/%s is already pending or in canary", errConflict, agent, req.Env)
			}
			return err
		}
		if err := h.audit(ctx, tx, tenant, agent, req.Env, p.ID, a, "promote_requested",
			map[string]any{"version": req.Version, "canaryPct": req.CanaryPct, "approvalRequired": pending, "reason": req.Reason}); err != nil {
			return err
		}
		if pending {
			out = p
			return nil
		}
		final, err := h.applyPromotion(ctx, tx, tenant, p, a)
		if err != nil {
			return err
		}
		p.Status = final
		out = p
		return nil
	})
	if err != nil {
		h.fail(w, err)
		return
	}
	middleware.EnrichSpan(ctx, tenant, a.ID, "", "")
	status := http.StatusOK
	if out.Status == "pending_approval" {
		status = http.StatusAccepted
	}
	writeJSON(w, status, map[string]any{"promotion": out, "gates": gates})
}

// ---------- Approve / Reject ----------

type decisionRequest struct {
	Note string `json:"note"`
}

func (h *PromotionHandler) loadLocked(ctx context.Context, tx pgx.Tx, tenant, id string) (promotionDTO, error) {
	p, err := scanPromo(tx.QueryRow(ctx, `SELECT `+promoCols+` FROM agent_promotions WHERE id::text=$1 AND tenant_id=$2 FOR UPDATE`, id, tenant))
	if errors.Is(err, pgx.ErrNoRows) {
		return p, errNotFound
	}
	return p, err
}

// Approve handles POST /v1/promotions/{id}/approve. Human owner/admin sessions only.
func (h *PromotionHandler) Approve(w http.ResponseWriter, r *http.Request) {
	ctx, tenant, a, code := h.actorFrom(r)
	if code != 0 {
		writeJSON(w, code, map[string]string{"error": http.StatusText(code)})
		return
	}
	if !a.Admin {
		writeJSON(w, http.StatusForbidden, map[string]string{"code": "human_approval_required",
			"error": "only a human owner/admin session can approve a promotion; API keys and agents cannot"})
		return
	}
	var req decisionRequest
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&req)
	id := r.PathValue("id")
	var out promotionDTO
	var blocked []gateResult
	var blockedP promotionDTO
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		p, err := h.loadLocked(ctx, tx, tenant, id)
		if err != nil {
			return err
		}
		switch p.Status {
		case "canary", "promoted":
			if p.Approver != "" {
				out = p // idempotent replay: already approved and applied
				return nil
			}
			return fmt.Errorf("%w: promotion is %s", errConflict, p.Status)
		case "pending_approval":
		default:
			return fmt.Errorf("%w: promotion is %s", errConflict, p.Status)
		}
		// Gates are re-run at the moment of approval: evidence can go stale or a budget can trip.
		in, err := h.gateInput(ctx, tx, tenant, p.AgentName, p.Env, p.Version)
		if err != nil {
			return err
		}
		if gs := evaluateGates(in); !gatesPass(gs) {
			blocked, blockedP = gs, p
			return nil
		}
		if _, err := tx.Exec(ctx, `UPDATE agent_promotions SET approver=$2, approved_at=now(), decision_note=COALESCE(NULLIF($3,''), decision_note) WHERE id::text=$1`,
			id, a.ID, req.Note); err != nil {
			return err
		}
		if err := h.audit(ctx, tx, tenant, p.AgentName, p.Env, id, a, "approved", map[string]any{"version": p.Version, "note": req.Note}); err != nil {
			return err
		}
		final, err := h.applyPromotion(ctx, tx, tenant, p, a)
		if err != nil {
			return err
		}
		p, err = scanPromo(tx.QueryRow(ctx, `SELECT `+promoCols+` FROM agent_promotions WHERE id::text=$1`, id))
		if err != nil {
			return err
		}
		_ = final
		out = p
		return nil
	})
	if err != nil {
		h.fail(w, err)
		return
	}
	if blocked != nil {
		_ = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
			return h.audit(ctx, tx, tenant, blockedP.AgentName, blockedP.Env, id, a, "approve_blocked", map[string]any{"gates": blocked})
		})
		h.fail(w, &gateErr{blocked})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"promotion": out})
}

// Reject handles POST /v1/promotions/{id}/reject.
func (h *PromotionHandler) Reject(w http.ResponseWriter, r *http.Request) {
	ctx, tenant, a, code := h.actorFrom(r)
	if code != 0 {
		writeJSON(w, code, map[string]string{"error": http.StatusText(code)})
		return
	}
	if !a.Admin {
		writeJSON(w, http.StatusForbidden, map[string]string{"code": "human_approval_required", "error": "only a human owner/admin session can reject a promotion"})
		return
	}
	var req decisionRequest
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&req)
	id := r.PathValue("id")
	var out promotionDTO
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		p, err := h.loadLocked(ctx, tx, tenant, id)
		if err != nil {
			return err
		}
		if p.Status == "rejected" {
			out = p
			return nil
		}
		if p.Status != "pending_approval" {
			return fmt.Errorf("%w: promotion is %s", errConflict, p.Status)
		}
		if _, err := tx.Exec(ctx, `UPDATE agent_promotions SET status='rejected', approver=$2, approved_at=now(), decision_note=NULLIF($3,''), completed_at=now() WHERE id::text=$1`,
			id, a.ID, req.Note); err != nil {
			return err
		}
		if err := h.audit(ctx, tx, tenant, p.AgentName, p.Env, id, a, "rejected", map[string]any{"version": p.Version, "note": req.Note}); err != nil {
			return err
		}
		out, err = scanPromo(tx.QueryRow(ctx, `SELECT `+promoCols+` FROM agent_promotions WHERE id::text=$1`, id))
		return err
	})
	if err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"promotion": out})
}

// ---------- Rollback ----------

type rollbackResult struct {
	AlreadyRolledBack bool   `json:"alreadyRolledBack"`
	Env               string `json:"env"`
	Version           string `json:"version"` // version now serving the env
	PromotionID       string `json:"promotionId"`
	Mode              string `json:"mode"` // canary_aborted | reverted | noop
}

// rollbackTx reverts the newest canary/promoted promotion of (agent, env).
// Idempotent: the promotion row is locked, and a promotion that is already
// rolled_back returns noop without writing an audit row.
func (h *PromotionHandler) rollbackTx(ctx context.Context, tx pgx.Tx, tenant, agent, env string, a promoActor, reason string, detail map[string]any) (rollbackResult, error) {
	res := rollbackResult{Env: env}
	var p promotionDTO
	var err error
	p, err = scanPromo(tx.QueryRow(ctx, `SELECT `+promoCols+` FROM agent_promotions
		WHERE tenant_id=$1 AND agent_name=$2 AND env=$3 AND status IN ('canary','promoted','rolled_back')
		ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, tenant, agent, env))
	if errors.Is(err, pgx.ErrNoRows) {
		return res, fmt.Errorf("%w: nothing to roll back in %s", errConflict, env)
	}
	if err != nil {
		return res, err
	}
	res.PromotionID = p.ID
	var curVer, prevVer, envStatus string
	var expID *string
	if err := tx.QueryRow(ctx, `SELECT version, COALESCE(previous_version,''), status, canary_experiment_id::text
		FROM agent_environments WHERE tenant_id=$1 AND agent_name=$2 AND env=$3 FOR UPDATE`,
		tenant, agent, env).Scan(&curVer, &prevVer, &envStatus, &expID); err != nil {
		return res, err
	}
	res.Version = curVer
	if p.Status == "rolled_back" {
		res.AlreadyRolledBack, res.Mode = true, "noop"
		return res, nil
	}
	d := map[string]any{"reason": reason, "rolledBackVersion": p.Version}
	for k, v := range detail {
		d[k] = v
	}
	switch {
	case p.Status == "canary" && envStatus == "canary":
		if expID != nil {
			if _, err := tx.Exec(ctx, `UPDATE agent_experiments SET status='concluded', winner='a', concluded_at=now() WHERE id::text=$1`, *expID); err != nil {
				return res, err
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE agent_environments SET status='active', canary_experiment_id=NULL, updated_by=$4, updated_at=now()
			WHERE tenant_id=$1 AND agent_name=$2 AND env=$3`, tenant, agent, env, a.ID); err != nil {
			return res, err
		}
		res.Mode = "canary_aborted"
	case p.Status == "promoted":
		if prevVer == "" {
			return res, fmt.Errorf("%w: no previous version recorded for %s", errConflict, env)
		}
		if _, err := tx.Exec(ctx, `UPDATE agent_environments SET version=$4, previous_version=$5, status='active', updated_by=$6, updated_at=now()
			WHERE tenant_id=$1 AND agent_name=$2 AND env=$3`, tenant, agent, env, prevVer, curVer, a.ID); err != nil {
			return res, err
		}
		if env == "prod" {
			if err := syncCurrentVersion(ctx, tx, tenant, agent, prevVer); err != nil {
				return res, err
			}
		}
		res.Version, res.Mode = prevVer, "reverted"
	default:
		return res, fmt.Errorf("%w: promotion is %s", errConflict, p.Status)
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_promotions SET status='rolled_back', completed_at=now() WHERE id::text=$1`, p.ID); err != nil {
		return res, err
	}
	d["mode"], d["servingVersion"] = res.Mode, res.Version
	return res, h.audit(ctx, tx, tenant, agent, env, p.ID, a, "rolled_back", d)
}

// Rollback handles POST /v1/agents/{name}/environments/{env}/rollback.
// Any agents:write principal may roll back: it is the safe direction.
func (h *PromotionHandler) Rollback(w http.ResponseWriter, r *http.Request) {
	ctx, tenant, a, code := h.actorFrom(r)
	if code != 0 {
		writeJSON(w, code, map[string]string{"error": http.StatusText(code)})
		return
	}
	agent, env := r.PathValue("name"), r.PathValue("env")
	if !validPromotionEnv(env) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "env must be sandbox, staging or prod"})
		return
	}
	var req decisionRequest
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&req)
	if req.Note == "" {
		req.Note = "manual rollback"
	}
	var res rollbackResult
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) (err error) {
		res, err = h.rollbackTx(ctx, tx, tenant, agent, env, a, req.Note, nil)
		return err
	})
	if err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// ---------- Canary evaluation ----------

type canaryReport struct {
	Verdict     canaryVerdict   `json:"verdict"`
	Action      string          `json:"action"` // none | rolled_back | completed
	PromotionID string          `json:"promotionId"`
	Candidate   variantStats    `json:"candidate"`
	Stable      variantStats    `json:"stable"`
	Guards      canaryGuards    `json:"guards"`
	Rollback    *rollbackResult `json:"rollback,omitempty"`
}

// EvaluateCanary runs the live guards for the open prod canary of one agent and
// acts on the verdict (rollback on trip, full rollout on pass). Used by the
// endpoint and by the background loop; both are idempotent.
func (h *PromotionHandler) EvaluateCanary(ctx context.Context, tenant, agent string, a promoActor) (*canaryReport, error) {
	var rep *canaryReport
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		p, err := scanPromo(tx.QueryRow(ctx, `SELECT `+promoCols+` FROM agent_promotions
			WHERE tenant_id=$1 AND agent_name=$2 AND env='prod' AND status='canary' FOR UPDATE`, tenant, agent))
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("%w: no canary running", errNotFound)
		}
		if err != nil {
			return err
		}
		var g canaryGuards
		_ = json.Unmarshal(p.Guards, &g)
		g.defaults()
		stats := func(version string) (variantStats, error) {
			var s variantStats
			err := tx.QueryRow(ctx, `
				SELECT count(*) FILTER (WHERE r.status IN ('succeeded','failed')),
				       count(*) FILTER (WHERE r.status = 'failed'),
				       COALESCE(avg(r.cost_usd::float8) FILTER (WHERE r.status IN ('succeeded','failed')), 0)
				FROM runs r JOIN agent_versions av ON av.id = r.agent_version_id JOIN agents a ON a.id = r.agent_id
				WHERE r.tenant_id=$1 AND a.name=$2 AND av.version=$3 AND r.created_at >= $4`,
				tenant, agent, version, p.CreatedAt).Scan(&s.Terminal, &s.Failed, &s.AvgCost)
			return s, err
		}
		var obs canaryObservation
		if obs.Candidate, err = stats(p.Version); err != nil {
			return err
		}
		if obs.Stable, err = stats(p.FromVersion); err != nil {
			return err
		}
		var e evalEvidence
		err = tx.QueryRow(ctx, `SELECT passed, score::float8, created_at FROM eval_runs
			WHERE tenant_id=$1 AND agent_name=$2 AND agent_version=$3 AND source='hermetic' AND created_at >= $4
			ORDER BY created_at DESC LIMIT 1`, tenant, agent, p.Version, p.CreatedAt).Scan(&e.Passed, &e.Score, &e.CreatedAt)
		if err == nil {
			obs.LatestEval = &e
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		v := decideCanary(g, obs)
		rep = &canaryReport{Verdict: v, Action: "none", PromotionID: p.ID, Candidate: obs.Candidate, Stable: obs.Stable, Guards: g}
		switch v.Verdict {
		case "trip":
			rb, err := h.rollbackTx(ctx, tx, tenant, agent, "prod", a, "canary guard tripped",
				map[string]any{"guards": g, "reasons": v.Reasons, "candidate": obs.Candidate, "stable": obs.Stable})
			if err != nil {
				return err
			}
			rep.Action, rep.Rollback = "rolled_back", &rb
		case "pass":
			if _, err := tx.Exec(ctx, `UPDATE agent_experiments SET status='concluded', winner='b', concluded_at=now()
				WHERE id = (SELECT canary_experiment_id FROM agent_environments WHERE tenant_id=$1 AND agent_name=$2 AND env='prod')`, tenant, agent); err != nil {
				return err
			}
			if err := h.audit(ctx, tx, tenant, agent, "prod", p.ID, a, "canary_passed",
				map[string]any{"reasons": v.Reasons, "candidate": obs.Candidate, "stable": obs.Stable}); err != nil {
				return err
			}
			if err := h.fullRollout(ctx, tx, tenant, p, p.FromVersion, a, "promoted"); err != nil {
				return err
			}
			rep.Action = "completed"
		}
		return nil
	})
	return rep, err
}

// EvaluateCanaryHTTP handles POST /v1/agents/{name}/environments/prod/canary/evaluate.
func (h *PromotionHandler) EvaluateCanaryHTTP(w http.ResponseWriter, r *http.Request) {
	ctx, tenant, a, code := h.actorFrom(r)
	if code != 0 {
		writeJSON(w, code, map[string]string{"error": http.StatusText(code)})
		return
	}
	rep, err := h.EvaluateCanary(ctx, tenant, r.PathValue("name"), a)
	if err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

// RunCanaryLoop evaluates every open canary on an interval so a tripped guard
// rolls back without anyone watching. interval<=0 means 30s.
func RunCanaryLoop(ctx context.Context, h *PromotionHandler, interval time.Duration) {
	if interval <= 0 {
		interval = 30 * time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			h.sweepCanaries(ctx)
		}
	}
}

func (h *PromotionHandler) sweepCanaries(ctx context.Context) {
	// rls-exempt: background sweep with no request tenant; discovers (tenant, agent)
	// pairs, then every evaluation runs tenant-scoped via WithTenant.
	rows, err := h.srv.Pool.Query(ctx, `SELECT tenant_id::text, agent_name FROM agent_promotions WHERE status='canary'`)
	if err != nil {
		h.logger().Warn("canary sweep: list failed", zap.Error(err))
		return
	}
	type pair struct{ tenant, agent string }
	var ps []pair
	for rows.Next() {
		var p pair
		if rows.Scan(&p.tenant, &p.agent) == nil {
			ps = append(ps, p)
		}
	}
	rows.Close()
	for _, p := range ps {
		tctx := middleware.InjectTenantID(ctx, p.tenant)
		rep, err := h.EvaluateCanary(tctx, p.tenant, p.agent, promoActor{ID: "canary-guard", Kind: "system"})
		if err != nil {
			h.logger().Warn("canary sweep: evaluate failed", zap.String("agent", p.agent), zap.Error(err))
			continue
		}
		if rep.Action != "none" {
			h.logger().Info("canary decision", zap.String("agent", p.agent), zap.String("action", rep.Action), zap.Strings("reasons", rep.Verdict.Reasons))
		}
	}
}

// ---------- Reads ----------

// ListEnvironments handles GET /v1/agents/{name}/environments.
func (h *PromotionHandler) ListEnvironments(w http.ResponseWriter, r *http.Request) {
	ctx, tenant, _, code := h.actorFrom(r)
	if code != 0 {
		writeJSON(w, code, map[string]string{"error": http.StatusText(code)})
		return
	}
	agent := r.PathValue("name")
	type envDTO struct {
		Env             string          `json:"env"`
		Version         string          `json:"version"`
		PreviousVersion string          `json:"previousVersion,omitempty"`
		Status          string          `json:"status"`
		PromotionID     string          `json:"promotionId,omitempty"`
		CanaryPct       int             `json:"canaryPct,omitempty"`
		LastSandboxRun  json.RawMessage `json:"lastSandboxRun,omitempty"`
		UpdatedBy       string          `json:"updatedBy,omitempty"`
		UpdatedAt       time.Time       `json:"updatedAt"`
	}
	envs := []envDTO{}
	promos := []promotionDTO{}
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT e.env, e.version, COALESCE(e.previous_version,''), e.status, COALESCE(e.promotion_id::text,''),
			       COALESCE(x.traffic_split_b,0), e.last_sandbox_run, COALESCE(e.updated_by,''), e.updated_at
			FROM agent_environments e LEFT JOIN agent_experiments x ON x.id = e.canary_experiment_id
			WHERE e.tenant_id=$1 AND e.agent_name=$2 ORDER BY e.env`, tenant, agent)
		if err != nil {
			return err
		}
		for rows.Next() {
			var e envDTO
			var sr []byte
			if err := rows.Scan(&e.Env, &e.Version, &e.PreviousVersion, &e.Status, &e.PromotionID, &e.CanaryPct, &sr, &e.UpdatedBy, &e.UpdatedAt); err != nil {
				rows.Close()
				return err
			}
			e.LastSandboxRun = sr
			envs = append(envs, e)
		}
		rows.Close()
		prows, err := tx.Query(ctx, `SELECT `+promoCols+` FROM agent_promotions WHERE tenant_id=$1 AND agent_name=$2 ORDER BY created_at DESC LIMIT 20`, tenant, agent)
		if err != nil {
			return err
		}
		defer prows.Close()
		for prows.Next() {
			p, err := scanPromo(prows)
			if err != nil {
				return err
			}
			promos = append(promos, p)
		}
		return prows.Err()
	})
	if err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"agentName": agent, "environments": envs, "promotions": promos})
}

// ListPromotions handles GET /v1/promotions?status=&agentName=.
func (h *PromotionHandler) ListPromotions(w http.ResponseWriter, r *http.Request) {
	ctx, tenant, _, code := h.actorFrom(r)
	if code != 0 {
		writeJSON(w, code, map[string]string{"error": http.StatusText(code)})
		return
	}
	q := r.URL.Query()
	out := []promotionDTO{}
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT `+promoCols+` FROM agent_promotions
			WHERE tenant_id=$1 AND ($2='' OR status=$2) AND ($3='' OR agent_name=$3)
			ORDER BY created_at DESC LIMIT 100`, tenant, q.Get("status"), q.Get("agentName"))
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			p, err := scanPromo(rows)
			if err != nil {
				return err
			}
			out = append(out, p)
		}
		return rows.Err()
	})
	if err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Audit handles GET /v1/promotions/audit?agentName=&limit=.
func (h *PromotionHandler) Audit(w http.ResponseWriter, r *http.Request) {
	ctx, tenant, _, code := h.actorFrom(r)
	if code != 0 {
		writeJSON(w, code, map[string]string{"error": http.StatusText(code)})
		return
	}
	limit := 100
	if n := r.URL.Query().Get("limit"); n != "" {
		if _, err := fmt.Sscanf(n, "%d", &limit); err != nil || limit < 1 || limit > 500 {
			limit = 100
		}
	}
	type row struct {
		ID          int64           `json:"id"`
		AgentName   string          `json:"agentName"`
		Env         string          `json:"env"`
		PromotionID string          `json:"promotionId,omitempty"`
		Action      string          `json:"action"`
		Actor       string          `json:"actor"`
		ActorKind   string          `json:"actorKind"`
		Detail      json.RawMessage `json:"detail"`
		CreatedAt   time.Time       `json:"createdAt"`
	}
	out := []row{}
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT id, agent_name, env, COALESCE(promotion_id::text,''), action, actor, actor_kind, detail, created_at
			FROM agent_promotion_audit WHERE tenant_id=$1 AND ($2='' OR agent_name=$2) ORDER BY id DESC LIMIT $3`,
			tenant, r.URL.Query().Get("agentName"), limit)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var x row
			if err := rows.Scan(&x.ID, &x.AgentName, &x.Env, &x.PromotionID, &x.Action, &x.Actor, &x.ActorKind, &x.Detail, &x.CreatedAt); err != nil {
				return err
			}
			out = append(out, x)
		}
		return rows.Err()
	})
	if err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ---------- Sandbox e2e evidence ----------

type sandboxRunRequest struct {
	Version    string `json:"version"`
	VMID       string `json:"vmId"`
	OK         bool   `json:"ok"`
	ExitCode   int    `json:"exitCode"`
	DurationMs int64  `json:"durationMs"`
	OutputSHA  string `json:"outputSha256"`
	Receipt    string `json:"receipt,omitempty"`
}

// RecordSandboxRun handles POST /v1/agents/{name}/environments/sandbox/runs.
// The VM must belong to the caller's tenant (runtime_vms) and the sandbox must
// currently serve that version, so evidence cannot be attached to a stranger's VM.
func (h *PromotionHandler) RecordSandboxRun(w http.ResponseWriter, r *http.Request) {
	ctx, tenant, a, code := h.actorFrom(r)
	if code != 0 {
		writeJSON(w, code, map[string]string{"error": http.StatusText(code)})
		return
	}
	agent := r.PathValue("name")
	var req sandboxRunRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&req); err != nil || req.VMID == "" || req.Version == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "version and vmId required"})
		return
	}
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM runtime_vms WHERE vm_id=$1 AND tenant_id=$2`, req.VMID, tenant).Scan(&n); err != nil {
			return err
		}
		if n == 0 {
			return errNotFound
		}
		ev, _ := json.Marshal(map[string]any{"ok": req.OK && req.ExitCode == 0, "vmId": req.VMID, "exitCode": req.ExitCode,
			"durationMs": req.DurationMs, "outputSha256": req.OutputSHA, "receipt": req.Receipt, "version": req.Version, "at": time.Now().UTC()})
		tag, err := tx.Exec(ctx, `UPDATE agent_environments SET last_sandbox_run=$4::jsonb, updated_at=now()
			WHERE tenant_id=$1 AND agent_name=$2 AND env='sandbox' AND version=$3`, tenant, agent, req.Version, string(ev))
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return fmt.Errorf("%w: sandbox does not serve version %s; promote it to sandbox first", errConflict, req.Version)
		}
		return h.audit(ctx, tx, tenant, agent, "sandbox", "", a, "sandbox_run",
			map[string]any{"version": req.Version, "vmId": req.VMID, "ok": req.OK && req.ExitCode == 0, "exitCode": req.ExitCode, "durationMs": req.DurationMs})
	})
	if err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "recorded"})
}

// ---------- run routing ----------

// pickPromotedVersion resolves which agent_versions row a new run executes.
// An agent with a prod environment is served from that environment (stable
// version, or the canary split decided by the same FNV-1a bucket as
// PickVariant); an agent that never used environments keeps the legacy
// current_version_id. Any lookup problem falls back to the legacy version:
// routing must never fail a run.
func pickPromotedVersion(ctx context.Context, outer pgx.Tx, tenant, agentID, agentName, runID, legacyVersionID string) (string, map[string]string) {
	// A savepoint: a SQL error here must not abort the caller's transaction.
	tx, err := outer.Begin(ctx)
	if err != nil {
		return legacyVersionID, nil
	}
	defer tx.Rollback(ctx) //nolint:errcheck // read-only; rolling back releases the savepoint
	var stable, status, cand string
	var split int
	err = tx.QueryRow(ctx, `
		SELECT e.version, e.status, COALESCE(x.variant_b_version,''), COALESCE(x.traffic_split_b,0)
		FROM agent_environments e LEFT JOIN agent_experiments x ON x.id = e.canary_experiment_id AND x.status='running'
		WHERE e.tenant_id=$1 AND e.agent_name=$2 AND e.env='prod'`, tenant, agentName).Scan(&stable, &status, &cand, &split)
	if err != nil {
		return legacyVersionID, nil
	}
	version, variant := stable, "stable"
	if status == "canary" && cand != "" && canaryBucket(runID, split) {
		version, variant = cand, "canary"
	}
	var id string
	if err := tx.QueryRow(ctx, `SELECT id::text FROM agent_versions WHERE agent_id=$1 AND version=$2`, agentID, version).Scan(&id); err != nil {
		return legacyVersionID, nil
	}
	return id, map[string]string{"pal.env": "prod", "pal.variant": variant}
}
