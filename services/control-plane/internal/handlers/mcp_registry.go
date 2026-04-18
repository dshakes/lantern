package handlers

// MCP (Model Context Protocol) server registry.
// Lets tenants browse a curated catalog of MCP servers and attach them to
// agents. Attachments are authoritative: the runtime reads them at dispatch
// time to decide which tool servers to launch.

import (
	"encoding/json"
	"net/http"

	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// MCPHandler exposes the registry and attachment endpoints.
type MCPHandler struct {
	srv  *server.Server
	auth *AuthHandler
}

func NewMCPHandler(srv *server.Server, auth *AuthHandler) *MCPHandler {
	return &MCPHandler{srv: srv, auth: auth}
}

func (h *MCPHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("mcp")
}

type mcpServerDTO struct {
	ID            string         `json:"id"`
	Slug          string         `json:"slug"`
	Name          string         `json:"name"`
	Description   string         `json:"description"`
	Category      string         `json:"category"`
	Transport     string         `json:"transport"`
	URL           string         `json:"url,omitempty"`
	Command       string         `json:"command,omitempty"`
	AuthType      string         `json:"authType"`
	Manifest      map[string]any `json:"manifest"`
	Tags          []string       `json:"tags"`
	Official      bool           `json:"official"`
	InstallsCount int            `json:"installsCount"`
}

// ListServers handles GET /v1/mcp/servers.
func (h *MCPHandler) ListServers(w http.ResponseWriter, r *http.Request) {
	ctx, _, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	category := r.URL.Query().Get("category")
	q := r.URL.Query().Get("q")

	sql := `
		SELECT id, slug, name, description, category, transport,
		       COALESCE(url,''), COALESCE(command,''), auth_type, manifest, tags, official, installs_count
		FROM mcp_servers WHERE 1=1`
	args := []any{}
	idx := 1
	if category != "" {
		sql += ` AND category = $` + itoa(idx)
		args = append(args, category)
		idx++
	}
	if q != "" {
		sql += ` AND (name ILIKE $` + itoa(idx) + ` OR description ILIKE $` + itoa(idx) + `)`
		args = append(args, "%"+q+"%")
		idx++
	}
	sql += ` ORDER BY official DESC, installs_count DESC, name ASC`

	rows, err := h.srv.Pool.Query(ctx, sql, args...)
	if err != nil {
		h.logger().Error("list mcp servers failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}
	defer rows.Close()
	out := make([]mcpServerDTO, 0)
	for rows.Next() {
		var m mcpServerDTO
		var manifestJSON []byte
		if err := rows.Scan(&m.ID, &m.Slug, &m.Name, &m.Description, &m.Category,
			&m.Transport, &m.URL, &m.Command, &m.AuthType, &manifestJSON,
			&m.Tags, &m.Official, &m.InstallsCount); err != nil {
			continue
		}
		_ = json.Unmarshal(manifestJSON, &m.Manifest)
		out = append(out, m)
	}
	writeJSON(w, http.StatusOK, out)
}

// GetServer handles GET /v1/mcp/servers/{slug}.
func (h *MCPHandler) GetServer(w http.ResponseWriter, r *http.Request) {
	ctx, _, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	slug := r.PathValue("slug")
	var m mcpServerDTO
	var manifestJSON []byte
	err = h.srv.Pool.QueryRow(ctx, `
		SELECT id, slug, name, description, category, transport,
		       COALESCE(url,''), COALESCE(command,''), auth_type, manifest, tags, official, installs_count
		FROM mcp_servers WHERE slug = $1
	`, slug).Scan(&m.ID, &m.Slug, &m.Name, &m.Description, &m.Category,
		&m.Transport, &m.URL, &m.Command, &m.AuthType, &manifestJSON,
		&m.Tags, &m.Official, &m.InstallsCount)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	_ = json.Unmarshal(manifestJSON, &m.Manifest)
	writeJSON(w, http.StatusOK, m)
}

type attachRequest struct {
	ServerSlug string         `json:"serverSlug"`
	Config     map[string]any `json:"config"`
}

type attachmentDTO struct {
	ServerSlug  string         `json:"serverSlug"`
	ServerName  string         `json:"serverName"`
	Category    string         `json:"category"`
	Transport   string         `json:"transport"`
	AuthType    string         `json:"authType"`
	Config      map[string]any `json:"config"`
	AttachedAt  string         `json:"attachedAt"`
}

// AttachToAgent handles POST /v1/agents/{name}/mcp-servers.
func (h *MCPHandler) AttachToAgent(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	agentName := r.PathValue("name")
	var body attachRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	var serverID string
	err = h.srv.Pool.QueryRow(ctx,
		`SELECT id FROM mcp_servers WHERE slug = $1`, body.ServerSlug).Scan(&serverID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "mcp server not found"})
		return
	}
	configJSON, _ := json.Marshal(body.Config)
	if len(configJSON) == 0 {
		configJSON = []byte("{}")
	}
	_, err = h.srv.Pool.Exec(ctx, `
		INSERT INTO agent_mcp_attachments (tenant_id, agent_name, mcp_server_id, config)
		VALUES ($1, $2, $3, $4::jsonb)
		ON CONFLICT (tenant_id, agent_name, mcp_server_id) DO UPDATE SET
		  config = EXCLUDED.config,
		  attached_at = now()
	`, tenantID, agentName, serverID, configJSON)
	if err != nil {
		h.logger().Error("attach failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "attach failed"})
		return
	}
	_, _ = h.srv.Pool.Exec(ctx,
		`UPDATE mcp_servers SET installs_count = installs_count + 1 WHERE id = $1`, serverID)
	writeJSON(w, http.StatusOK, map[string]string{"status": "attached"})
}

// ListAttachments handles GET /v1/agents/{name}/mcp-servers.
func (h *MCPHandler) ListAttachments(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	agentName := r.PathValue("name")
	rows, err := h.srv.Pool.Query(ctx, `
		SELECT s.slug, s.name, s.category, s.transport, s.auth_type, a.config, a.attached_at
		FROM agent_mcp_attachments a
		JOIN mcp_servers s ON s.id = a.mcp_server_id
		WHERE a.tenant_id = $1 AND a.agent_name = $2
		ORDER BY a.attached_at DESC
	`, tenantID, agentName)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}
	defer rows.Close()
	out := make([]attachmentDTO, 0)
	for rows.Next() {
		var a attachmentDTO
		var configJSON []byte
		if err := rows.Scan(&a.ServerSlug, &a.ServerName, &a.Category, &a.Transport,
			&a.AuthType, &configJSON, &a.AttachedAt); err != nil {
			continue
		}
		_ = json.Unmarshal(configJSON, &a.Config)
		out = append(out, a)
	}
	writeJSON(w, http.StatusOK, out)
}

// DetachFromAgent handles DELETE /v1/agents/{name}/mcp-servers/{slug}.
func (h *MCPHandler) DetachFromAgent(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	agentName := r.PathValue("name")
	slug := r.PathValue("slug")
	_, err = h.srv.Pool.Exec(ctx, `
		DELETE FROM agent_mcp_attachments
		WHERE tenant_id = $1 AND agent_name = $2
		  AND mcp_server_id = (SELECT id FROM mcp_servers WHERE slug = $3)
	`, tenantID, agentName, slug)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "detached"})
}

// itoa is a tiny helper used for SQL parameter index assembly to avoid pulling
// in strconv for a single-use conversion.
func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	var buf [10]byte
	pos := len(buf)
	for i > 0 {
		pos--
		buf[pos] = byte('0' + i%10)
		i /= 10
	}
	if neg {
		pos--
		buf[pos] = '-'
	}
	return string(buf[pos:])
}
