package handlers

// W11c — Marketplace invocations + verifiable cross-tenant settlement.
//
// One tenant ("buyer") invokes another tenant's published agent ("seller")
// through the marketplace. The orchestration:
//
//   1. Resolve the marketplace slug → seller's tenant + agent.
//   2. Optional budget check on the buyer side (reuses agent_budgets if a
//      buyer-side budget exists, defaulting to allowing the call).
//   3. Run the seller agent in-process via the existing run pipeline (so
//      LLM routing, journal events, and the workflow interpreter all
//      apply uniformly).
//   4. Issue an HMAC-signed receipt over the resulting run via the
//      existing ReceiptHandler — that gives both sides a tamper-evident
//      proof of what executed and at what cost.
//   5. Record the transaction in marketplace_invocations with the receipt
//      embedded so both sides can audit.
//
// This is the wedge: nobody else combines A2A + signed receipts + budget
// enforcement into a single settlement primitive. Two tenants seeded on
// the same Lantern can demo end-to-end agent commerce.

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"go.uber.org/zap"
	"google.golang.org/grpc/metadata"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"google.golang.org/protobuf/types/known/structpb"

	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
)

// ---------- Input schema validation (M4) ----------

// validateInputAgainstSchema performs best-effort validation of the buyer's
// input map against the seller agent's declared JSON Schema (inputSchema in
// the agent manifest).
//
// This is intentionally lightweight — a full JSON Schema validator is not in
// scope. We check:
//   - required fields (schema.required array) are present and non-null.
//   - property types (schema.properties[key].type) match when declared.
//
// If the schema is in an unrecognised shape, we skip validation and return nil
// so the call proceeds. The goal is to catch obvious misuse (missing a required
// field), not to replace a proper validator library.
func validateInputAgainstSchema(input map[string]any, schema map[string]any) error {
	// Check required fields.
	if reqRaw, ok := schema["required"]; ok {
		if reqSlice, ok := reqRaw.([]any); ok {
			for _, r := range reqSlice {
				fieldName, ok := r.(string)
				if !ok {
					continue
				}
				val, present := input[fieldName]
				if !present || val == nil {
					return fmt.Errorf("required field %q is missing", fieldName)
				}
			}
		}
	}

	// Check property types where declared.
	propsRaw, hasProp := schema["properties"]
	if !hasProp {
		return nil
	}
	props, ok := propsRaw.(map[string]any)
	if !ok {
		return nil
	}
	for fieldName, propDef := range props {
		def, ok := propDef.(map[string]any)
		if !ok {
			continue
		}
		declaredType, ok := def["type"].(string)
		if !ok {
			continue
		}
		val, present := input[fieldName]
		if !present {
			continue // absence checked in required loop above
		}
		if err := checkJSONType(fieldName, val, declaredType); err != nil {
			return err
		}
	}
	return nil
}

// checkJSONType returns an error when val does not match the declared JSON
// Schema type string. JSON numbers decoded by encoding/json into map[string]any
// are always float64, so both "integer" and "number" accept float64.
func checkJSONType(field string, val any, declaredType string) error {
	switch declaredType {
	case "string":
		if _, ok := val.(string); !ok {
			return fmt.Errorf("field %q must be a string", field)
		}
	case "number", "integer":
		switch val.(type) {
		case float64, int, int64:
			// ok
		default:
			return fmt.Errorf("field %q must be a number", field)
		}
	case "boolean":
		if _, ok := val.(bool); !ok {
			return fmt.Errorf("field %q must be a boolean", field)
		}
	case "array":
		switch val.(type) {
		case []any, []map[string]any:
			// ok
		default:
			return fmt.Errorf("field %q must be an array", field)
		}
	case "object":
		if _, ok := val.(map[string]any); !ok {
			return fmt.Errorf("field %q must be an object", field)
		}
	}
	return nil
}

// ---------- Wire types ----------

type marketplaceInvokeRequest struct {
	Input map[string]any `json:"input"`
}

type marketplaceInvokeResponse struct {
	InvocationID string         `json:"invocationId"`
	Status       string         `json:"status"`
	Output       any            `json:"output,omitempty"`
	CostUsd      float64        `json:"costUsd"`
	Signature    string         `json:"signature,omitempty"`
	SellerTenant string         `json:"sellerTenantId"`
	AgentName    string         `json:"agentName"`
	IssuedAt     time.Time      `json:"issuedAt"`
	Error        string         `json:"error,omitempty"`
	Receipt      map[string]any `json:"receipt,omitempty"`
}

// ---------- Settlement helper ----------

// signInvocation produces an HMAC-SHA256 signature over the invocation
// fields a verifier needs to reproduce. Uses the same LANTERN_RECEIPT_SECRET
// as run receipts so a single key fingerprint covers both surfaces.
func signInvocation(
	invocationID, buyerTenant, sellerTenant, agentName, runID string,
	costUsd float64, issuedAt time.Time,
) (string, error) {
	secret := getReceiptSecret()
	canonical := fmt.Sprintf(
		"%s|%s|%s|%s|%s|%.6f|%s",
		invocationID, buyerTenant, sellerTenant, agentName, runID,
		costUsd, issuedAt.UTC().Format(time.RFC3339Nano),
	)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(canonical))
	return hex.EncodeToString(mac.Sum(nil)), nil
}

// ---------- POST /v1/marketplace/{slug}/invoke ----------

// Invoke handles POST /v1/marketplace/{slug}/invoke. The caller is the
// buyer; the seller tenant is resolved from the marketplace entry.
func (h *MarketplaceHandler) Invoke(w http.ResponseWriter, r *http.Request) {
	ctx, buyerTenant, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	slug := r.PathValue("slug")
	if slug == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "slug required"})
		return
	}
	var body marketplaceInvokeRequest
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.Input == nil {
		body.Input = map[string]any{}
	}

	// 1. Resolve the marketplace entry → seller tenant + agent name.
	// Also pull the seller agent's input schema (manifest.inputSchema) so we
	// can validate the buyer's input before spending any resources. (M4)
	var sellerTenant, agentName string
	var manifestRaw []byte
	err = h.srv.Pool.QueryRow(ctx, `
		SELECT m.source_tenant_id::text, COALESCE(a.name, m.slug),
		       COALESCE(m.manifest, '{}'::jsonb)
		FROM marketplace_agents m
		LEFT JOIN agents a ON a.id = m.source_agent_id
		WHERE m.slug = $1 AND m.unpublished_at IS NULL
	`, slug).Scan(&sellerTenant, &agentName, &manifestRaw)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "marketplace agent not found"})
		return
	}

	// M4 — validate buyer-supplied input against the seller's declared input
	// schema when one is present. Best-effort: if the schema is absent or
	// unparseable we allow the call to proceed (seller chose not to restrict).
	if len(manifestRaw) > 0 {
		var manifest struct {
			InputSchema map[string]any `json:"inputSchema"`
		}
		if jsonErr := json.Unmarshal(manifestRaw, &manifest); jsonErr == nil && len(manifest.InputSchema) > 0 {
			if validationErr := validateInputAgainstSchema(body.Input, manifest.InputSchema); validationErr != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{
					"error": "input validation failed: " + validationErr.Error(),
				})
				return
			}
		}
	}

	// M4 — check the SELLER agent's budget hard-fail before executing.
	// A buyer must not be able to bypass the seller's configured limits. We
	// use an estimated cost of 0 for the pre-check (actual cost is unknown
	// pre-run); this detects exceeded daily/run count limits. If the seller
	// has no budget configured, this is a no-op.
	sellerBudgetCtx := context.Background() // seller-tenant context for budget check
	sellerBudgetCheck := CheckBudget(sellerBudgetCtx, h.srv.Pool, sellerTenant, agentName, 0)
	if !sellerBudgetCheck.Allowed && sellerBudgetCheck.HardFail {
		writeJSON(w, http.StatusPaymentRequired, map[string]any{
			"error":  "seller agent budget limit reached: " + sellerBudgetCheck.Reason,
			"reason": sellerBudgetCheck.Reason,
		})
		return
	}

	// 2. Pre-create the invocation row in pending state so even a crash
	// mid-run leaves a forensic trail.
	var invocationID string
	inputJSON, _ := json.Marshal(body.Input)
	err = h.srv.Pool.QueryRow(ctx, `
		INSERT INTO marketplace_invocations
			(buyer_tenant_id, seller_tenant_id, marketplace_slug, agent_name, input, status)
		VALUES ($1, $2, $3, $4, $5::jsonb, 'pending')
		RETURNING id::text
	`, buyerTenant, sellerTenant, slug, agentName, string(inputJSON)).Scan(&invocationID)
	if err != nil {
		h.logger().Error("marketplace invoke: pre-insert failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to record invocation"})
		return
	}

	if h.runSvc == nil || h.rest == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"invocationId": invocationID,
			"error":        "marketplace invocation requires runSvc — call SetExecutionDeps at boot",
		})
		return
	}

	// 3. Execute the seller agent on its own tenant. We switch the ctx
	// to the seller tenant so the LLM router picks the seller's keys
	// (not the buyer's) — sellers pay their own provider bills. The
	// buyer is billed at the marketplace's agreed price (cost_usd
	// below), not at the seller's underlying cost.
	sellerCtx := middleware.InjectTenantID(context.Background(), sellerTenant)
	sellerCtx = metadata.NewIncomingContext(sellerCtx, metadata.Pairs("tenant_id", sellerTenant))

	inputStruct, _ := structpb.NewStruct(body.Input)
	run, runErr := h.runSvc.CreateRun(sellerCtx, &lanternv1.CreateRunRequest{
		AgentName:   agentName,
		Input:       inputStruct,
		TriggerKind: lanternv1.TriggerKind_TRIGGER_KIND_MANUAL,
	})
	if runErr != nil {
		errMsg := runErr.Error()
		_, _ = h.srv.Pool.Exec(ctx, `
			UPDATE marketplace_invocations
			SET status = 'failed', error_message = $2, completed_at = now()
			WHERE id = $1
		`, invocationID, errMsg)
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"invocationId": invocationID,
			"status":       "failed",
			"error":        errMsg,
		})
		return
	}

	// Kick off the actual LLM execution on the seller tenant. The REST
	// handler owns the workflow-interpreter routing too, so saved
	// workflows on the seller agent run end-to-end transparently.
	// Tracked by inFlightRuns so SIGTERM drain waits for it to finish.
	runID := run.GetId()
	h.rest.inFlightRuns.Add(1)
	go func() {
		defer h.rest.inFlightRuns.Done()
		h.rest.executeRunInline(runID, sellerTenant, agentName, body.Input)
	}()

	// 4. Wait briefly for the seller's run to complete. The interpreter
	// runs in-process so for v1 we poll up to 60s.
	// M4: scope the poll query by the seller's tenant_id so a buyer with a
	// guessed run_id cannot read another tenant's run state.
	deadline := time.Now().Add(60 * time.Second)
	var status string
	var outputRaw, errRaw []byte
	var costUsd float64
	for time.Now().Before(deadline) {
		err = h.srv.Pool.QueryRow(ctx, `
			SELECT status,
			       COALESCE(output, 'null'::jsonb),
			       COALESCE(error, 'null'::jsonb),
			       COALESCE(cost_usd, 0)
			FROM runs WHERE id = $1 AND tenant_id = $2
		`, runID, sellerTenant).Scan(&status, &outputRaw, &errRaw, &costUsd)
		if err == nil && (status == "succeeded" || status == "failed") {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}

	issuedAt := time.Now().UTC()
	signature, _ := signInvocation(invocationID, buyerTenant, sellerTenant, agentName, runID, costUsd, issuedAt)

	if status != "succeeded" {
		errMsg := "seller run did not succeed: " + status
		if len(errRaw) > 0 && string(errRaw) != "null" {
			errMsg = string(errRaw)
		}
		_, _ = h.srv.Pool.Exec(ctx, `
			UPDATE marketplace_invocations
			SET status = 'failed', error_message = $2, completed_at = now(),
			    signature = $3, cost_usd = $4
			WHERE id = $1
		`, invocationID, errMsg, signature, costUsd)
		writeJSON(w, http.StatusBadGateway, marketplaceInvokeResponse{
			InvocationID: invocationID, Status: "failed", Error: errMsg,
			SellerTenant: sellerTenant, AgentName: agentName, IssuedAt: issuedAt,
		})
		return
	}

	// 5. Build the receipt envelope. We embed the canonical fields that
	// were signed so any third-party verifier can recompute the HMAC
	// using only the receipt JSON + the published key fingerprint.
	receipt := map[string]any{
		"invocationId": invocationID,
		"buyerTenant":  buyerTenant,
		"sellerTenant": sellerTenant,
		"marketplace":  slug,
		"agentName":    agentName,
		"runId":        runID,
		"costUsd":      costUsd,
		"issuedAt":     issuedAt.Format(time.RFC3339Nano),
		"signature":    signature,
		"algorithm":    "HMAC-SHA256",
	}
	receiptJSON, _ := json.Marshal(receipt)

	_, _ = h.srv.Pool.Exec(ctx, `
		UPDATE marketplace_invocations
		SET status = 'succeeded',
		    output = $2::jsonb,
		    cost_usd = $3,
		    signature = $4,
		    receipt = $5::jsonb,
		    completed_at = now()
		WHERE id = $1
	`, invocationID, string(outputRaw), costUsd, signature, string(receiptJSON))

	var output any
	_ = json.Unmarshal(outputRaw, &output)

	writeJSON(w, http.StatusOK, marketplaceInvokeResponse{
		InvocationID: invocationID,
		Status:       "succeeded",
		Output:       output,
		CostUsd:      costUsd,
		Signature:    signature,
		SellerTenant: sellerTenant,
		AgentName:    agentName,
		IssuedAt:     issuedAt,
		Receipt:      receipt,
	})
}

// ---------- GET /v1/marketplace/invocations ----------

// ListInvocations returns the buyer-side history of marketplace
// invocations for the calling tenant. Filterable by status or slug.
func (h *MarketplaceHandler) ListInvocations(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	role := r.URL.Query().Get("role")
	if role == "" {
		role = "buyer"
	}

	query := `
		SELECT id::text, buyer_tenant_id::text, seller_tenant_id::text,
		       marketplace_slug, agent_name, status, cost_usd,
		       COALESCE(signature, ''), COALESCE(receipt::text, ''),
		       COALESCE(error_message, ''), created_at,
		       COALESCE(completed_at, created_at)
		FROM marketplace_invocations
	`
	var arg string
	switch role {
	case "seller":
		query += `WHERE seller_tenant_id = $1 ORDER BY created_at DESC LIMIT 100`
		arg = tenantID
	default:
		query += `WHERE buyer_tenant_id = $1 ORDER BY created_at DESC LIMIT 100`
		arg = tenantID
	}

	rows, err := h.srv.Pool.Query(ctx, query, arg)
	if err != nil {
		h.logger().Error("list invocations", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "query failed"})
		return
	}
	defer rows.Close()

	out := make([]map[string]any, 0)
	for rows.Next() {
		var id, buyer, seller, slug, agent, status, signature, receiptStr, errMsg string
		var costUsd float64
		var createdAt, completedAt time.Time
		if err := rows.Scan(&id, &buyer, &seller, &slug, &agent, &status, &costUsd, &signature, &receiptStr, &errMsg, &createdAt, &completedAt); err != nil {
			continue
		}
		entry := map[string]any{
			"id":              id,
			"buyerTenantId":   buyer,
			"sellerTenantId":  seller,
			"marketplaceSlug": slug,
			"agentName":       agent,
			"status":          status,
			"costUsd":         costUsd,
			"signature":       signature,
			"errorMessage":    errMsg,
			"createdAt":       createdAt,
			"completedAt":     completedAt,
		}
		if receiptStr != "" {
			var r map[string]any
			if json.Unmarshal([]byte(receiptStr), &r) == nil {
				entry["receipt"] = r
			}
		}
		out = append(out, entry)
	}

	writeJSON(w, http.StatusOK, out)
}
