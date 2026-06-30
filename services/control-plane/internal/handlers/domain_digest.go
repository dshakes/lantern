package handlers

// DomainDigest — the intelligent "how's my <domain>" rollup behind the bridges'
// domain drill-down (health / vehicle / money / home / career / travel). The
// bridge used to render a hardcoded empty stub ("nothing tracked yet"); this
// reads the owner's REAL per-domain store and LLM-curates it into a next
// obligation + open items + recent activity, with a one-line read on where the
// domain stands. Falls back to a deterministic recency view when the LLM is
// unavailable, so the owner always gets the real records.

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"
)

// domainAlias maps the bridge's spoken domains to the canonical store key.
var domainAlias = map[string]string{
	"car": "vehicle", "finance": "money", "household": "home", "work": "career",
}

// domainDigestJSON is the wire shape the bridge renders via buildDomain.
type domainDigestJSON struct {
	Domain      string   `json:"domain"`
	RecordCount int      `json:"recordCount"`
	Next        string   `json:"next,omitempty"`
	Obligations []string `json:"obligations"`
	Recent      []string `json:"recent"`
}

type domainCand struct {
	line   string // indexed candidate line for the LLM
	render string // hydrated human string the bridge shows
	due    *time.Time
}

// SetLlmProxy enables the intelligent digest (LLM curation). nil → recency view.
func (h *DomainRecordHandler) SetLlmProxy(p *LlmProxyHandler) { h.llmProxy = p }

func (h *DomainRecordHandler) completeFn() researchCompleteFn {
	if h.llmProxy == nil {
		return nil
	}
	return func(ctx context.Context, tenantID, system, user string) (string, error) {
		text, _, _, _, err := h.llmProxy.CompleteInternalWithUsage(ctx, tenantID, system, user)
		return text, err
	}
}

// DomainDigest handles GET /v1/domains/{domain}/digest.
func (h *DomainRecordHandler) DomainDigest(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	domain := strings.ToLower(strings.TrimSpace(r.PathValue("domain")))
	if a, ok := domainAlias[domain]; ok {
		domain = a
	}
	if domain == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "domain required"})
		return
	}

	cands, err := h.gatherDomainCandidates(ctx, tenantID, domain)
	if err != nil {
		h.logger().Error("domain digest gather failed", zap.String("domain", domain), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	out := domainDigestJSON{Domain: domain, RecordCount: len(cands), Obligations: []string{}, Recent: []string{}}
	if len(cands) == 0 {
		writeJSON(w, http.StatusOK, out)
		return
	}

	// INTELLIGENT path: LLM picks the next obligation, open items, and what's
	// worth surfacing — reasoning over the records, not dumping them by date.
	if curated, ok := h.curateDomain(ctx, tenantID, domain, cands); ok {
		writeJSON(w, http.StatusOK, curated)
		return
	}

	// FALLBACK: deterministic — soonest unmet obligation as next, future-dated
	// as obligations, the rest as recent.
	now := time.Now()
	for _, c := range cands {
		if c.due != nil && c.due.After(now) {
			if out.Next == "" {
				out.Next = c.render
			} else if len(out.Obligations) < 5 {
				out.Obligations = append(out.Obligations, c.render)
			}
		} else if len(out.Recent) < 5 {
			out.Recent = append(out.Recent, c.render)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// gatherDomainCandidates pulls the domain's real records. health/vehicle/career/
// travel/home live in domain_records; money lives in finance commitments + bill/
// fraud life-events (there is no "money" domain_records row).
func (h *DomainRecordHandler) gatherDomainCandidates(ctx context.Context, tenantID, domain string) ([]domainCand, error) {
	var cands []domainCand
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		if domain == "money" {
			rows, qErr := tx.Query(ctx, `
				SELECT 'commitment' AS src, COALESCE(title,'') AS title, COALESCE(urgency,'') AS extra, created_at
				FROM commitments
				WHERE tenant_id = $1 AND kind = 'finance' AND status IN ('open','suggested','in_progress')
				UNION ALL
				SELECT 'bill', COALESCE(summary,''), COALESCE(urgency,''), created_at
				FROM life_events
				WHERE tenant_id = $1 AND kind IN ('bill','fraud_alert','receipt')
				  AND created_at >= now() - interval '60 days'
				  AND status NOT IN ('dismissed','undone')
				ORDER BY created_at DESC
				LIMIT 40
			`, tenantID)
			if qErr != nil {
				return qErr
			}
			defer rows.Close()
			i := 0
			for rows.Next() {
				var src, title, extra string
				var created time.Time
				if sErr := rows.Scan(&src, &title, &extra, &created); sErr != nil {
					return sErr
				}
				if strings.TrimSpace(title) == "" {
					continue
				}
				cands = append(cands, domainCand{
					line:   fmt.Sprintf("[%d] %s | %s | %s", i, src, extra, clampRunes(title, 140)),
					render: clampRunes(title, 90),
				})
				i++
			}
			return rows.Err()
		}

		rows, qErr := tx.Query(ctx, `
			SELECT kind, COALESCE(title,''), valid_until, created_at
			FROM domain_records
			WHERE tenant_id = $1 AND domain = $2
			ORDER BY created_at DESC
			LIMIT 60
		`, tenantID, domain)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
		i := 0
		for rows.Next() {
			var kind, title string
			var validUntil *time.Time
			var created time.Time
			if sErr := rows.Scan(&kind, &title, &validUntil, &created); sErr != nil {
				return sErr
			}
			if strings.TrimSpace(title) == "" {
				continue
			}
			due := ""
			if validUntil != nil {
				due = " | due:" + validUntil.Format("2006-01-02")
			}
			cands = append(cands, domainCand{
				line:   fmt.Sprintf("[%d] %s%s | %s", i, kind, due, clampRunes(title, 140)),
				render: clampRunes(title, 90),
				due:    validUntil,
			})
			i++
		}
		return rows.Err()
	})
	return cands, err
}

// curateDomain runs LLMCurate over the candidates and shapes a DomainView.
// Returns (_, false) on any LLM failure so the caller renders the recency view.
func (h *DomainRecordHandler) curateDomain(ctx context.Context, tenantID, domain string, cands []domainCand) (domainDigestJSON, bool) {
	lines := make([]string, len(cands))
	for i, c := range cands {
		lines[i] = c.line
	}
	curated, ok := LLMCurate(ctx, h.completeFn(), tenantID, CurateOpts{
		SystemRole:    "You are a personal chief-of-staff giving the owner a quick, honest read on one life domain (" + domain + "). You reason over their real tracked records — appointments, prescriptions, service logs, bills, milestones — and surface what actually matters.",
		Request:       "Summarize where '" + domain + "' stands for the owner right now. Pick the items worth surfacing. Group each pick as either 'obligation' (something still open / upcoming / needs action) or 'recent' (already happened, FYI). Put the single most important upcoming thing first. Ignore duplicates and noise.",
		ItemLines:     lines,
		MaxPicks:      8,
		GroupNoun:     "bucket",
		ExtraGuidance: "Group values must be exactly 'obligation' or 'recent'. The most important upcoming obligation goes first.",
	})
	if !ok {
		return domainDigestJSON{}, false
	}
	out := domainDigestJSON{
		Domain: domain, RecordCount: len(cands),
		Obligations: []string{}, Recent: []string{},
	}
	for _, p := range curated.Picks {
		if p.I < 0 || p.I >= len(cands) {
			continue
		}
		render := cands[p.I].render // title only — buildDomain clips at ~56 chars
		if strings.Contains(strings.ToLower(p.Group), "oblig") {
			if out.Next == "" {
				out.Next = render
			} else if len(out.Obligations) < 6 {
				out.Obligations = append(out.Obligations, render)
			}
		} else if len(out.Recent) < 6 {
			out.Recent = append(out.Recent, render)
		}
	}
	return out, true
}
