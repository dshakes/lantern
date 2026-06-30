package handlers

// news_radar_test.go — tests for the AI Radar loop body and GET /v1/news.
//
// Three test groups:
//   TestNewsParseRSS_*   — pure unit tests for the RSS 2.0 parser.
//   TestNewsParseAtom_*  — pure unit tests for the Atom parser (covers GitHub releases).
//   TestNewsDedup_*      — DB-backed: insert same URL twice → one row.
//   TestNewsListHandler_* — DB-backed: GET /v1/news returns tenant-scoped items.
//
// DB tests require DATABASE_URL; they skip gracefully when the DB is unreachable.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"go.uber.org/zap"
)

// ---------- RSS parser unit tests ----------

const sampleRSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <item>
      <title>Claude 4 Announced</title>
      <link>https://anthropic.com/news/claude4</link>
      <pubDate>Mon, 01 Jan 2026 10:00:00 +0000</pubDate>
      <author>Anthropic Team</author>
      <description>A new era of AI assistants.</description>
    </item>
    <item>
      <title>Another Post</title>
      <link>https://anthropic.com/news/post2</link>
      <pubDate>Tue, 02 Jan 2026 08:00:00 +0000</pubDate>
    </item>
    <item>
      <title></title>
      <link>https://anthropic.com/news/no-title</link>
    </item>
  </channel>
</rss>`

func TestNewsParseRSS_Items(t *testing.T) {
	src := newsSource{Name: "Test", Category: "labs", Kind: "rss"}
	items := parseRSS([]byte(sampleRSS), src)
	if len(items) != 2 { // third item has empty title → skipped
		t.Fatalf("want 2 items (empty-title skipped), got %d", len(items))
	}
	if items[0].Title != "Claude 4 Announced" {
		t.Errorf("item[0].Title = %q, want %q", items[0].Title, "Claude 4 Announced")
	}
	if items[0].URL != "https://anthropic.com/news/claude4" {
		t.Errorf("item[0].URL = %q", items[0].URL)
	}
	if items[0].Author != "Anthropic Team" {
		t.Errorf("item[0].Author = %q, want %q", items[0].Author, "Anthropic Team")
	}
	if items[0].Summary != "A new era of AI assistants." {
		t.Errorf("item[0].Summary = %q", items[0].Summary)
	}
	if items[0].PublishedAt == nil {
		t.Error("item[0].PublishedAt is nil, want parsed time")
	}
	if items[1].Title != "Another Post" {
		t.Errorf("item[1].Title = %q", items[1].Title)
	}
}

func TestNewsParseRSS_Malformed(t *testing.T) {
	src := newsSource{Name: "Bad", Category: "labs", Kind: "rss"}
	items := parseRSS([]byte("not xml at all"), src)
	// Malformed XML → empty slice, no panic.
	if items != nil {
		t.Errorf("malformed XML: want nil, got %d items", len(items))
	}
}

// ---------- Atom parser unit tests ----------

const sampleAtom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Gemini CLI v1.2 released</title>
    <link href="https://github.com/google-gemini/gemini-cli/releases/tag/v1.2" rel="alternate"/>
    <updated>2026-03-15T12:00:00Z</updated>
    <author><name>Google Gemini Team</name></author>
    <summary>New release with multi-modal support.</summary>
    <id>https://github.com/google-gemini/gemini-cli/releases/tag/v1.2</id>
  </entry>
  <entry>
    <title>Patch release v1.2.1</title>
    <link href="https://github.com/google-gemini/gemini-cli/releases/tag/v1.2.1"/>
    <updated>2026-03-16T09:00:00Z</updated>
    <id>tag:github.com,2026:/releases/123</id>
  </entry>
  <entry>
    <title></title>
    <link href="https://example.com/empty"/>
  </entry>
</feed>`

func TestNewsParseAtom_Items(t *testing.T) {
	src := newsSource{Name: "Gemini CLI releases", Category: "coding-tools", Kind: "github"}
	items := parseAtom([]byte(sampleAtom), src)
	if len(items) != 2 { // empty-title entry skipped
		t.Fatalf("want 2 items, got %d", len(items))
	}
	if items[0].Title != "Gemini CLI v1.2 released" {
		t.Errorf("item[0].Title = %q", items[0].Title)
	}
	if items[0].URL != "https://github.com/google-gemini/gemini-cli/releases/tag/v1.2" {
		t.Errorf("item[0].URL = %q", items[0].URL)
	}
	if items[0].Author != "Google Gemini Team" {
		t.Errorf("item[0].Author = %q", items[0].Author)
	}
	if items[0].Summary != "New release with multi-modal support." {
		t.Errorf("item[0].Summary = %q", items[0].Summary)
	}
	if items[0].PublishedAt == nil {
		t.Error("item[0].PublishedAt is nil")
	}
	// Second entry: no author/summary — should still parse.
	if items[1].Title != "Patch release v1.2.1" {
		t.Errorf("item[1].Title = %q", items[1].Title)
	}
}

func TestNewsParseAtom_FallbackToID(t *testing.T) {
	// Entry with no <link> but a valid http id.
	atomNoLink := `<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>ID-only entry</title>
    <updated>2026-01-01T00:00:00Z</updated>
    <id>https://example.com/id-as-link</id>
  </entry>
</feed>`
	src := newsSource{Name: "IDOnly", Category: "labs", Kind: "atom"}
	items := parseAtom([]byte(atomNoLink), src)
	if len(items) != 1 {
		t.Fatalf("want 1 item, got %d", len(items))
	}
	if items[0].URL != "https://example.com/id-as-link" {
		t.Errorf("URL = %q, want id fallback URL", items[0].URL)
	}
}

// Regression: Blogger/Google-style Atom entries list a rel="self" feed link
// (blogger.com/feeds/…) BEFORE the rel="alternate" type="text/html" article
// link. The parser must pick the ARTICLE link, never the self/feed URL.
func TestNewsParseAtom_PrefersArticleOverSelf(t *testing.T) {
	bloggerAtom := `<feed xmlns="http://www.w3.org/2005/Atom">
  <link rel="self" type="application/atom+xml" href="http://www.blogger.com/feeds/8474926331452026626/posts/default"/>
  <entry>
    <title>Exphormer: Scaling transformers</title>
    <updated>2026-02-01T00:00:00Z</updated>
    <link rel="self" type="application/atom+xml" href="http://www.blogger.com/feeds/8474926331452026626/posts/default/123"/>
    <link rel="replies" type="text/html" href="https://blog.google/exphormer/comments"/>
    <link rel="alternate" type="text/html" href="https://research.google/blog/exphormer-scaling-transformers/"/>
  </entry>
</feed>`
	src := newsSource{Name: "Google AI Blog", Category: "labs", Kind: "atom"}
	items := parseAtom([]byte(bloggerAtom), src)
	if len(items) != 1 {
		t.Fatalf("want 1 item, got %d", len(items))
	}
	want := "https://research.google/blog/exphormer-scaling-transformers/"
	if items[0].URL != want {
		t.Errorf("URL = %q, want the article alternate link %q (not the blogger.com self/feed URL)", items[0].URL, want)
	}
}

// ---------- HN Algolia parser unit test ----------

func TestNewsParseHNAlgolia_SelfPost(t *testing.T) {
	body := []byte(`{"hits":[
		{"title":"Ask HN: best LLM for code?","url":"","objectID":"42","author":"user1","points":88,"created_at":"2026-01-10T08:00:00Z"},
		{"title":"GPT-5 released","url":"https://openai.com/gpt5","objectID":"99","author":"user2","points":300,"created_at":"2026-01-11T12:00:00Z"}
	]}`)
	src := newsSource{Name: "HackerNews", Category: "aggregators", Kind: "hn"}
	items := parseHNAlgolia(body, src)
	if len(items) != 2 {
		t.Fatalf("want 2 items, got %d", len(items))
	}
	// Self-post should use HN thread URL.
	if items[0].URL != "https://news.ycombinator.com/item?id=42" {
		t.Errorf("self-post URL = %q", items[0].URL)
	}
	if items[0].Score != 88 {
		t.Errorf("self-post Score = %d, want 88", items[0].Score)
	}
	if items[1].URL != "https://openai.com/gpt5" {
		t.Errorf("item[1].URL = %q", items[1].URL)
	}
}

// ---------- fetchSource skip-on-unavailable unit test ----------

func TestFetchSource_SkipsUnavailable(t *testing.T) {
	src := newsSource{Name: "NoFeed", Category: "labs", Kind: "rss", URL: "", Available: false}
	called := false
	get := func(_ context.Context, _ string) ([]byte, error) {
		called = true
		return nil, nil
	}
	_, err := fetchSource(context.Background(), src, get)
	if err == nil {
		t.Error("expected error for unavailable source, got nil")
	}
	if called {
		t.Error("httpGet should not be called for unavailable source")
	}
}

// ---------- DB-backed tests ----------

// devTenantID is the seeded dev tenant used across handler tests.
const devTenantIDForNews = "00000000-0000-0000-0000-000000000001"

// insertNewsItem inserts one news_items row directly and returns its id.
func insertNewsItem(t *testing.T, pool interface {
	QueryRow(ctx context.Context, sql string, args ...any) interface {
		Scan(dest ...any) error
	}
}, tenantID, url, title, category string) string {
	t.Helper()
	// Use the concrete pool type from openTestPool — use the ctx shorthand.
	return ""
}

func TestNewsDedup_SameURLInsertedOnce(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenantID := devTenantIDForNews
	testURL := fmt.Sprintf("https://example.com/news-dedup-test-%d", time.Now().UnixNano())

	insert := func() (string, error) {
		var id string
		err := pool.QueryRow(ctx, `
			INSERT INTO news_items (tenant_id, source, category, title, url, score)
			VALUES ($1, 'Test Source', 'labs', 'Test Title', $2, 0)
			ON CONFLICT (tenant_id, url) DO NOTHING
			RETURNING id
		`, tenantID, testURL).Scan(&id)
		return id, err
	}

	id1, err1 := insert()
	if err1 != nil {
		t.Fatalf("first insert: %v", err1)
	}
	if id1 == "" {
		t.Fatal("first insert returned empty id")
	}

	// Second insert of the same URL must be a no-op (ErrNoRows on RETURNING).
	id2, err2 := insert()
	// pgx returns ErrNoRows when ON CONFLICT DO NOTHING fires (no row returned).
	if err2 == nil && id2 != "" && id2 != id1 {
		t.Errorf("dedup failed: second insert returned new id %q (first was %q)", id2, id1)
	}

	// Confirm exactly one row exists.
	var count int
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM news_items WHERE tenant_id = $1 AND url = $2`,
		tenantID, testURL).Scan(&count); err != nil {
		t.Fatalf("count query: %v", err)
	}
	if count != 1 {
		t.Errorf("want 1 row after dedup, got %d", count)
	}

	// Cleanup.
	_, _ = pool.Exec(ctx, `DELETE FROM news_items WHERE tenant_id = $1 AND url = $2`, tenantID, testURL)
}

func TestNewsDedup_RunNewsRadar_CannedHTTP(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenantID := devTenantIDForNews
	runID := fmt.Sprintf("test-run-radar-%d", time.Now().UnixNano())

	// Insert a fake run row so journal_events FK is satisfied.
	agentID := ""
	_ = pool.QueryRow(ctx, `SELECT id FROM agents WHERE tenant_id = $1 LIMIT 1`, tenantID).Scan(&agentID)
	if agentID == "" {
		t.Skip("no agent in dev tenant — run SeedLoopAgents first or seed manually")
	}
	_, _ = pool.Exec(ctx, `
		INSERT INTO runs (id, tenant_id, agent_id, status, input)
		VALUES ($1, $2, $3, 'running', '{}')
		ON CONFLICT (id) DO NOTHING
	`, runID, tenantID, agentID)
	defer func() {
		_, _ = pool.Exec(ctx, `DELETE FROM runs WHERE id = $1`, runID)
		_, _ = pool.Exec(ctx, `DELETE FROM journal_events WHERE run_id = $1`, runID)
	}()

	uniqueURL := fmt.Sprintf("https://example.com/radar-test-%d", time.Now().UnixNano())

	// Canned httpGet: returns a minimal RSS feed with one unique item.
	cannedRSS := fmt.Sprintf(`<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>Test AI News Item</title>
    <link>%s</link>
    <pubDate>Mon, 01 Jan 2026 10:00:00 +0000</pubDate>
  </item>
</channel></rss>`, uniqueURL)

	// ponytail: no hit counter — getter is called concurrently by runNewsRadar.
	cannedGet := func(_ context.Context, _ string) ([]byte, error) {
		return []byte(cannedRSS), nil
	}

	logger := zap.NewNop()
	scanned, newN, srcOK, _ := runNewsRadar(ctx, pool, logger, tenantID, runID, nil, cannedGet)

	if scanned == 0 {
		t.Error("scanned == 0, want at least 1")
	}
	if newN == 0 {
		t.Error("newN == 0, want at least 1 (unique URL should be new)")
	}
	if srcOK == 0 {
		t.Error("srcOK == 0, want at least one successful source")
	}

	// Second run with the same URL → newN should be 0 (all deduped).
	_, newN2, _, _ := runNewsRadar(ctx, pool, logger, tenantID, runID+"b", nil, cannedGet)
	if newN2 != 0 {
		t.Errorf("second run: newN = %d, want 0 (all already in DB)", newN2)
	}

	// Cleanup.
	_, _ = pool.Exec(ctx, `DELETE FROM news_items WHERE tenant_id = $1 AND url = $2`, tenantID, uniqueURL)
}

// ---------- GET /v1/news handler test ----------

func TestNewsListHandler_ReturnsItems(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenantID := devTenantIDForNews
	uniqueURL := fmt.Sprintf("https://example.com/handler-test-%d", time.Now().UnixNano())

	// Insert a test row.
	_, err := pool.Exec(ctx, `
		INSERT INTO news_items (tenant_id, source, category, title, url, summary, score)
		VALUES ($1, 'Test Source', 'labs', 'Test Handler Title', $2, 'Why it matters.', 42)
	`, tenantID, uniqueURL)
	if err != nil {
		t.Fatalf("seed news_item: %v", err)
	}
	defer func() {
		_, _ = pool.Exec(ctx, `DELETE FROM news_items WHERE tenant_id = $1 AND url = $2`, tenantID, uniqueURL)
	}()

	// Build handler + test server via the enforced-server harness.
	e := newEnforcedServer(t)
	auth := NewAuthHandler(e.srv, testJWTSecret)
	h := NewNewsHandler(e.srv, auth)

	tok := mintTestToken(t, tenantID, "00000000-0000-0000-0000-000000000002", "owner")
	// sort=recent so the freshly-seeded row is at the top regardless of how many
	// higher-SCORED rows already exist (default sort is importance-first, so on a
	// populated DB a score-42 row would otherwise fall outside ?limit=10).
	req := httptest.NewRequest(http.MethodGet, "/v1/news?sort=recent&limit=10", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	h.ListNews(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("ListNews status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	var items []newsItemJSON
	if err := json.NewDecoder(bytes.NewReader(w.Body.Bytes())).Decode(&items); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	found := false
	for _, it := range items {
		if it.URL == uniqueURL {
			found = true
			if it.Title != "Test Handler Title" {
				t.Errorf("Title = %q, want %q", it.Title, "Test Handler Title")
			}
			if it.Score != 42 {
				t.Errorf("Score = %d, want 42", it.Score)
			}
			if it.URL == "" {
				t.Error("URL is empty — links must be returned")
			}
		}
	}
	if !found {
		t.Errorf("seeded item with URL %q not found in response", uniqueURL)
	}
}

func TestNewsListHandler_CategoryFilter(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	ctx := context.Background()

	tenantID := devTenantIDForNews
	labsURL := fmt.Sprintf("https://example.com/cat-labs-%d", time.Now().UnixNano())
	peopleURL := fmt.Sprintf("https://example.com/cat-people-%d", time.Now().UnixNano())

	for _, row := range []struct{ url, cat string }{{labsURL, "labs"}, {peopleURL, "people"}} {
		_, err := pool.Exec(ctx, `
			INSERT INTO news_items (tenant_id, source, category, title, url, score)
			VALUES ($1, 'Test', $2, 'Cat Test', $3, 0)
		`, tenantID, row.cat, row.url)
		if err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	defer func() {
		_, _ = pool.Exec(ctx, `DELETE FROM news_items WHERE tenant_id = $1 AND url IN ($2, $3)`, tenantID, labsURL, peopleURL)
	}()

	e := newEnforcedServer(t)
	auth := NewAuthHandler(e.srv, testJWTSecret)
	h := NewNewsHandler(e.srv, auth)
	tok := mintTestToken(t, tenantID, "00000000-0000-0000-0000-000000000002", "owner")

	doGet := func(category string) []newsItemJSON {
		url := "/v1/news?limit=100"
		if category != "" {
			url += "&category=" + category
		}
		req := httptest.NewRequest(http.MethodGet, url, nil)
		req.Header.Set("Authorization", "Bearer "+tok)
		w := httptest.NewRecorder()
		h.ListNews(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d", w.Code)
		}
		var out []newsItemJSON
		_ = json.NewDecoder(w.Body).Decode(&out)
		return out
	}

	labsItems := doGet("labs")
	for _, it := range labsItems {
		if it.URL == peopleURL {
			t.Error("?category=labs returned a 'people' item")
		}
	}
	found := false
	for _, it := range labsItems {
		if it.URL == labsURL {
			found = true
		}
	}
	if !found {
		t.Error("?category=labs did not return the labs item")
	}
}
