package handlers

// errand.go — Errand-runner v1: owner-confirmed outbound AI phone calls.
//
// LEGAL / COMPLIANCE (hard requirements, structurally enforced):
//
//  1. NO call is placed without explicit per-call owner confirm.
//     POST /v1/errands          → propose only (status='proposed', no dial).
//     POST /v1/errands/{id}/confirm-and-call → THE SOLE DIAL PATH.
//
//  2. Every call MUST open with the AI-disclosure + recording-consent preamble.
//     buildDisclosurePreamble() is the single source of truth for those phrases.
//     buildErrandTwiML() always puts that preamble FIRST — no code path produces
//     errand TwiML without it.
//
//  3. Recording consent is inside the same preamble (2-party-consent states).
//
//  4. DNC (Do-Not-Call): checked at propose-time; re-checked atomically at
//     confirm-and-call (same transaction as the status claim).
//     Any number in dnc_numbers → refuse without dialing.
//
//  5. Owner-only gate on confirm-and-call: claims.Role must be "owner" or "admin".
//
//  6. Feature gate: LANTERN_ERRAND must be "1"/"true"/"on"; otherwise 404.
//
// Deferred (not v1):
//   - Real-time conversational AI on the call (voice-worker last mile).
//   - DTMF opt-out during the live call.
//   - Provider status-callback → cost reconciliation.
//   - Budget enforcement for errand call spend.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// ---------- compliance core ----------

// errandAIDisclosureMarker and errandRecordingMarker are the substrings that
// buildDisclosurePreamble always contains. Tests assert their presence so any
// future edit to the preamble text must keep these tokens.
const (
	errandAIDisclosureMarker = "artificial intelligence"
	errandRecordingMarker    = "recorded"
)

// buildDisclosurePreamble returns the AI-disclosure + recording-consent text
// that is ALWAYS the first thing spoken on an errand call (FCC Feb-2024 /
// TCPA). Stored in errands.disclosure_script at propose-time so the owner can
// preview exactly what will be said before confirming.
func buildDisclosurePreamble(ownerName, goal string) string {
	if strings.TrimSpace(ownerName) == "" {
		ownerName = "the owner"
	}
	goalClause := strings.TrimSpace(goal)
	if goalClause == "" {
		goalClause = "a personal errand"
	}
	return fmt.Sprintf(
		"Hello. This is an automated artificial intelligence assistant calling on behalf of %s. "+
			"This call may be recorded for compliance and quality purposes. "+
			"I am not a human. "+
			"The purpose of this call is: %s.",
		ownerName, goalClause,
	)
}

// buildErrandTwiML wraps disclosureScript in TwiML.  The disclosure preamble
// is structurally first — there is no call path that bypasses it.
func buildErrandTwiML(disclosureScript string) string {
	// ponytail: no template dep; disclosureScript is already plain text (ASCII
	// safe characters); escapeTwimlText guards against user-supplied angle brackets.
	return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
		"<Response>\n" +
		"  <Say voice=\"alice\">" + escapeTwimlText(disclosureScript) + "</Say>\n" +
		"  <Pause length=\"2\"/>\n" +
		"  <Say voice=\"alice\">If you wish to be removed from our calling list, please reply to this call's originating number or contact the caller directly. Thank you.</Say>\n" +
		"</Response>"
}

// ---------- feature gate ----------

// errandEnabled reports whether the LANTERN_ERRAND feature flag is on.
func errandEnabled() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("LANTERN_ERRAND")))
	return v == "1" || v == "true" || v == "on"
}

// ---------- outbound dialer ----------

// OutboundDialer places an outbound call and returns the provider call ID.
// Injected at handler construction; tests use a stub; production uses
// connectorDialer (delegates to the Twilio connector's place_call action).
type OutboundDialer interface {
	// PlaceCall initiates an outbound call from `from` to `to` with the
	// given TwiML document. Returns the provider's call ID (Twilio CallSid).
	// twiml must always contain the compliance preamble as the first verb.
	PlaceCall(ctx context.Context, tenantID, from, to, twiml string) (string, error)
}

// connectorDialer is the production OutboundDialer. It calls the Twilio
// connector's place_call action, which resolves credentials from the tenant's
// installed connector_installs row (accountSid + authToken) and calls
// Twilio's REST Calls API.
type connectorDialer struct{ pool connectorExecQuerier }

func (d *connectorDialer) PlaceCall(ctx context.Context, tenantID, from, to, twiml string) (string, error) {
	result, err := executeConnectorAction(ctx, d.pool, tenantID, "twilio", "place_call", map[string]any{
		"to":    to,
		"from":  from,
		"twiml": twiml,
	})
	if err != nil {
		return "", fmt.Errorf("errand place_call: %w", err)
	}
	m, _ := result.(map[string]any)
	sid, _ := m["sid"].(string)
	return sid, nil
}

// ---------- sentinel errors ----------

var (
	errNotProposed = errors.New("errand is not in proposed state")
	errOnDNC       = errors.New("callee number is on the DNC list")
)

// ---------- E.164 validation ----------

// e164Re accepts +<country-code><number>, 8–15 digits total (E.164 range).
var e164Re = regexp.MustCompile(`^\+[1-9]\d{7,14}$`)

func validE164(n string) bool { return e164Re.MatchString(n) }

// ---------- handler ----------

// ErrandHandler provides the REST surface for errand-runner v1.
// All endpoints are gated by LANTERN_ERRAND; confirm-and-call is owner-only.
type ErrandHandler struct {
	srv    *server.Server
	auth   *AuthHandler
	dialer OutboundDialer
}

// NewErrandHandler constructs an ErrandHandler with the production connector
// dialer. Tests replace h.dialer with a stub after construction.
func NewErrandHandler(srv *server.Server, auth *AuthHandler) *ErrandHandler {
	return &ErrandHandler{
		srv:    srv,
		auth:   auth,
		dialer: &connectorDialer{pool: srv.Pool},
	}
}

func (h *ErrandHandler) logger() *zap.Logger { return h.srv.Logger.Named("errand") }

// errandFromNumber resolves the outbound caller-ID to use.  Reads
// LANTERN_TWILIO_NUMBER first (same convention as voice.go / jarvis.go).
// Returns "" when unset; the production Twilio connector will fail cleanly.
func errandFromNumber() string {
	return strings.TrimSpace(os.Getenv("LANTERN_TWILIO_NUMBER"))
}

// ownerNameForTenant returns the owner name for compliance preambles.
// Reads LANTERN_OWNER_NAME (same convention as the bridge layer).
func ownerNameForTenant() string {
	if n := strings.TrimSpace(os.Getenv("LANTERN_OWNER_NAME")); n != "" {
		return n
	}
	return "the owner"
}

// ---------- endpoints ----------

// Propose handles POST /v1/errands.
// Validates the callee number, checks DNC, stores status='proposed'.
// Does NOT dial. Returns {id, disclosurePreview} so the owner can see
// exactly what AI-disclosure text will be spoken before confirming.
func (h *ErrandHandler) Propose(w http.ResponseWriter, r *http.Request) {
	if !errandEnabled() {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "errand feature is not enabled"})
		return
	}

	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var body struct {
		CalleeNumber   string `json:"calleeNumber"`
		CalleeName     string `json:"calleeName"`
		Goal           string `json:"goal"`
		IdempotencyKey string `json:"idempotencyKey"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if body.CalleeNumber == "" || body.Goal == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "calleeNumber and goal are required"})
		return
	}
	if !validE164(body.CalleeNumber) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "calleeNumber must be E.164 (e.g. +15125551234)"})
		return
	}
	body.Goal = clampRunes(body.Goal, 500)
	body.CalleeName = clampRunes(body.CalleeName, 200)

	// DNC check before storing (fast fail).
	var onDNC bool
	if checkErr := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM dnc_numbers WHERE tenant_id=$1 AND number=$2)`,
			tenantID, body.CalleeNumber).Scan(&onDNC)
	}); checkErr != nil {
		h.logger().Error("DNC check failed", zap.Error(checkErr))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if onDNC {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "callee number is on the Do-Not-Call list"})
		return
	}

	disclosure := buildDisclosurePreamble(ownerNameForTenant(), body.Goal)

	var id string
	var idemKey *string
	if body.IdempotencyKey != "" {
		idemKey = &body.IdempotencyKey
	}
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		if idemKey != nil {
			return tx.QueryRow(ctx, `
				INSERT INTO errands
					(tenant_id, callee_number, callee_name, goal, disclosure_script, idempotency_key)
				VALUES ($1, $2, $3, $4, $5, $6)
				ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL
				DO UPDATE SET updated_at = now()
				RETURNING id
			`, tenantID, body.CalleeNumber, body.CalleeName, body.Goal, disclosure, idemKey).Scan(&id)
		}
		return tx.QueryRow(ctx, `
			INSERT INTO errands
				(tenant_id, callee_number, callee_name, goal, disclosure_script)
			VALUES ($1, $2, $3, $4, $5)
			RETURNING id
		`, tenantID, body.CalleeNumber, body.CalleeName, body.Goal, disclosure).Scan(&id)
	})
	if err != nil {
		h.logger().Error("propose errand failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to store errand"})
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"id":                id,
		"disclosurePreview": disclosure,
	})
}

// ConfirmAndCall handles POST /v1/errands/{id}/confirm-and-call.
//
// This is the SOLE dial path. Owner-only.
//
// Atomically claims the errand (UPDATE WHERE status='proposed' RETURNING) so
// concurrent confirms can't double-dial. Re-checks DNC inside the same
// transaction. Builds TwiML with the mandatory compliance preamble first.
// Places the call via OutboundDialer. Marks placed.
func (h *ErrandHandler) ConfirmAndCall(w http.ResponseWriter, r *http.Request) {
	if !errandEnabled() {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "errand feature is not enabled"})
		return
	}

	// Owner/admin gate — the SOLE role check for the dial path.
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if claims.Role != "owner" && claims.Role != "admin" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "owner or admin role required to confirm an errand call"})
		return
	}

	ctx := middleware.InjectTenantID(r.Context(), claims.TenantID)
	tenantID := claims.TenantID
	id := r.PathValue("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id is required"})
		return
	}

	// --- Atomic claim + DNC re-check (single transaction) ---
	var calleeNumber, disclosureScript string
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		// Claim: UPDATE only when status='proposed' — concurrent confirms get 0 rows.
		claimErr := tx.QueryRow(ctx, `
			UPDATE errands
			SET status = 'placed', updated_at = now()
			WHERE id = $1 AND tenant_id = $2 AND status = 'proposed'
			RETURNING callee_number, disclosure_script
		`, id, tenantID).Scan(&calleeNumber, &disclosureScript)
		if errors.Is(claimErr, pgx.ErrNoRows) {
			return errNotProposed // tx rolls back (nothing changed)
		}
		if claimErr != nil {
			return claimErr
		}
		// Defence-in-depth: re-check DNC inside the same tx so claim + DNC
		// check are atomic (a concurrent opt-out can't slip between them).
		var onDNC bool
		if scanErr := tx.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM dnc_numbers WHERE tenant_id=$1 AND number=$2)`,
			tenantID, calleeNumber).Scan(&onDNC); scanErr != nil {
			return fmt.Errorf("DNC recheck: %w", scanErr)
		}
		if onDNC {
			return errOnDNC // tx rolls back → UPDATE is reverted
		}
		return nil
	})
	switch {
	case errors.Is(err, errNotProposed):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "errand is not in proposed state (already placed, failed, or not found)"})
		return
	case errors.Is(err, errOnDNC):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "callee number is on the Do-Not-Call list"})
		return
	case err != nil:
		h.logger().Error("confirm-and-call claim failed", zap.String("id", id), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	// --- Build TwiML: compliance preamble is ALWAYS first ---
	// disclosureScript was set at propose-time from buildDisclosurePreamble;
	// we re-generate from the stored script (not the goal) so the owner
	// always hears exactly what they previewed.
	twiml := buildErrandTwiML(disclosureScript)
	from := errandFromNumber()

	// --- Place call via injected dialer ---
	callSid, dialErr := h.dialer.PlaceCall(ctx, tenantID, from, calleeNumber, twiml)
	if dialErr != nil {
		// Mark failed so the owner knows and can propose a new errand.
		_ = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
			_, _ = tx.Exec(ctx,
				`UPDATE errands SET status='failed', updated_at=now() WHERE id=$1 AND tenant_id=$2`,
				id, tenantID)
			return nil
		})
		h.logger().Error("errand dial failed", zap.String("id", id), zap.Error(dialErr))
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "failed to place call: " + dialErr.Error()})
		return
	}

	// Store provider call ID (best-effort; the call is already placed).
	_ = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		_, _ = tx.Exec(ctx,
			`UPDATE errands SET provider_call_id=$1, updated_at=now() WHERE id=$2 AND tenant_id=$3`,
			callSid, id, tenantID)
		return nil
	})

	h.logger().Info("errand call placed",
		zap.String("id", id), zap.String("callSid", callSid),
		zap.String("to", calleeNumber))

	writeJSON(w, http.StatusOK, map[string]any{
		"id":      id,
		"callSid": callSid,
		"status":  "placed",
	})
}

// OptOut handles POST /v1/errands/{id}/opt-out.
// Adds the errand's callee number to dnc_numbers and marks the errand
// cancelled. This is also the handler for provider opt-out webhooks
// ("stop calling" / "remove me") — the webhook contract is wired here;
// the provider-specific inbound parsing is the last mile.
func (h *ErrandHandler) OptOut(w http.ResponseWriter, r *http.Request) {
	if !errandEnabled() {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "errand feature is not enabled"})
		return
	}

	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	id := r.PathValue("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id is required"})
		return
	}

	var body struct {
		Reason string `json:"reason"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	var calleeNumber string
	var found bool
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		// Fetch the errand's callee number.
		fetchErr := tx.QueryRow(ctx,
			`SELECT callee_number FROM errands WHERE id=$1 AND tenant_id=$2`,
			id, tenantID).Scan(&calleeNumber)
		if errors.Is(fetchErr, pgx.ErrNoRows) {
			return nil // found=false
		}
		if fetchErr != nil {
			return fetchErr
		}
		found = true

		// Add to DNC.
		reason := clampRunes(strings.TrimSpace(body.Reason), 200)
		if reason == "" {
			reason = "opt-out via errand " + id
		}
		_, insErr := tx.Exec(ctx, `
			INSERT INTO dnc_numbers (tenant_id, number, reason)
			VALUES ($1, $2, $3)
			ON CONFLICT (tenant_id, number) DO UPDATE SET reason = EXCLUDED.reason, added_at = now()
		`, tenantID, calleeNumber, reason)
		if insErr != nil {
			return insErr
		}

		// Cancel the errand.
		_, updErr := tx.Exec(ctx,
			`UPDATE errands SET status='cancelled', updated_at=now() WHERE id=$1 AND tenant_id=$2`,
			id, tenantID)
		return updErr
	})
	if err != nil {
		h.logger().Error("opt-out failed", zap.String("id", id), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if !found {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "errand not found"})
		return
	}

	h.logger().Info("errand opt-out: number added to DNC",
		zap.String("id", id), zap.String("number", calleeNumber))

	writeJSON(w, http.StatusOK, map[string]any{
		"id":        id,
		"status":    "cancelled",
		"dncNumber": calleeNumber,
	})
}

// List handles GET /v1/errands?status=&limit=.
func (h *ErrandHandler) List(w http.ResponseWriter, r *http.Request) {
	if !errandEnabled() {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "errand feature is not enabled"})
		return
	}

	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	q := r.URL.Query()
	statusFilter := q.Get("status")
	limit := 50
	if n, convErr := parseInt(q.Get("limit")); convErr == nil && n > 0 {
		if n > 200 {
			n = 200
		}
		limit = n
	}

	type errandRow struct {
		ID               string `json:"id"`
		CalleeNumber     string `json:"calleeNumber"`
		CalleeName       string `json:"calleeName"`
		Goal             string `json:"goal"`
		Status           string `json:"status"`
		DisclosureScript string `json:"disclosureScript"`
		ProviderCallID   string `json:"providerCallId,omitempty"`
		CreatedAt        string `json:"createdAt"`
		UpdatedAt        string `json:"updatedAt"`
	}

	out := make([]errandRow, 0)
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qErr := tx.Query(ctx, `
			SELECT id, callee_number, callee_name, goal, status,
			       disclosure_script, COALESCE(provider_call_id, ''),
			       created_at, updated_at
			FROM errands
			WHERE tenant_id = $1
			  AND ($2 = '' OR status = $2)
			ORDER BY created_at DESC
			LIMIT $3
		`, tenantID, statusFilter, limit)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
		for rows.Next() {
			var row errandRow
			var createdAt, updatedAt time.Time
			if err := rows.Scan(
				&row.ID, &row.CalleeNumber, &row.CalleeName, &row.Goal, &row.Status,
				&row.DisclosureScript, &row.ProviderCallID,
				&createdAt, &updatedAt,
			); err != nil {
				return err
			}
			row.CreatedAt = createdAt.Format(time.RFC3339)
			row.UpdatedAt = updatedAt.Format(time.RFC3339)
			out = append(out, row)
		}
		return rows.Err()
	})
	if err != nil {
		h.logger().Error("list errands failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	writeJSON(w, http.StatusOK, out)
}

// parseInt is a tiny helper (avoids importing strconv; commitments.go uses
// strconv.Atoi directly — we inline the same thing here).
func parseInt(s string) (int, error) {
	if s == "" {
		return 0, fmt.Errorf("empty")
	}
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, fmt.Errorf("not a number")
		}
		n = n*10 + int(c-'0')
	}
	return n, nil
}
