package handlers

// Deterministic data pre-fetch for templated agents.
//
// Why this exists: the tool-use path (LLM decides which tools to call) is
// flexible but unreliable — even Claude Opus with 10 tools attached and a
// directive prompt will sometimes refuse to call a tool and respond "I
// don't have any connectors set up". For known, predictable workflows
// (Morning Brief always pulls GitHub + Linear + Gmail + Calendar) we
// don't NEED the model to decide. We can fetch the data server-side, hand
// it to the model as plain text, and let the model do what it's actually
// good at — writing a concise summary.
//
// Side benefits:
//   - Works on cheap models. gpt-4o-mini or claude-haiku can summarize
//     pre-formatted text reliably; they can't reliably tool-use.
//   - Token cost drops ~10x. No more 700-token tool definitions in every
//     request; just the data itself which is usually <2KB.
//   - Failure mode is transparent. If GitHub returns 401, the prefetched
//     text includes 'GitHub: error (Bad credentials)'. The model passes
//     that through naturally instead of hallucinating.
//
// To add prefetch for a new template, append a case to prefetchForTemplate.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// prefetchResult is what executeRunInline uses to decide what to send the LLM.
// Empty Body means no prefetch applies — caller falls back to the tool-use
// loop. Sources / Errors are recorded so the run-detail waterfall can show
// 'Pre-fetched 3/4 sources (calendar failed: token expired)'.
type prefetchResult struct {
	Body    string   // markdown-ish text ready to drop into the user message
	Sources []string // names of sources we successfully fetched
	Errors  []string // 'gmail: 401 unauthorized' style strings for each failure
}

// prefetchForTemplate returns the pre-fetched data for known templates or
// (zero-value, false) for templates without a prefetch handler. Callers
// MUST handle the (false) case by falling through to the tool-use loop.
//
// userInput is the run's input text (empty for Run Now / cron). For
// templates that mix summarize-mode and instruction-mode (Inbox Concierge
// — 'summarize my inbox' vs 'draft a reply to alex'), prefetch only fires
// when input is empty. Non-empty input falls through to the tool-use loop
// so the model can call gmail__send_message etc.
func prefetchForTemplate(
	ctx context.Context,
	pool *pgxpool.Pool,
	tenantID, templateID, userInput string,
) (prefetchResult, bool) {
	switch templateID {
	case "morning-brief":
		// Morning Brief is summarize-only — always prefetch regardless of
		// input. (Future: respect a 'detailed' input flag etc.)
		return prefetchMorningBrief(ctx, pool, tenantID), true
	case "inbox-concierge":
		// Only prefetch when no user instruction was provided. With an
		// instruction like 'draft a reply to alex' we need the tool-use
		// loop to call gmail__send_message, which prefetch can't do.
		if isEmptyInput(userInput) {
			return prefetchInboxConcierge(ctx, pool, tenantID), true
		}
		return prefetchResult{}, false
	default:
		return prefetchResult{}, false
	}
}

// isEmptyInput recognizes the values executeRunInline emits when there's
// no real user instruction (Run Now / cron with no body).
func isEmptyInput(s string) bool {
	t := strings.TrimSpace(s)
	if t == "" || t == "{}" || t == "null" {
		return true
	}
	// Match the synthesized 'Run Now' default we inject — if the user
	// didn't actually type anything, prefetch is still the right call.
	if strings.HasPrefix(t, "This is a Run Now invocation") {
		return true
	}
	return false
}

// prefetchInboxConcierge calls Gmail once (search for last-24h unread,
// filtered to non-promotional non-social) and formats the result so the
// model can do the 3-bucket triage from a static blob instead of needing
// the tool-use loop.
func prefetchInboxConcierge(
	ctx context.Context,
	pool *pgxpool.Pool,
	tenantID string,
) prefetchResult {
	// 10s timeout matches the morning-brief per-fetch cap. Single fetch
	// here, but bounding it still prevents a hung Gmail call from
	// blocking the run.
	fctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	// Filters: -category:promotions -category:social drops marketing/
	// social noise. -from:me + -label:lantern drop the user's own sent
	// mail (sometimes appears unread on first sync) AND Lantern's own
	// status mirror mail (which lands in inbox until the user grants
	// gmail.modify scope, otherwise the label/skip-inbox is a no-op).
	// Without these two, the prefetch was returning 5 lantern-self
	// emails as the "unread" set and the model concluded "nothing real
	// to reply to".
	res, err := executeConnectorAction(fctx, pool, tenantID, "gmail", "search", map[string]any{
		"query": "is:unread newer_than:1d -category:promotions -category:social -from:me -label:lantern",
		"limit": 25,
	})
	var b strings.Builder
	b.WriteString("## Gmail — unread, last 24h (non-promotional, non-social)\n")
	if err != nil {
		b.WriteString(fmt.Sprintf("_(error: %s)_\n", truncate(err.Error(), 200)))
		return prefetchResult{Body: b.String(), Errors: []string{"gmail: " + truncate(err.Error(), 80)}}
	}
	formatted := formatGmailMessages(res)
	if formatted == "" {
		b.WriteString("_(no unread mail)_\n")
	} else {
		b.WriteString(formatted)
	}
	return prefetchResult{Body: b.String(), Sources: []string{"gmail_unread"}}
}

// prefetchMorningBrief calls GitHub + Linear + Gmail + Calendar in parallel,
// formats their results as a markdown block, and records per-source success
// or failure. Each call is independent — one failing doesn't abort the others.
func prefetchMorningBrief(
	ctx context.Context,
	pool *pgxpool.Pool,
	tenantID string,
) prefetchResult {
	type sourceFetch struct {
		Name   string
		Header string                  // markdown section header
		Run    func() (any, error)     // closure that calls the executor
		Format func(any) string        // turns the raw result into markdown body
	}

	// Per-fetch timeout. One hung connector used to block the whole brief
	// because the parent ctx was Background() with no deadline. 10s is
	// comfortably above any real connector latency (Linear GraphQL is
	// usually < 1s) but well under the run's UX cap.
	const perFetchTimeout = 10 * time.Second
	exec := func(connectorID, action string, params map[string]any) func() (any, error) {
		return func() (any, error) {
			fctx, cancel := context.WithTimeout(ctx, perFetchTimeout)
			defer cancel()
			return executeConnectorAction(fctx, pool, tenantID, connectorID, action, params)
		}
	}

	fetchers := []sourceFetch{
		{
			Name:   "github_issues",
			Header: "## GitHub — issues assigned to you",
			Run:    exec("github", "list_issues", map[string]any{"state": "open", "filter": "assigned", "limit": 10}),
			Format: formatGitHubIssues,
		},
		{
			Name:   "linear_issues",
			Header: "## Linear — your recent tickets",
			Run:    exec("linear", "list_issues", map[string]any{"limit": 10}),
			Format: formatLinearIssues,
		},
		{
			Name:   "gmail_unread",
			Header: "## Gmail — unread, last 24h",
			Run:    exec("gmail", "search", map[string]any{"query": "is:unread newer_than:1d -category:promotions -category:social", "limit": 10}),
			Format: formatGmailMessages,
		},
		{
			Name:   "calendar_today",
			Header: "## Calendar — next 5 events",
			Run:    exec("google-calendar", "list_events", map[string]any{"limit": 5}),
			Format: formatCalendarEvents,
		},
	}

	// Run fetches in parallel — Go channels keep the order deterministic
	// without exposing the rest of the package to goroutine plumbing.
	type fetchResult struct {
		idx    int
		result any
		err    error
	}
	resultsCh := make(chan fetchResult, len(fetchers))
	for i, f := range fetchers {
		go func(idx int, run func() (any, error)) {
			r, err := run()
			resultsCh <- fetchResult{idx: idx, result: r, err: err}
		}(i, f.Run)
	}

	results := make([]fetchResult, len(fetchers))
	for range fetchers {
		r := <-resultsCh
		results[r.idx] = r
	}

	var body strings.Builder
	var sources, errs []string
	for i, f := range fetchers {
		r := results[i]
		body.WriteString(f.Header)
		body.WriteString("\n")
		if r.err != nil {
			body.WriteString(fmt.Sprintf("_(error: %s)_\n\n", truncate(r.err.Error(), 200)))
			errs = append(errs, fmt.Sprintf("%s: %s", f.Name, truncate(r.err.Error(), 80)))
			continue
		}
		formatted := f.Format(r.result)
		if formatted == "" {
			body.WriteString("_(nothing today)_\n\n")
		} else {
			body.WriteString(formatted)
			body.WriteString("\n")
		}
		sources = append(sources, f.Name)
	}

	return prefetchResult{Body: body.String(), Sources: sources, Errors: errs}
}

// ---- per-source formatters --------------------------------------------------
//
// Each formatter returns markdown bullet lines. They are intentionally chatty
// (include titles, due dates, sender names) since the model summarizes them
// down into 3 bullets and we want it to have the raw signal to pick from.

func formatGitHubIssues(raw any) string {
	// GitHub /issues returns []map[string]any in-process or []any via JSON.
	// normalizeAnyList accepts both — see comment on that helper.
	arr := normalizeAnyList(raw)
	if len(arr) == 0 {
		if m, ok := raw.(map[string]any); ok {
			arr = normalizeAnyList(m["data"])
		}
	}
	if len(arr) == 0 {
		return ""
	}
	var b strings.Builder
	max := 10
	for i, v := range arr {
		if i >= max {
			break
		}
		item, _ := v.(map[string]any)
		title, _ := item["title"].(string)
		number := numberStr(item["number"])
		repoFullName := ""
		if repo, ok := item["repository"].(map[string]any); ok {
			repoFullName, _ = repo["full_name"].(string)
		}
		url, _ := item["html_url"].(string)
		state, _ := item["state"].(string)
		line := fmt.Sprintf("- [#%s] %s", number, truncate(title, 100))
		if repoFullName != "" {
			line += fmt.Sprintf(" _(%s)_", repoFullName)
		}
		if state != "" && state != "open" {
			line += fmt.Sprintf(" — %s", state)
		}
		if url != "" {
			line += fmt.Sprintf(" <%s>", url)
		}
		b.WriteString(line + "\n")
	}
	return b.String()
}

func formatLinearIssues(raw any) string {
	// Linear GraphQL returns {data: {issues: {nodes: [...]}}}
	m, _ := raw.(map[string]any)
	if m == nil {
		return ""
	}
	data, _ := m["data"].(map[string]any)
	if data == nil {
		return ""
	}
	issues, _ := data["issues"].(map[string]any)
	if issues == nil {
		return ""
	}
	nodes := normalizeAnyList(issues["nodes"])
	if len(nodes) == 0 {
		return ""
	}
	var b strings.Builder
	max := 10
	for i, v := range nodes {
		if i >= max {
			break
		}
		n, _ := v.(map[string]any)
		identifier, _ := n["identifier"].(string)
		title, _ := n["title"].(string)
		state := ""
		if s, ok := n["state"].(map[string]any); ok {
			state, _ = s["name"].(string)
		}
		assignee := ""
		if a, ok := n["assignee"].(map[string]any); ok {
			assignee, _ = a["name"].(string)
		}
		line := fmt.Sprintf("- [%s] %s", identifier, truncate(title, 100))
		if state != "" {
			line += fmt.Sprintf(" — %s", state)
		}
		if assignee != "" {
			line += fmt.Sprintf(" (assignee: %s)", assignee)
		}
		b.WriteString(line + "\n")
	}
	return b.String()
}

func formatGmailMessages(raw any) string {
	// Gmail search returns map with 'messages' (or just a list).
	// The connector returns []map[string]any from searchGmailViaAPI
	// when called in-process; JSON marshalling converts that to []any
	// over the HTTP boundary. We accept both — silently dropping the
	// typed-slice case caused prefetched Gmail data to look empty to
	// the model (it would say "no unread emails" even when 9 were
	// present). normalizeAnyList is the workhorse.
	msgs := normalizeAnyList(raw)
	if msgs == nil {
		if m, ok := raw.(map[string]any); ok {
			msgs = normalizeAnyList(m["messages"])
		}
	}
	if len(msgs) == 0 {
		return ""
	}
	var b strings.Builder
	max := 10
	for i, v := range msgs {
		if i >= max {
			break
		}
		m, _ := v.(map[string]any)
		from, subject, snippet := extractGmailFields(m)
		// Some Gmail responses only carry message IDs; degrade gracefully.
		if from == "" && subject == "" {
			if id, ok := m["id"].(string); ok {
				b.WriteString(fmt.Sprintf("- (id %s)\n", truncate(id, 30)))
			}
			continue
		}
		line := "- "
		if from != "" {
			line += fmt.Sprintf("**%s** — ", truncate(from, 50))
		}
		if subject != "" {
			line += truncate(subject, 100)
		}
		if snippet != "" {
			line += fmt.Sprintf("\n  _%s_", truncate(snippet, 140))
		}
		b.WriteString(line + "\n")
	}
	return b.String()
}

// normalizeAnyList accepts a value that could be:
//   - []any (post-JSON shape)
//   - []map[string]any (raw Go shape from in-process connector calls)
//   - any other typed slice — converted via reflection-free best-effort
// and returns it as []any. Returns nil if the input isn't a list shape.
// This is necessary because Go's type assertion `x.([]any)` fails on a
// `[]map[string]any` value even though every element is convertible to
// `any` — the slice headers are different types in the runtime.
func normalizeAnyList(v any) []any {
	if v == nil {
		return nil
	}
	if a, ok := v.([]any); ok {
		return a
	}
	if a, ok := v.([]map[string]any); ok {
		out := make([]any, len(a))
		for i, m := range a {
			out[i] = m
		}
		return out
	}
	return nil
}

// extractGmailFields returns (from, subject, snippet) from a Gmail
// message map. Handles both shapes the connector produces:
//   1. Flat (IMAP path): {"from": "...", "subject": "...", "snippet": "..."}
//   2. Nested (OAuth API path): {"payload":{"headers":[{"name":"From","value":"..."}, ...]}, "snippet":"..."}
// Without this, OAuth-mode runs printed bare message IDs and the
// model concluded "nothing real to reply to".
func extractGmailFields(m map[string]any) (from, subject, snippet string) {
	from, _ = m["from"].(string)
	subject, _ = m["subject"].(string)
	snippet, _ = m["snippet"].(string)
	if from != "" || subject != "" {
		return
	}
	// Fall through to nested payload.headers.
	payload, _ := m["payload"].(map[string]any)
	if payload == nil {
		return
	}
	headers, _ := payload["headers"].([]any)
	for _, h := range headers {
		hm, _ := h.(map[string]any)
		if hm == nil {
			continue
		}
		name, _ := hm["name"].(string)
		value, _ := hm["value"].(string)
		switch strings.ToLower(name) {
		case "from":
			if from == "" {
				from = value
			}
		case "subject":
			if subject == "" {
				subject = value
			}
		}
	}
	return
}

func formatCalendarEvents(raw any) string {
	// google-calendar list_events returns map with 'items' (Google API shape).
	// normalizeAnyList accepts both []any and []map[string]any.
	var items []any
	if m, ok := raw.(map[string]any); ok {
		if it := normalizeAnyList(m["items"]); it != nil {
			items = it
		} else if it := normalizeAnyList(m["events"]); it != nil {
			items = it
		}
	}
	if items == nil {
		items = normalizeAnyList(raw)
	}
	if len(items) == 0 {
		return ""
	}
	var b strings.Builder
	for _, v := range items {
		ev, _ := v.(map[string]any)
		summary, _ := ev["summary"].(string)
		if summary == "" {
			summary, _ = ev["title"].(string)
		}
		startStr := ""
		if start, ok := ev["start"].(map[string]any); ok {
			if dt, ok := start["dateTime"].(string); ok {
				startStr = dt
			} else if d, ok := start["date"].(string); ok {
				startStr = d
			}
		}
		line := "- "
		if startStr != "" {
			line += fmt.Sprintf("**%s** — ", startStr)
		}
		line += truncate(summary, 100)
		b.WriteString(line + "\n")
	}
	return b.String()
}

// ---- helpers ----------------------------------------------------------------

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}

// numberStr handles GitHub's JSON-numbers which decode as float64.
func numberStr(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	b, _ := json.Marshal(v)
	return strings.TrimSuffix(string(b), ".0")
}
