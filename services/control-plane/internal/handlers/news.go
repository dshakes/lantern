package handlers

// news.go — GET /v1/news endpoint for the AI Radar feed.
//
// JWT-authed, tenant-scoped via WithTenant. Returns newest-first ranked
// news_items with full links so the bridge and dashboard can display them.

import (
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

const (
	newsDefaultLimit = 30
	newsMaxLimit     = 100
)

// NewsHandler provides GET /v1/news.
type NewsHandler struct {
	srv  *server.Server
	auth *AuthHandler
}

// NewNewsHandler creates a NewsHandler.
func NewNewsHandler(srv *server.Server, auth *AuthHandler) *NewsHandler {
	return &NewsHandler{srv: srv, auth: auth}
}

func (h *NewsHandler) logger() *zap.Logger { return h.srv.Logger.Named("news") }

// newsItemJSON is the wire shape returned by GET /v1/news.
type newsItemJSON struct {
	Source      string `json:"source"`
	Category    string `json:"category"`
	Title       string `json:"title"`
	URL         string `json:"url"`
	Summary     string `json:"summary,omitempty"`
	Author      string `json:"author,omitempty"`
	Score       int    `json:"score"`
	PublishedAt string `json:"publishedAt,omitempty"`
	CreatedAt   string `json:"createdAt"`
}

// ListNews handles GET /v1/news.
//
// Query params:
//   - ?limit=N   (default 30, cap 100)
//   - ?category= (labs|people|coding-tools|aggregators; empty = all)
func (h *NewsHandler) ListNews(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	// Inject tenant_id into ctx so WithTenant can read it (mirrors contextWithTenant).
	ctx := middleware.InjectTenantID(r.Context(), claims.TenantID)

	q := r.URL.Query()

	limit := newsDefaultLimit
	if v := q.Get("limit"); v != "" {
		if n, convErr := strconv.Atoi(v); convErr == nil && n > 0 {
			limit = n
		}
	}
	if limit > newsMaxLimit {
		limit = newsMaxLimit
	}

	categoryFilter := q.Get("category")

	items := make([]newsItemJSON, 0)
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qErr := tx.Query(ctx, `
			SELECT source, category, title, url,
			       COALESCE(summary, ''),
			       COALESCE(author, ''),
			       score,
			       published_at,
			       created_at
			FROM news_items
			WHERE tenant_id = $1
			  AND ($2 = '' OR category = $2)
			ORDER BY created_at DESC
			LIMIT $3
		`, claims.TenantID, categoryFilter, limit)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
		for rows.Next() {
			var (
				item        newsItemJSON
				publishedAt *time.Time
				createdAt   time.Time
			)
			if scanErr := rows.Scan(
				&item.Source, &item.Category, &item.Title, &item.URL,
				&item.Summary, &item.Author, &item.Score,
				&publishedAt, &createdAt,
			); scanErr != nil {
				return scanErr
			}
			if publishedAt != nil {
				item.PublishedAt = publishedAt.Format(time.RFC3339)
			}
			item.CreatedAt = createdAt.Format(time.RFC3339)
			items = append(items, item)
		}
		return rows.Err()
	})
	if err != nil {
		h.logger().Error("list news failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	writeJSON(w, http.StatusOK, items)
}
