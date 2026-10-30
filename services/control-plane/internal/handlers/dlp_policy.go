package handlers

// DLP (data-loss prevention) policy REST API — ADR 0030.
//
// Endpoints:
//
//	GET    /v1/egress/dlp-policy                  — list rules for the authed tenant
//	PUT    /v1/egress/dlp-policy                  — replace the full ruleset
//	POST   /v1/egress/dlp-policy/rules            — upsert one rule
//	DELETE /v1/egress/dlp-policy/rules/{ruleId}   — delete one rule
//
// Rules are stored in dlp_policies (tenant_id, rule_id, detector, pattern,
// mode, threshold). The control-plane loads them at schedule time and attaches
// them to AgentSpec.DlpPolicy so the runtime-manager's egress broker can
// compile them (broker egress mode, ADR 0026). A node without a broker refuses
// a policy with a block rule (the spawn fails) and records audit-only rules as
// not enforced.

import (
	"encoding/json"
	"github.com/dshakes/pal/services/control-plane/internal/middleware"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/pal/services/control-plane/internal/server"
)

// DLPPolicyHandler exposes CRUD for the tenant's egress DLP policy.
type DLPPolicyHandler struct {
	srv  *server.Server
	auth *AuthHandler
}

// NewDLPPolicyHandler creates a new DLPPolicyHandler.
func NewDLPPolicyHandler(srv *server.Server, auth *AuthHandler) *DLPPolicyHandler {
	return &DLPPolicyHandler{srv: srv, auth: auth}
}

func (h *DLPPolicyHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("dlp_policy")
}

// ---------- DTOs ----------

// dlpRuleDTO is the REST representation of a single DLP rule.
type dlpRuleDTO struct {
	RuleID    string    `json:"ruleId"`
	Detector  string    `json:"detector"`
	Pattern   string    `json:"pattern,omitempty"`
	Mode      string    `json:"mode"`
	Threshold int       `json:"threshold,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// valid detectors and modes (mirrors the DB CHECK constraints). The
// runtime-manager compiles exactly these names and refuses any other at spawn
// (dlp::DETECTORS); services/testdata/dlp_detectors.json pins the parity.
var (
	validDetectors = map[string]bool{
		"card_number":  true,
		"secret_key":   true,
		"email":        true,
		"phone":        true,
		"custom_regex": true,
	}
	validModes = map[string]bool{
		"off":   true,
		"audit": true,
		"block": true,
	}
)

// ---------- Handlers ----------

// GetPolicy handles GET /v1/egress/dlp-policy.
// Returns the full ordered list of rules for the authed tenant.
func (h *DLPPolicyHandler) GetPolicy(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	ctx := middleware.InjectTenantID(r.Context(), claims.TenantID)

	var rules []dlpRuleDTO
	if dbErr := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qErr := tx.Query(ctx, `
			SELECT rule_id, detector, pattern, mode, threshold, created_at, updated_at
			FROM dlp_policies
			WHERE tenant_id = $1
			ORDER BY created_at, rule_id
		`, claims.TenantID)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
		for rows.Next() {
			var rule dlpRuleDTO
			if sErr := rows.Scan(&rule.RuleID, &rule.Detector, &rule.Pattern, &rule.Mode, &rule.Threshold, &rule.CreatedAt, &rule.UpdatedAt); sErr != nil {
				return sErr
			}
			rules = append(rules, rule)
		}
		return rows.Err()
	}); dbErr != nil {
		h.logger().Error("GetPolicy failed", zap.String("tenant", claims.TenantID), zap.Error(dbErr))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to load DLP policy"})
		return
	}
	if rules == nil {
		rules = []dlpRuleDTO{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"rules": rules})
}

// PutPolicy handles PUT /v1/egress/dlp-policy.
// Replaces the full ruleset atomically (deletes all existing rules, inserts the
// new ones in a single transaction). Body: {"rules": [...]}.
func (h *DLPPolicyHandler) PutPolicy(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var body struct {
		Rules []struct {
			RuleID    string `json:"ruleId"`
			Detector  string `json:"detector"`
			Pattern   string `json:"pattern"`
			Mode      string `json:"mode"`
			Threshold int    `json:"threshold"`
		} `json:"rules"`
	}
	if jsonErr := json.NewDecoder(r.Body).Decode(&body); jsonErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	// Validate rules.
	for i, rule := range body.Rules {
		idx := strconv.Itoa(i)
		if rule.RuleID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "rule[" + idx + "].ruleId is required"})
			return
		}
		if !validDetectors[rule.Detector] {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "rule[" + idx + "].detector must be one of card_number|secret_key|email|phone|custom_regex"})
			return
		}
		if !validModes[rule.Mode] {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "rule[" + idx + "].mode must be one of off|audit|block"})
			return
		}
		if rule.Detector == "custom_regex" && strings.TrimSpace(rule.Pattern) == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "rule[" + idx + "].pattern is required for custom_regex detector"})
			return
		}
		if msg := badDLPPattern(rule.Detector, rule.Pattern); msg != "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "rule[" + idx + "]." + msg})
			return
		}
	}

	ctx := middleware.InjectTenantID(r.Context(), claims.TenantID)
	if dbErr := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		// Delete all existing rules for this tenant, then insert new ones.
		if _, dErr := tx.Exec(ctx, `DELETE FROM dlp_policies WHERE tenant_id = $1`, claims.TenantID); dErr != nil {
			return dErr
		}
		for _, rule := range body.Rules {
			threshold := rule.Threshold
			if threshold < 1 {
				threshold = 1
			}
			if _, iErr := tx.Exec(ctx, `
				INSERT INTO dlp_policies (tenant_id, rule_id, detector, pattern, mode, threshold)
				VALUES ($1, $2, $3, $4, $5, $6)
			`, claims.TenantID, rule.RuleID, rule.Detector, rule.Pattern, rule.Mode, threshold); iErr != nil {
				return iErr
			}
		}
		return nil
	}); dbErr != nil {
		h.logger().Error("PutPolicy failed", zap.String("tenant", claims.TenantID), zap.Error(dbErr))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to save DLP policy"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// UpsertRule handles POST /v1/egress/dlp-policy/rules.
// Inserts or updates a single rule.
func (h *DLPPolicyHandler) UpsertRule(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var rule struct {
		RuleID    string `json:"ruleId"`
		Detector  string `json:"detector"`
		Pattern   string `json:"pattern"`
		Mode      string `json:"mode"`
		Threshold int    `json:"threshold"`
	}
	if jsonErr := json.NewDecoder(r.Body).Decode(&rule); jsonErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if rule.RuleID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "ruleId is required"})
		return
	}
	if !validDetectors[rule.Detector] {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "detector must be one of card_number|secret_key|email|phone|custom_regex"})
		return
	}
	if !validModes[rule.Mode] {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "mode must be one of off|audit|block"})
		return
	}
	if rule.Detector == "custom_regex" && strings.TrimSpace(rule.Pattern) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "pattern is required for custom_regex detector"})
		return
	}
	if msg := badDLPPattern(rule.Detector, rule.Pattern); msg != "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": msg})
		return
	}
	threshold := rule.Threshold
	if threshold < 1 {
		threshold = 1
	}

	ctx := middleware.InjectTenantID(r.Context(), claims.TenantID)
	if dbErr := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		_, iErr := tx.Exec(ctx, `
			INSERT INTO dlp_policies (tenant_id, rule_id, detector, pattern, mode, threshold)
			VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT (tenant_id, rule_id) DO UPDATE
			SET detector  = EXCLUDED.detector,
			    pattern   = EXCLUDED.pattern,
			    mode      = EXCLUDED.mode,
			    threshold = EXCLUDED.threshold,
			    updated_at = now()
		`, claims.TenantID, rule.RuleID, rule.Detector, rule.Pattern, rule.Mode, threshold)
		return iErr
	}); dbErr != nil {
		h.logger().Error("UpsertRule failed", zap.String("tenant", claims.TenantID), zap.Error(dbErr))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to save rule"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// DeleteRule handles DELETE /v1/egress/dlp-policy/rules/{ruleId}.
func (h *DLPPolicyHandler) DeleteRule(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	ruleID := r.PathValue("ruleId")
	if ruleID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "ruleId is required"})
		return
	}

	ctx := middleware.InjectTenantID(r.Context(), claims.TenantID)
	var deleted bool
	if dbErr := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		tag, dErr := tx.Exec(ctx,
			`DELETE FROM dlp_policies WHERE tenant_id = $1 AND rule_id = $2`,
			claims.TenantID, ruleID)
		if dErr != nil {
			return dErr
		}
		deleted = tag.RowsAffected() > 0
		return nil
	}); dbErr != nil {
		h.logger().Error("DeleteRule failed", zap.String("tenant", claims.TenantID), zap.Error(dbErr))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to delete rule"})
		return
	}
	if !deleted {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "rule not found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// badDLPPattern validates a custom_regex pattern at write time, so a typo is a
// 400 now rather than every later spawn failing at the manager's compile (which
// still refuses it — fail closed). Go RE2 and the manager's Rust `regex` share
// RE2 syntax; a pattern using a construct only one side accepts is still
// refused at spawn. Returns "" when valid.
func badDLPPattern(detector, pattern string) string {
	if detector != "custom_regex" {
		return ""
	}
	if _, err := regexp.Compile(pattern); err != nil {
		return "pattern is not a valid regular expression"
	}
	return ""
}
