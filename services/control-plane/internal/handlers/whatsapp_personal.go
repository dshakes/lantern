package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// WhatsAppPersonalHandler — endpoints supporting the "futuristic"
// personal-assistant upgrades on top of the WhatsApp bridge:
//
//   - VIP contacts: dashboard-managed list of JIDs where auto-send is
//     disabled. Bridge consults this on every reply; if matched, the
//     draft is posted here for human approval rather than sent.
//
//   - Contact facts: durable per-JID notes ("her daughter is Maya",
//     "works at Stripe"). Bridge injects relevant facts into the
//     persona prompt so cold-start conversations don't feel hollow.
//
//   - Pending drafts: append-only audit of VIP drafts + their
//     resolution. Survives bridge restarts. The dashboard renders
//     the pending ones with approve/edit/discard actions.
//
// All endpoints are tenant-scoped via the standard auth middleware.
type WhatsAppPersonalHandler struct {
	srv  *server.Server
	auth *AuthHandler
}

func NewWhatsAppPersonalHandler(srv *server.Server, auth *AuthHandler) *WhatsAppPersonalHandler {
	return &WhatsAppPersonalHandler{srv: srv, auth: auth}
}

func (h *WhatsAppPersonalHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("whatsapp-personal")
}

// ---- VIP contacts ----------------------------------------------------------

type vipBody struct {
	JID         string `json:"jid"`
	DisplayName string `json:"displayName,omitempty"`
}

func (h *WhatsAppPersonalHandler) ListVIPs(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	rows, err := h.srv.Pool.Query(r.Context(),
		`SELECT jid, COALESCE(display_name, '') FROM whatsapp_vip_contacts WHERE tenant_id = $1 ORDER BY added_at ASC`,
		claims.TenantID,
	)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()
	type vipRow struct {
		JID         string `json:"jid"`
		DisplayName string `json:"displayName"`
	}
	out := []vipRow{}
	for rows.Next() {
		var v vipRow
		if err := rows.Scan(&v.JID, &v.DisplayName); err != nil {
			continue
		}
		out = append(out, v)
	}
	writeJSON(w, http.StatusOK, map[string]any{"vips": out})
}

func (h *WhatsAppPersonalHandler) AddVIP(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var body vipBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if strings.TrimSpace(body.JID) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "jid required"})
		return
	}
	if _, err := h.srv.Pool.Exec(r.Context(),
		`INSERT INTO whatsapp_vip_contacts (tenant_id, jid, display_name) VALUES ($1, $2, NULLIF($3, ''))
		 ON CONFLICT (tenant_id, jid) DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, whatsapp_vip_contacts.display_name)`,
		claims.TenantID, body.JID, body.DisplayName,
	); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "added"})
}

func (h *WhatsAppPersonalHandler) RemoveVIP(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	jid := r.URL.Query().Get("jid")
	if jid == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "jid required"})
		return
	}
	if _, err := h.srv.Pool.Exec(r.Context(),
		`DELETE FROM whatsapp_vip_contacts WHERE tenant_id = $1 AND jid = $2`,
		claims.TenantID, jid,
	); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "removed"})
}

// ---- Contact facts ---------------------------------------------------------

type factBody struct {
	JID     string `json:"jid"`
	Content string `json:"content"`
}

func (h *WhatsAppPersonalHandler) ListFacts(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	jid := r.URL.Query().Get("jid")
	if jid == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "jid required"})
		return
	}
	rows, err := h.srv.Pool.Query(r.Context(),
		`SELECT id, content, source, updated_at FROM whatsapp_contact_facts
		 WHERE tenant_id = $1 AND jid = $2 ORDER BY updated_at DESC LIMIT 50`,
		claims.TenantID, jid,
	)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, content, source string
		var updatedAt string
		if err := rows.Scan(&id, &content, &source, &updatedAt); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"id":        id,
			"content":   content,
			"source":    source,
			"updatedAt": updatedAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"facts": out})
}

func (h *WhatsAppPersonalHandler) AddFact(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var body factBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if strings.TrimSpace(body.JID) == "" || strings.TrimSpace(body.Content) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "jid + content required"})
		return
	}
	var id string
	if err := h.srv.Pool.QueryRow(r.Context(),
		`INSERT INTO whatsapp_contact_facts (tenant_id, jid, content, source)
		 VALUES ($1, $2, $3, 'manual') RETURNING id`,
		claims.TenantID, body.JID, body.Content,
	).Scan(&id); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": id})
}

func (h *WhatsAppPersonalHandler) DeleteFact(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	id := r.PathValue("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id required"})
		return
	}
	if _, err := h.srv.Pool.Exec(r.Context(),
		`DELETE FROM whatsapp_contact_facts WHERE tenant_id = $1 AND id = $2`,
		claims.TenantID, id,
	); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// ---- Pending drafts (smart-draft VIP flow) --------------------------------

type draftBody struct {
	JID         string `json:"jid"`
	DisplayName string `json:"displayName"`
	InboundText string `json:"inboundText"`
	DraftText   string `json:"draftText"`
	Channel     string `json:"channel"` // "whatsapp" | "imessage"; default "whatsapp" for back-compat
}

// CreateDraft is called by the bridge when a VIP-flagged contact's
// auto-reply was suppressed and the draft needs human approval. The
// dashboard polls /drafts and renders pending ones.
func (h *WhatsAppPersonalHandler) CreateDraft(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var body draftBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.JID == "" || body.DraftText == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "jid + draftText required"})
		return
	}
	channel := body.Channel
	if channel != "imessage" {
		channel = "whatsapp" // back-compat default
	}
	var id string
	if err := h.srv.Pool.QueryRow(r.Context(),
		`INSERT INTO whatsapp_pending_drafts (tenant_id, jid, display_name, inbound_text, draft_text, channel)
		 VALUES ($1, $2, NULLIF($3, ''), $4, $5, $6) RETURNING id`,
		claims.TenantID, body.JID, body.DisplayName, body.InboundText, body.DraftText, channel,
	).Scan(&id); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "pending"})
}

func (h *WhatsAppPersonalHandler) ListDrafts(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	status := r.URL.Query().Get("status")
	if status == "" {
		status = "pending"
	}
	rows, err := h.srv.Pool.Query(r.Context(),
		`SELECT id, jid, COALESCE(display_name, ''), inbound_text, draft_text, status, COALESCE(final_text, ''), created_at, channel
		 FROM whatsapp_pending_drafts
		 WHERE tenant_id = $1 AND status = $2
		 ORDER BY created_at DESC LIMIT 100`,
		claims.TenantID, status,
	)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, jid, displayName, inbound, draft, st, final, channel string
		var createdAt string
		if err := rows.Scan(&id, &jid, &displayName, &inbound, &draft, &st, &final, &createdAt, &channel); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"id":          id,
			"jid":         jid,
			"displayName": displayName,
			"inboundText": inbound,
			"draftText":   draft,
			"status":      st,
			"finalText":   final,
			"channel":     channel,
			"createdAt":   createdAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"drafts": out})
}

type draftDecisionBody struct {
	Action    string `json:"action"`    // "approve" | "edit" | "discard"
	FinalText string `json:"finalText"` // required for edit; ignored otherwise
}

// ActOnDraft is called by the dashboard when the user approves, edits,
// or discards a pending draft. On approve/edit the control-plane
// POSTs to the bridge's /send endpoint so the chosen text goes out.
func (h *WhatsAppPersonalHandler) ActOnDraft(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	id := r.PathValue("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id required"})
		return
	}
	var body draftDecisionBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}

	// Fetch the draft + JID + channel — we need them to call the right bridge.
	var jid, draftText, channel string
	if err := h.srv.Pool.QueryRow(r.Context(),
		`SELECT jid, draft_text, channel FROM whatsapp_pending_drafts
		 WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`,
		claims.TenantID, id,
	).Scan(&jid, &draftText, &channel); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "draft not found or already resolved"})
		return
	}

	var finalStatus string
	var finalText string
	switch body.Action {
	case "approve":
		finalStatus = "approved"
		finalText = draftText
	case "edit":
		if strings.TrimSpace(body.FinalText) == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "finalText required for edit"})
			return
		}
		finalStatus = "edited"
		finalText = body.FinalText
	case "discard":
		finalStatus = "discarded"
		finalText = ""
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "action must be approve|edit|discard"})
		return
	}

	if _, err := h.srv.Pool.Exec(r.Context(),
		`UPDATE whatsapp_pending_drafts SET status = $1, final_text = NULLIF($2, ''), acted_at = now()
		 WHERE tenant_id = $3 AND id = $4`,
		finalStatus, finalText, claims.TenantID, id,
	); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	// Send via the bridge that queued the draft.
	if finalStatus != "discarded" && finalText != "" {
		if err := deliverViaBridge(channel, claims.TenantID, jid, finalText); err != nil {
			h.logger().Warn("draft send via bridge failed",
				zap.String("draft_id", id),
				zap.String("channel", channel),
				zap.Error(err))
			writeJSON(w, http.StatusOK, map[string]any{
				"status":    finalStatus,
				"sendError": err.Error(),
				"warning":   "draft resolved in DB but bridge send failed",
			})
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": finalStatus})
}
