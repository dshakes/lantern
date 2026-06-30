package handlers

// news_ask.go — POST /v1/news/ask: the INTELLIGENT AI Radar query.
//
// Instead of substring-matching a column, this feeds the owner's natural-
// language request + the importance-scored news corpus to the LLM, which
// REASONS: a person's name => that author; a company => that org; a topic =>
// semantic match; "major/big" => high importance; and it excludes minor version
// bumps / CLI patch releases that bury real news. The LLM picks items BY INDEX
// (never inventing URLs); we hydrate real title/url/date from the corpus.
//
// Best-effort + graceful: any LLM/parse failure falls back to importance-ranked
// items grouped by source, so the endpoint always returns something useful.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
)

type newsCorpusItem struct {
	Source, Category, Title, URL, Summary, Author string
	Score                                         int
	PublishedAt                                   *time.Time
	CreatedAt                                     time.Time
}

func (it newsCorpusItem) date() string {
	if it.PublishedAt != nil {
		return it.PublishedAt.Format("2006-01-02")
	}
	return it.CreatedAt.Format("2006-01-02")
}

type newsAskItem struct {
	Title       string `json:"title"`
	URL         string `json:"url"`
	Source      string `json:"source"`
	Author      string `json:"author,omitempty"`
	Category    string `json:"category,omitempty"`
	PublishedAt string `json:"publishedAt,omitempty"`
	Why         string `json:"why,omitempty"`
	Score       int    `json:"score"`
}

type newsAskGroup struct {
	Company string        `json:"company"`
	Items   []newsAskItem `json:"items"`
}

type newsAskResult struct {
	Interpretation string         `json:"interpretation,omitempty"`
	Note           string         `json:"note,omitempty"`
	Groups         []newsAskGroup `json:"groups"`
}

// AskNews handles POST /v1/news/ask. Body: {"q":"<request>","limit":5}.
func (h *NewsHandler) AskNews(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	ctx := middleware.InjectTenantID(r.Context(), claims.TenantID)

	var body struct {
		Q     string `json:"q"`
		Limit int    `json:"limit"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	q := strings.TrimSpace(body.Q)
	limit := body.Limit
	if limit <= 0 || limit > 15 {
		limit = 5
	}

	corpus := make([]newsCorpusItem, 0, 60)
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qErr := tx.Query(ctx, `
			SELECT source, category, title, url, COALESCE(summary, ''), COALESCE(author, ''),
			       score, published_at, created_at
			FROM news_items
			WHERE tenant_id = $1
			  AND COALESCE(published_at, created_at) >= now() - interval '30 days'
			ORDER BY score DESC NULLS LAST, COALESCE(published_at, created_at) DESC
			LIMIT 60
		`, claims.TenantID)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
		for rows.Next() {
			var it newsCorpusItem
			if scanErr := rows.Scan(&it.Source, &it.Category, &it.Title, &it.URL, &it.Summary,
				&it.Author, &it.Score, &it.PublishedAt, &it.CreatedAt); scanErr != nil {
				return scanErr
			}
			corpus = append(corpus, it)
		}
		return rows.Err()
	})
	if err != nil {
		h.logger().Error("ask news corpus failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	writeJSON(w, http.StatusOK, h.curateNews(ctx, claims.TenantID, q, limit, corpus))
}

// fallbackNews — importance-ranked items grouped by source (no LLM).
func fallbackNews(limit int, corpus []newsCorpusItem) newsAskResult {
	res := newsAskResult{Groups: []newsAskGroup{}}
	order := []string{}
	byCompany := map[string]*newsAskGroup{}
	for _, it := range corpus {
		if len(res.itemCount()) >= limit {
			break
		}
		g, ok := byCompany[it.Source]
		if !ok {
			g = &newsAskGroup{Company: it.Source}
			byCompany[it.Source] = g
			order = append(order, it.Source)
		}
		g.Items = append(g.Items, toAskItem(it, ""))
	}
	for _, s := range order {
		res.Groups = append(res.Groups, *byCompany[s])
	}
	return res
}

func (r newsAskResult) itemCount() []newsAskItem {
	out := []newsAskItem{}
	for _, g := range r.Groups {
		out = append(out, g.Items...)
	}
	return out
}

func toAskItem(it newsCorpusItem, why string) newsAskItem {
	return newsAskItem{
		Title: it.Title, URL: it.URL, Source: it.Source, Author: it.Author,
		Category: it.Category, PublishedAt: it.date(), Why: why, Score: it.Score,
	}
}

func (h *NewsHandler) curateNews(ctx context.Context, tenantID, q string, limit int, corpus []newsCorpusItem) newsAskResult {
	// Build the compact candidate lines, then delegate the actual intelligence
	// to the REUSABLE LLMCurate primitive (shared with every other agent).
	lines := make([]string, len(corpus))
	for i, it := range corpus {
		lines[i] = fmt.Sprintf("[%d] %s | author:%s | cat:%s | score:%d | %s | %s",
			i, clampRunes(it.Source, 30), clampRunes(it.Author, 30), it.Category, it.Score, it.date(), clampRunes(it.Title, 140))
	}
	curated, ok := LLMCurate(ctx, h.completeFn(), tenantID, CurateOpts{
		SystemRole: "You are a world-class AI-news intelligence analyst for a busy AI founder. " +
			"You read recent AI news (each with an importance score 1-100) and surface what truly matters. " +
			"You reason about intent: a person's name means that AUTHOR; a company name means that org; a topic means a semantic match; 'major/big/important/notable' means high importance.",
		Request:       q,
		ItemLines:     lines,
		MaxPicks:      limit,
		GroupNoun:     "company",
		ExtraGuidance: "EXCLUDE noise — minor version bumps, patch releases, routine CLI/SDK updates, and trivial items — UNLESS the owner explicitly asks for them.",
	})
	if !ok {
		return fallbackNews(limit, corpus)
	}

	res := newsAskResult{Interpretation: curated.Interpretation, Note: curated.Note, Groups: []newsAskGroup{}}
	order := []string{}
	byCompany := map[string]*newsAskGroup{}
	for _, p := range curated.Picks {
		it := corpus[p.I] // LLMCurate already validated the index range
		company := strings.TrimSpace(p.Group)
		if company == "" {
			company = it.Source
		}
		g, exists := byCompany[company]
		if !exists {
			g = &newsAskGroup{Company: company}
			byCompany[company] = g
			order = append(order, company)
		}
		g.Items = append(g.Items, toAskItem(it, strings.TrimSpace(p.Why)))
	}
	for _, c := range order {
		res.Groups = append(res.Groups, *byCompany[c])
	}
	if len(res.Groups) == 0 {
		fb := fallbackNews(limit, corpus)
		fb.Interpretation = curated.Interpretation
		fb.Note = curated.Note
		return fb
	}
	return res
}
