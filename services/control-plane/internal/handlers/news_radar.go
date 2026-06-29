package handlers

// news_radar.go — loop body for the news_radar role.
//
// runNewsRadar polls all registered newsSources concurrently (bounded to 8
// workers, 8 s per-source), parses RSS/Atom/GitHub/HN/Reddit responses,
// deduplicates against news_items via ON CONFLICT DO NOTHING, runs an optional
// LLM ranking pass on new items, and emits a news_swept journal event.
//
// The httpGet seam is injectable so tests never hit the live network.

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

// ---------- HTTP seam ----------

// newsHTTPGetFn is an injectable HTTP GET function.
// Default: defaultNewsHTTPGet (real network). Tests inject canned responses.
type newsHTTPGetFn func(ctx context.Context, url string) ([]byte, error)

// newsHTTPClient is the shared client for the default fetch path.
// ponytail: single shared client; per-source timeout via request context.
var newsHTTPClient = &http.Client{Timeout: 30 * time.Second}

func defaultNewsHTTPGet(ctx context.Context, rawURL string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, fmt.Errorf("news: http.NewRequest: %w", err)
	}
	req.Header.Set("User-Agent", "Lantern-AIRadar/1.0 (+https://lantern.dev)")
	resp, err := newsHTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("news: http.Do: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("news: HTTP %d from %s", resp.StatusCode, rawURL)
	}
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20)) // 1 MB cap
	if readErr != nil {
		return nil, fmt.Errorf("news: read body: %w", readErr)
	}
	return body, nil
}

// ---------- Candidate item type ----------

// newsCandidate is an item collected from a source before DB insert.
type newsCandidate struct {
	Source      string
	Category    string
	Title       string
	URL         string
	Summary     string
	Author      string
	Score       int
	PublishedAt *time.Time
}

// ---------- XML structs: RSS 2.0 ----------

type rssRoot struct {
	Channel rssChannel `xml:"channel"`
}

type rssChannel struct {
	Items []rssItem `xml:"item"`
}

type rssItem struct {
	Title   string `xml:"title"`
	Link    string `xml:"link"`
	PubDate string `xml:"pubDate"`
	Author  string `xml:"author"`
	Creator string `xml:"creator"` // dc:creator common alternative
	Desc    string `xml:"description"`
	GUID    string `xml:"guid"`
}

// ---------- XML structs: Atom 1.0 ----------

type atomFeed struct {
	Entries []atomEntry `xml:"entry"`
}

type atomEntry struct {
	Title   atomText   `xml:"title"`
	Links   []atomLink `xml:"link"`
	Updated string     `xml:"updated"`
	Author  atomAuthor `xml:"author"`
	Summary atomText   `xml:"summary"`
	Content atomText   `xml:"content"`
	ID      string     `xml:"id"`
}

type atomLink struct {
	Href string `xml:"href,attr"`
	Rel  string `xml:"rel,attr"`
	Type string `xml:"type,attr"`
}

type atomAuthor struct {
	Name string `xml:"name"`
}

type atomText struct {
	Text string `xml:",chardata"`
}

// ---------- RSS/Atom parsers ----------

// parseRSS decodes an RSS 2.0 feed body into newsCandidate items.
func parseRSS(body []byte, src newsSource) []newsCandidate {
	var feed rssRoot
	if err := xml.NewDecoder(bytes.NewReader(body)).Decode(&feed); err != nil {
		return nil
	}
	out := make([]newsCandidate, 0, len(feed.Channel.Items))
	for _, item := range feed.Channel.Items {
		u := strings.TrimSpace(item.Link)
		if u == "" {
			u = strings.TrimSpace(item.GUID)
		}
		if u == "" || strings.TrimSpace(item.Title) == "" {
			continue
		}
		c := newsCandidate{
			Source:   src.Name,
			Category: src.Category,
			Title:    clampRunes(strings.TrimSpace(item.Title), 500),
			URL:      u,
			Summary:  clampRunes(strings.TrimSpace(item.Desc), 400),
		}
		if item.Author != "" {
			c.Author = clampRunes(strings.TrimSpace(item.Author), 200)
		} else if item.Creator != "" {
			c.Author = clampRunes(strings.TrimSpace(item.Creator), 200)
		}
		if t, err := parseNewsTime(item.PubDate); err == nil {
			c.PublishedAt = &t
		}
		out = append(out, c)
	}
	return out
}

// parseAtom decodes an Atom 1.0 feed (includes GitHub releases.atom) into
// newsCandidate items.
func parseAtom(body []byte, src newsSource) []newsCandidate {
	var feed atomFeed
	if err := xml.NewDecoder(bytes.NewReader(body)).Decode(&feed); err != nil {
		return nil
	}
	out := make([]newsCandidate, 0, len(feed.Entries))
	for _, entry := range feed.Entries {
		title := strings.TrimSpace(entry.Title.Text)
		if title == "" {
			continue
		}
		// Pick the ARTICLE link, not the feed/self link. Priority:
		//   1. rel="alternate" type="text/html" (the canonical article page)
		//   2. any rel="alternate"
		//   3. an untyped <link> (many feeds use a bare link = the article)
		//   4. any link that isn't self/replies/edit (feed-internal rels)
		// NEVER fall back to rel="self" (that's the Atom feed/API URL — the
		// blogger.com/feeds/… bug). entry.ID is a last resort (often the URL).
		var altHTML, alt, untyped, other string
		for _, l := range entry.Links {
			href := strings.TrimSpace(l.Href)
			if href == "" {
				continue
			}
			switch {
			case l.Rel == "alternate" && (l.Type == "text/html" || l.Type == ""):
				if altHTML == "" {
					altHTML = href
				}
			case l.Rel == "alternate":
				if alt == "" {
					alt = href
				}
			case l.Rel == "":
				if untyped == "" {
					untyped = href
				}
			case l.Rel != "self" && l.Rel != "replies" && l.Rel != "edit" && l.Rel != "edit-media":
				if other == "" {
					other = href
				}
			}
		}
		u := ""
		switch {
		case altHTML != "":
			u = altHTML
		case alt != "":
			u = alt
		case untyped != "":
			u = untyped
		case other != "":
			u = other
		default:
			u = strings.TrimSpace(entry.ID) // last resort; filtered below if not http
		}
		if u == "" || !strings.HasPrefix(u, "http") {
			continue
		}
		sumText := strings.TrimSpace(entry.Summary.Text)
		if sumText == "" {
			sumText = strings.TrimSpace(entry.Content.Text)
		}
		c := newsCandidate{
			Source:   src.Name,
			Category: src.Category,
			Title:    clampRunes(title, 500),
			URL:      u,
			Summary:  clampRunes(sumText, 400),
			Author:   clampRunes(strings.TrimSpace(entry.Author.Name), 200),
		}
		if t, err := parseNewsTime(entry.Updated); err == nil {
			c.PublishedAt = &t
		}
		out = append(out, c)
	}
	return out
}

// parseNewsTime tries a set of common date formats used by RSS and Atom feeds.
func parseNewsTime(s string) (time.Time, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, fmt.Errorf("empty")
	}
	formats := []string{
		time.RFC1123Z,                    // RSS: "Mon, 02 Jan 2006 15:04:05 -0700"
		time.RFC1123,                     // RSS: "Mon, 02 Jan 2006 15:04:05 MST"
		time.RFC3339,                     // Atom: "2006-01-02T15:04:05Z07:00"
		"2006-01-02T15:04:05Z",           // Atom subset
		"2006-01-02T15:04:05.000Z",       // Atom with ms
		"Mon, 2 Jan 2006 15:04:05 -0700", // Some RSS feeds omit leading zero
	}
	for _, f := range formats {
		if t, err := time.Parse(f, s); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("unrecognised date: %q", s)
}

// ---------- GitHub search API parser ----------

// parseGitHubSearch decodes the GitHub repository search API JSON.
// Produces one item per repo: title = "owner/repo", url = html_url,
// score = stargazers_count.
func parseGitHubSearch(body []byte, src newsSource) []newsCandidate {
	var result struct {
		Items []struct {
			FullName    string `json:"full_name"`
			Description string `json:"description"`
			HTMLURL     string `json:"html_url"`
			Stars       int    `json:"stargazers_count"`
			PushedAt    string `json:"pushed_at"`
			Owner       struct {
				Login string `json:"login"`
			} `json:"owner"`
		} `json:"items"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil
	}
	out := make([]newsCandidate, 0, len(result.Items))
	for _, item := range result.Items {
		if item.HTMLURL == "" || item.FullName == "" {
			continue
		}
		c := newsCandidate{
			Source:   src.Name,
			Category: src.Category,
			Title:    clampRunes(item.FullName, 500),
			URL:      item.HTMLURL,
			Summary:  clampRunes(item.Description, 400),
			Score:    item.Stars,
		}
		if t, err := parseNewsTime(item.PushedAt); err == nil {
			c.PublishedAt = &t
		}
		out = append(out, c)
	}
	return out
}

// ---------- HN Algolia parser ----------

// parseHNAlgolia decodes the HN Algolia search API response.
// score = HN points.
func parseHNAlgolia(body []byte, src newsSource) []newsCandidate {
	var result struct {
		Hits []struct {
			Title     string `json:"title"`
			URL       string `json:"url"`
			Points    int    `json:"points"`
			Author    string `json:"author"`
			CreatedAt string `json:"created_at"`
			ObjectID  string `json:"objectID"`
		} `json:"hits"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil
	}
	out := make([]newsCandidate, 0, len(result.Hits))
	for _, hit := range result.Hits {
		u := strings.TrimSpace(hit.URL)
		if u == "" {
			// self-post: link to HN thread
			u = "https://news.ycombinator.com/item?id=" + hit.ObjectID
		}
		title := strings.TrimSpace(hit.Title)
		if title == "" || u == "" {
			continue
		}
		c := newsCandidate{
			Source:   src.Name,
			Category: src.Category,
			Title:    clampRunes(title, 500),
			URL:      u,
			Author:   clampRunes(hit.Author, 200),
			Score:    hit.Points,
		}
		if t, err := parseNewsTime(hit.CreatedAt); err == nil {
			c.PublishedAt = &t
		}
		out = append(out, c)
	}
	return out
}

// ---------- Reddit JSON parser ----------

// parseRedditJSON decodes the Reddit listing JSON API (.json endpoint).
// score = Reddit score (ups − downs).
func parseRedditJSON(body []byte, src newsSource) []newsCandidate {
	var listing struct {
		Data struct {
			Children []struct {
				Data struct {
					Title     string  `json:"title"`
					URL       string  `json:"url"`
					Permalink string  `json:"permalink"`
					Score     int     `json:"score"`
					Author    string  `json:"author"`
					Created   float64 `json:"created_utc"`
					Selftext  string  `json:"selftext"`
				} `json:"data"`
			} `json:"children"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &listing); err != nil {
		return nil
	}
	out := make([]newsCandidate, 0, len(listing.Data.Children))
	for _, child := range listing.Data.Children {
		d := child.Data
		title := strings.TrimSpace(d.Title)
		u := strings.TrimSpace(d.URL)
		if u == "" {
			u = "https://www.reddit.com" + d.Permalink
		}
		if title == "" || u == "" {
			continue
		}
		snippet := clampRunes(strings.TrimSpace(d.Selftext), 400)
		c := newsCandidate{
			Source:   src.Name,
			Category: src.Category,
			Title:    clampRunes(title, 500),
			URL:      u,
			Summary:  snippet,
			Author:   clampRunes(d.Author, 200),
			Score:    d.Score,
		}
		if d.Created > 0 {
			t := time.Unix(int64(d.Created), 0).UTC()
			c.PublishedAt = &t
		}
		out = append(out, c)
	}
	return out
}

// ---------- fetchSource: per-source fetch + parse ----------

// fetchSource fetches one source and returns parsed candidates.
// Dead/blocked sources return (nil, error) — caller logs and continues.
func fetchSource(ctx context.Context, src newsSource, get newsHTTPGetFn) ([]newsCandidate, error) {
	if !src.Available || src.URL == "" {
		return nil, fmt.Errorf("source %q has no available feed", src.Name)
	}
	body, err := get(ctx, src.URL)
	if err != nil {
		return nil, fmt.Errorf("fetch %q: %w", src.Name, err)
	}
	switch src.Kind {
	case "rss":
		return parseRSS(body, src), nil
	case "atom", "github":
		return parseAtom(body, src), nil
	case "gh_search":
		return parseGitHubSearch(body, src), nil
	case "hn":
		return parseHNAlgolia(body, src), nil
	case "reddit":
		return parseRedditJSON(body, src), nil
	default:
		return nil, fmt.Errorf("unknown source kind %q for %q", src.Kind, src.Name)
	}
}

// ---------- runNewsRadar ----------

// runNewsRadar is the loop body for the news_radar role. It is called by
// runLoopAgentIfPresent when role=="news_radar".
//
// httpGet is injectable for testing (nil → defaultNewsHTTPGet).
//
// rls-exempt: inline executor — all queries carry explicit tenant_id filter;
// journal_events is RLS-exempt child table.
func runNewsRadar(
	ctx context.Context,
	pool *pgxpool.Pool,
	logger *zap.Logger,
	tenantID, runID string,
	completeFn researchCompleteFn,
	httpGet newsHTTPGetFn,
) (scanned, newN, sourcesOK, sourcesFailed int) {
	if httpGet == nil {
		httpGet = defaultNewsHTTPGet
	}

	const (
		maxWorkers       = 8
		perSourceTimeout = 8 * time.Second
	)

	// Concurrent fetch with bounded parallelism.
	sem := make(chan struct{}, maxWorkers)
	var mu sync.Mutex
	var candidates []newsCandidate

	var wg sync.WaitGroup
	for _, src := range newsSources {
		src := src // capture
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			sCtx, cancel := context.WithTimeout(ctx, perSourceTimeout)
			defer cancel()

			items, err := fetchSource(sCtx, src, httpGet)
			if err != nil {
				logger.Debug("news-radar: source skipped",
					zap.String("source", src.Name), zap.Error(err))
				mu.Lock()
				sourcesFailed++
				mu.Unlock()
				return
			}
			mu.Lock()
			candidates = append(candidates, items...)
			sourcesOK++
			mu.Unlock()
		}()
	}
	wg.Wait()

	scanned = len(candidates)

	// Insert candidates; ON CONFLICT DO NOTHING deduplicates by (tenant_id, url).
	// Build the LLM-pass inputs alongside: newly-inserted candidates + url→id map.
	var (
		newCandidates []newsCandidate       // candidates that were actually new
		urlToID       = map[string]string{} // url → DB id for LLM score update
	)

	for _, c := range candidates {
		if c.URL == "" || c.Title == "" {
			continue
		}
		var id string
		err := pool.QueryRow(ctx, `
			INSERT INTO news_items (tenant_id, source, category, title, url, summary, author, score, published_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			ON CONFLICT (tenant_id, url) DO NOTHING
			RETURNING id
		`, tenantID, c.Source, c.Category, c.Title, c.URL,
			nullableString(c.Summary), nullableString(c.Author), c.Score, c.PublishedAt,
		).Scan(&id)
		if err == nil {
			newN++
			newCandidates = append(newCandidates, c)
			urlToID[c.URL] = id
		}
		// pgx.ErrNoRows on conflict = expected; other errors are transient — skip row.
	}

	// LLM rank pass: best-effort, skip if completeFn nil or no new items.
	if completeFn != nil && len(newCandidates) > 0 {
		newsLLMRankPass(ctx, pool, logger, tenantID, runID, newCandidates, urlToID, completeFn)
	}

	// Journal event.
	emitNewsSwept(ctx, pool, runID, scanned, newN, sourcesOK, sourcesFailed)
	return scanned, newN, sourcesOK, sourcesFailed
}

// nullableString returns nil for empty strings so DB stores NULL, not "".
func nullableString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// ---------- LLM rank pass ----------

// newsRankItem is the shape the LLM returns for each ranked item.
type newsRankItem struct {
	URL     string `json:"url"`
	Summary string `json:"summary"`
	Score   int    `json:"score"`
}

// newsLLMRankPass asks the LLM to rank newly-inserted items and writes back
// summary+score. Entirely best-effort: any failure is logged and the existing
// rows are kept as-is.
//
// newCandidates — the candidates that were actually inserted this run.
// urlToID       — maps each candidate URL to its DB row id for the UPDATE.
func newsLLMRankPass(
	ctx context.Context,
	pool *pgxpool.Pool,
	logger *zap.Logger,
	tenantID, runID string,
	newCandidates []newsCandidate,
	urlToID map[string]string,
	completeFn researchCompleteFn,
) {
	// Cap at 20 items for the LLM prompt to stay within token budget.
	if len(newCandidates) > 20 {
		newCandidates = newCandidates[:20]
	}

	var sb strings.Builder
	sb.WriteString("New AI news items to rank (URL, source, title):\n")
	for _, c := range newCandidates {
		sb.WriteString(fmt.Sprintf("- url: %s | source: %s | title: %s\n",
			c.URL, c.Source, clampRunes(c.Title, 100)))
	}
	sb.WriteString("\nReturn JSON array of up to 15 items, ordered by importance/trend:")
	sb.WriteString("\n[{\"url\":\"...\",\"summary\":\"one sentence why it matters\",\"score\":1-100},...]")
	sb.WriteString("\nOnly include items that are genuinely significant. Output ONLY valid JSON array, no prose.")

	idemBase := "news-rank:" + tenantID + ":" + runID
	callCtx := WithLLMIdempotencyBase(ctx, idemBase)

	rawText, llmErr := completeFn(callCtx, tenantID,
		"You are an AI news curator. Rank AI news items by importance and trend significance.",
		sb.String())
	if llmErr != nil {
		logger.Warn("news-radar: LLM rank pass failed",
			zap.String("tenant", tenantID), zap.String("run_id", runID), zap.Error(llmErr))
		return
	}

	// Defensive parse: strip code fences.
	s := strings.TrimSpace(rawText)
	if idx := strings.Index(s, "```"); idx != -1 {
		s = s[idx+3:]
		if strings.HasPrefix(s, "json") {
			s = s[4:]
		}
		if end := strings.Index(s, "```"); end != -1 {
			s = s[:end]
		}
		s = strings.TrimSpace(s)
	}
	// Find the JSON array.
	if start := strings.Index(s, "["); start != -1 {
		s = s[start:]
	}
	if end := strings.LastIndex(s, "]"); end != -1 {
		s = s[:end+1]
	}

	var ranked []newsRankItem
	if err := json.Unmarshal([]byte(s), &ranked); err != nil {
		logger.Warn("news-radar: LLM rank JSON parse failed",
			zap.String("run_id", runID), zap.Error(err))
		return
	}
	if len(ranked) > 15 {
		ranked = ranked[:15]
	}

	// Update summary+score for ranked items.
	for _, ri := range ranked {
		id, ok := urlToID[ri.URL]
		if !ok || ri.Summary == "" {
			continue
		}
		summary := clampRunes(ri.Summary, 400)
		score := ri.Score
		if score < 0 {
			score = 0
		}
		// rls-exempt: inline executor — explicit id from our own insert.
		_, updErr := pool.Exec(ctx,
			`UPDATE news_items SET summary = $1, score = $2 WHERE id = $3`,
			summary, score, id)
		if updErr != nil {
			logger.Warn("news-radar: update ranked item failed",
				zap.String("id", id), zap.Error(updErr))
		}
	}
}

// ---------- journal event ----------

// emitNewsSwept writes a news_swept journal event.
// rls-exempt: journal_events — RLS-exempt child table keyed by run_id.
func emitNewsSwept(ctx context.Context, pool *pgxpool.Pool, runID string, scanned, newN, sourcesOK, sourcesFailed int) {
	payload, _ := json.Marshal(map[string]any{
		"scanned":        scanned,
		"new":            newN,
		"sources_ok":     sourcesOK,
		"sources_failed": sourcesFailed,
	})
	_, _ = pool.Exec(ctx, `
		INSERT INTO journal_events (run_id, seq, kind, step_id, attempt, payload)
		VALUES ($1, 1, 'news_swept', 'news-radar', 1, $2)
		ON CONFLICT (run_id, seq) DO NOTHING
	`, runID, payload)
}
