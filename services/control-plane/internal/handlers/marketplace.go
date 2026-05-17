package handlers

// Public agent marketplace — publish, list, star, fork.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// MarketplaceHandler owns /v1/marketplace/*.
type MarketplaceHandler struct {
	srv    *server.Server
	auth   *AuthHandler
	runSvc *RunService // injected to support W11c marketplace.Invoke
	rest   *RESTHandler // for kicking off inline execution after Invoke
}

// NewMarketplaceHandler creates a new marketplace handler.
func NewMarketplaceHandler(srv *server.Server, auth *AuthHandler) *MarketplaceHandler {
	return &MarketplaceHandler{srv: srv, auth: auth}
}

// SetExecutionDeps wires the run service + REST handler after construction
// so the marketplace.Invoke path can kick off a real run on behalf of the
// seller tenant. Optional — if unset, Invoke returns a clear 503.
func (h *MarketplaceHandler) SetExecutionDeps(runSvc *RunService, rest *RESTHandler) {
	h.runSvc = runSvc
	h.rest = rest
}

func (h *MarketplaceHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("marketplace")
}

// ---------- DTOs ----------

type marketplaceAgent struct {
	ID          string         `json:"id"`
	Slug        string         `json:"slug"`
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Category    string         `json:"category"`
	Tags        []string       `json:"tags"`
	Manifest    map[string]any `json:"manifest"`
	Card        map[string]any `json:"card"`
	Readme      string         `json:"readme,omitempty"`
	ForksCount  int            `json:"forksCount"`
	StarsCount  int            `json:"starsCount"`
	Starred     bool           `json:"starred"`
	PublishedAt time.Time      `json:"publishedAt"`
	Author      string         `json:"author"`
}

// ---------- publish ----------

// Publish handles POST /v1/marketplace/publish.
// Body: { agentName, description, category, tags, readme }
// The agent must already exist for the tenant.
func (h *MarketplaceHandler) Publish(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var body struct {
		AgentName   string   `json:"agentName"`
		Description string   `json:"description"`
		Category    string   `json:"category"`
		Tags        []string `json:"tags"`
		Readme      string   `json:"readme"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if body.AgentName == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "agentName required"})
		return
	}
	if body.Category == "" {
		body.Category = "general"
	}

	// Load the agent + tenant slug.
	var agentID, tenantSlug string
	var manifestJSON []byte
	err = h.srv.Pool.QueryRow(ctx, `
		SELECT a.id, t.slug, COALESCE(a.workflow, '{}'::jsonb)
		FROM agents a
		JOIN tenants t ON t.id = a.tenant_id
		WHERE a.tenant_id = $1 AND a.name = $2
	`, tenantID, body.AgentName).Scan(&agentID, &tenantSlug, &manifestJSON)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "agent not found"})
		return
	}

	slug := slugify(fmt.Sprintf("%s-%s", tenantSlug, body.AgentName))
	cardJSON, _ := json.Marshal(map[string]any{
		"name":        body.AgentName,
		"description": body.Description,
		"version":     "1.0.0",
		"provider":    map[string]string{"name": tenantSlug},
	})

	var id string
	err = h.srv.Pool.QueryRow(ctx, `
		INSERT INTO marketplace_agents
		  (slug, source_tenant_id, source_agent_id, name, description, category, tags, manifest, card, readme)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)
		ON CONFLICT (slug) DO UPDATE SET
		  description = EXCLUDED.description,
		  category    = EXCLUDED.category,
		  tags        = EXCLUDED.tags,
		  manifest    = EXCLUDED.manifest,
		  card        = EXCLUDED.card,
		  readme      = EXCLUDED.readme,
		  unpublished_at = NULL
		RETURNING id
	`, slug, tenantID, agentID, body.AgentName, body.Description, body.Category,
		body.Tags, manifestJSON, cardJSON, body.Readme).Scan(&id)
	if err != nil {
		h.logger().Error("publish failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "publish failed"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"id":   id,
		"slug": slug,
		"url":  "/marketplace/" + slug,
	})
}

// Unpublish handles DELETE /v1/marketplace/{slug}.
func (h *MarketplaceHandler) Unpublish(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	slug := r.PathValue("slug")
	_, err = h.srv.Pool.Exec(ctx, `
		UPDATE marketplace_agents SET unpublished_at = now()
		WHERE slug = $1 AND source_tenant_id = $2
	`, slug, tenantID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "unpublished"})
}

// ---------- list ----------

// List handles GET /v1/marketplace.
// Query params: category, tag, q, limit.
func (h *MarketplaceHandler) List(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	category := r.URL.Query().Get("category")
	q := r.URL.Query().Get("q")
	limit := 50

	// Assemble filters with explicit binds.
	sql := `
		SELECT m.id, m.slug, m.name, m.description, m.category, m.tags,
		       m.manifest, m.card, m.forks_count, m.stars_count, m.published_at,
		       t.slug AS author,
		       EXISTS (SELECT 1 FROM marketplace_stars s WHERE s.marketplace_id = m.id AND s.tenant_id = $1) AS starred
		FROM marketplace_agents m
		JOIN tenants t ON t.id = m.source_tenant_id
		WHERE m.unpublished_at IS NULL
	`
	args := []any{tenantID}
	argIdx := 2
	if category != "" {
		sql += fmt.Sprintf(" AND m.category = $%d", argIdx)
		args = append(args, category)
		argIdx++
	}
	if q != "" {
		sql += fmt.Sprintf(" AND (m.name ILIKE $%d OR m.description ILIKE $%d)", argIdx, argIdx)
		args = append(args, "%"+q+"%")
		argIdx++
	}
	sql += fmt.Sprintf(" ORDER BY (m.stars_count * 2 + m.forks_count) DESC, m.published_at DESC LIMIT $%d", argIdx)
	args = append(args, limit)

	rows, err := h.srv.Pool.Query(ctx, sql, args...)
	if err != nil {
		h.logger().Error("list failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}
	defer rows.Close()

	result := make([]marketplaceAgent, 0)
	for rows.Next() {
		var m marketplaceAgent
		var manifestJSON, cardJSON []byte
		if err := rows.Scan(&m.ID, &m.Slug, &m.Name, &m.Description, &m.Category, &m.Tags,
			&manifestJSON, &cardJSON, &m.ForksCount, &m.StarsCount, &m.PublishedAt,
			&m.Author, &m.Starred); err != nil {
			continue
		}
		_ = json.Unmarshal(manifestJSON, &m.Manifest)
		_ = json.Unmarshal(cardJSON, &m.Card)
		result = append(result, m)
	}
	writeJSON(w, http.StatusOK, result)
}

// Get handles GET /v1/marketplace/{slug}.
func (h *MarketplaceHandler) Get(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	slug := r.PathValue("slug")
	var m marketplaceAgent
	var manifestJSON, cardJSON []byte
	err = h.srv.Pool.QueryRow(ctx, `
		SELECT m.id, m.slug, m.name, m.description, m.category, m.tags,
		       m.manifest, m.card, COALESCE(m.readme,''), m.forks_count, m.stars_count, m.published_at,
		       t.slug,
		       EXISTS (SELECT 1 FROM marketplace_stars s WHERE s.marketplace_id = m.id AND s.tenant_id = $2)
		FROM marketplace_agents m
		JOIN tenants t ON t.id = m.source_tenant_id
		WHERE m.slug = $1 AND m.unpublished_at IS NULL
	`, slug, tenantID).Scan(&m.ID, &m.Slug, &m.Name, &m.Description, &m.Category, &m.Tags,
		&manifestJSON, &cardJSON, &m.Readme, &m.ForksCount, &m.StarsCount, &m.PublishedAt,
		&m.Author, &m.Starred)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	_ = json.Unmarshal(manifestJSON, &m.Manifest)
	_ = json.Unmarshal(cardJSON, &m.Card)
	writeJSON(w, http.StatusOK, m)
}

// ---------- fork ----------

// Fork handles POST /v1/marketplace/{slug}/fork.
// Creates a copy of the marketplace agent under the caller's tenant.
func (h *MarketplaceHandler) Fork(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	slug := r.PathValue("slug")

	var body struct {
		NewName string `json:"newName"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	// Load the marketplace entry.
	var mkID, mkName, mkDesc string
	var manifestJSON []byte
	err = h.srv.Pool.QueryRow(ctx, `
		SELECT id, name, description, manifest FROM marketplace_agents
		WHERE slug = $1 AND unpublished_at IS NULL
	`, slug).Scan(&mkID, &mkName, &mkDesc, &manifestJSON)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	name := body.NewName
	if name == "" {
		name = mkName
	}
	name = uniqueAgentName(ctx, h.srv.Pool, tenantID, name)

	// Create the forked agent record.
	var newID string
	tx, err := h.srv.Pool.Begin(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "tx failed"})
		return
	}
	defer tx.Rollback(ctx)

	err = tx.QueryRow(ctx, `
		INSERT INTO agents (tenant_id, name, description, workflow, labels)
		VALUES ($1, $2, $3, $4::jsonb, jsonb_build_object('forkedFrom', $5::text))
		RETURNING id
	`, tenantID, name, mkDesc, manifestJSON, slug).Scan(&newID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "fork failed: " + err.Error()})
		return
	}

	_, err = tx.Exec(ctx, `
		UPDATE marketplace_agents SET forks_count = forks_count + 1 WHERE id = $1
	`, mkID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "fork counter failed"})
		return
	}

	if err := tx.Commit(ctx); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "commit failed"})
		return
	}

	h.logger().Info("fork", zap.String("slug", slug), zap.String("into", name))
	writeJSON(w, http.StatusOK, map[string]string{
		"agentId":   newID,
		"agentName": name,
	})
}

// Star handles POST /v1/marketplace/{slug}/star and DELETE /v1/marketplace/{slug}/star.
func (h *MarketplaceHandler) Star(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	slug := r.PathValue("slug")
	var mkID string
	if err := h.srv.Pool.QueryRow(ctx,
		`SELECT id FROM marketplace_agents WHERE slug = $1 AND unpublished_at IS NULL`,
		slug).Scan(&mkID); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	switch r.Method {
	case http.MethodPost:
		_, _ = h.srv.Pool.Exec(ctx, `
			INSERT INTO marketplace_stars (tenant_id, marketplace_id) VALUES ($1, $2)
			ON CONFLICT DO NOTHING
		`, tenantID, mkID)
		_, _ = h.srv.Pool.Exec(ctx, `
			UPDATE marketplace_agents SET stars_count = (
			  SELECT COUNT(*) FROM marketplace_stars WHERE marketplace_id = $1
			) WHERE id = $1
		`, mkID)
		writeJSON(w, http.StatusOK, map[string]any{"starred": true})
	case http.MethodDelete:
		_, _ = h.srv.Pool.Exec(ctx,
			`DELETE FROM marketplace_stars WHERE tenant_id = $1 AND marketplace_id = $2`,
			tenantID, mkID)
		_, _ = h.srv.Pool.Exec(ctx, `
			UPDATE marketplace_agents SET stars_count = (
			  SELECT COUNT(*) FROM marketplace_stars WHERE marketplace_id = $1
			) WHERE id = $1
		`, mkID)
		writeJSON(w, http.StatusOK, map[string]any{"starred": false})
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

// ---------- helpers ----------

var slugRx = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(s string) string {
	s = strings.ToLower(s)
	s = slugRx.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if s == "" {
		return fmt.Sprintf("agent-%d", time.Now().UnixNano())
	}
	return s
}

// uniqueAgentName picks a name that doesn't collide in this tenant by
// appending a suffix if needed.
func uniqueAgentName(ctx context.Context, pool *pgxpool.Pool, tenantID, base string) string {
	name := base
	for i := 2; i < 100; i++ {
		var exists int
		err := pool.QueryRow(ctx, `SELECT 1 FROM agents WHERE tenant_id = $1 AND name = $2`, tenantID, name).Scan(&exists)
		if err != nil {
			return name
		}
		name = fmt.Sprintf("%s-%d", base, i)
	}
	return fmt.Sprintf("%s-%d", base, time.Now().UnixNano())
}
