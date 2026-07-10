package handlers

// immigration_sentinel.go — USCIS / Immigration Deadline Sentinel (Phase 3).
//
// Continuously reasons over the family's immigration documents + USCIS/attorney
// mail to surface DERIVED deadlines nobody typed in — EAD/AP expiry, I-485
// pending windows, biometrics/RFE response clocks — reconciling local PDFs
// against the latest email.
//
// Intelligence, not keyword matching (project rule: "intelligence is mandatory").
// An LLM reasons over two evidence sources and returns structured deadlines
// grounded in specific source refs.  Any deadline without a source ref is
// rejected at parse time; any with confidence < minImmigrationConfidence is skipped.
//
// Flag-gated: LANTERN_IMMIGRATION_SENTINEL (default OFF).
//   - Unset → scan is a no-op, endpoints return empty/disabled response.
//   - Zero behavior change when flag is off.
//
// RLS-safe: all DB access via srv.WithTenant or db.WithTenantConn; the
// immigration_deadlines table is RLS-enforced (migration 0012).
//
// Invariants honored:
//
//	#6  — LLM via CompleteInternal (provider-failover chain), never hardcoded.
//	#7  — every DB write scoped to tenant_id via WithTenant / WithTenantConn.
//	#10 — doc/email content is PII; never logged above debug level.

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/db"
	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// immigrationSentinelEnabled reports whether the sentinel is active.
// Default OFF: unset env means zero behavior change for all callers.
func immigrationSentinelEnabled() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("LANTERN_IMMIGRATION_SENTINEL")))
	return v == "1" || v == "true" || v == "on"
}

// minImmigrationConfidence is the floor below which LLM-returned deadlines are
// discarded. Matches the system prompt's own stated minimum (0.60 for a date
// needing light inference) so there is a code backstop if the LLM deviates and
// emits a lower-confidence (0.40–0.59) inference the prompt forbids.
const minImmigrationConfidence = 0.6

// maxImmigrationDocsToRead caps how many PDFs we read (expensive / PII).
const maxImmigrationDocsToRead = 4

// maxImmigrationEmailsToRead caps emails fetched per scan.
const maxImmigrationEmailsToRead = 6

// immigrationDocQuery is what we search personal files for.
const immigrationDocQuery = "USCIS immigration EAD work authorization I-485 green card visa travel document I-131 biometrics"

// immigrationEmailQuery is what we search email for.
const immigrationEmailQuery = "USCIS immigration EAD appointment biometrics notice receipt RFE green card I-485 I-131"

// ---------- public types ----------

// ImmigrationDeadline is a single derived immigration deadline returned by the
// LLM reasoning pass.
type ImmigrationDeadline struct {
	Who        string   `json:"who"`
	DocType    string   `json:"doc_type"`
	Deadline   string   `json:"deadline"`    // YYYY-MM-DD
	Basis      string   `json:"basis"`       // one-sentence rationale
	SourceRefs []string `json:"source_refs"` // docs/emails that grounded this
	Confidence float64  `json:"confidence"`  // 0.0–1.0
}

// storedImmigrationDeadline adds DB-side fields for list responses.
type storedImmigrationDeadline struct {
	ImmigrationDeadline
	ID        string    `json:"id"`
	ScanID    string    `json:"scan_id"`
	UpdatedAt time.Time `json:"updated_at"`
}

// ---------- handler ----------

// ImmigrationSentinelHandler handles:
//
//	GET  /v1/immigration/deadlines — list stored derived deadlines
//	POST /v1/immigration/scan     — trigger a fresh LLM-reasoning scan
type ImmigrationSentinelHandler struct {
	srv        *server.Server
	auth       *AuthHandler
	completeFn researchCompleteFn
}

// NewImmigrationSentinelHandler wires up the handler. completeFn defaults to
// the LLM proxy's CompleteInternal (provider-failover, capability-addressed).
func NewImmigrationSentinelHandler(srv *server.Server, auth *AuthHandler, llmProxy *LlmProxyHandler) *ImmigrationSentinelHandler {
	h := &ImmigrationSentinelHandler{srv: srv, auth: auth}
	h.completeFn = func(ctx context.Context, tenantID, system, user string) (string, error) {
		text, _, _, _, err := llmProxy.CompleteInternalWithUsage(ctx, tenantID, system, user)
		return text, err
	}
	return h
}

func (h *ImmigrationSentinelHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("immigration-sentinel")
}

func (h *ImmigrationSentinelHandler) contextWithTenant(r *http.Request) (context.Context, string, error) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		return nil, "", err
	}
	return middleware.InjectTenantID(r.Context(), claims.TenantID), claims.TenantID, nil
}

// List serves GET /v1/immigration/deadlines.
// Returns stored derived deadlines sorted by deadline ascending.
// Returns an empty list (not an error) when the flag is off.
func (h *ImmigrationSentinelHandler) List(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !immigrationSentinelEnabled() {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false, "deadlines": []any{}})
		return
	}

	var deadlines []storedImmigrationDeadline
	dbErr := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		var qErr error
		deadlines, qErr = queryImmigrationDeadlines(ctx, tx, tenantID, 0)
		return qErr
	})
	if dbErr != nil {
		h.logger().Error("immigration_sentinel: list failed",
			zap.String("tenant", tenantID), zap.Error(dbErr))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to load deadlines"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "deadlines": deadlines})
}

// Scan serves POST /v1/immigration/scan.
// Gathers immigration docs + mail and runs an LLM reasoning pass to derive
// new deadlines. Fail-safe: any doc/LLM/parse error → empty scan, never 5xx.
// Returns 200 with a disabled message when the flag is off.
func (h *ImmigrationSentinelHandler) Scan(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !immigrationSentinelEnabled() {
		writeJSON(w, http.StatusOK, map[string]any{
			"enabled": false,
			"message": "immigration sentinel disabled (set LANTERN_IMMIGRATION_SENTINEL=1 to enable)",
			"found":   0,
		})
		return
	}

	found, scanErr := runImmigrationScan(ctx, h.srv.TenantPool(), h.logger(), tenantID, h.completeFn)
	if scanErr != nil {
		// Log but return 200 + 0: fail-safe contract means no 5xx here.
		h.logger().Warn("immigration_sentinel: scan did not complete cleanly",
			zap.String("tenant", tenantID), zap.Error(scanErr))
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "found": found})
}

// ---------- core scan logic (testable, pool-agnostic) ----------

// runImmigrationScan is the testable core: gather evidence → reason with LLM →
// upsert derived deadlines.  Returns (count, nil) on success; (0, err) on any
// failure so the caller can decide logging severity.
func runImmigrationScan(
	ctx context.Context,
	pool *pgxpool.Pool,
	logger *zap.Logger,
	tenantID string,
	completeFn researchCompleteFn,
) (int, error) {
	// Step 1: gather evidence from local docs + mail.
	// Fail-open: bridge may be unreachable; we pass whatever we collected.
	material, gatherErr := gatherImmigrationMaterial(ctx, tenantID)
	if gatherErr != nil {
		logger.Warn("immigration_sentinel: material gather partial — proceeding with what was collected",
			zap.String("tenant", tenantID), zap.Error(gatherErr))
	}
	if material.isEmpty() {
		logger.Info("immigration_sentinel: no immigration material found; skipping LLM pass",
			zap.String("tenant", tenantID))
		return 0, nil
	}

	// Step 2: build prompts from evidence.
	system, user := buildImmigrationPrompt(material)

	// Step 3: LLM call — provider-failover chain, invariant #6.
	if completeFn == nil {
		return 0, fmt.Errorf("immigration_sentinel: no LLM configured")
	}
	raw, llmErr := completeFn(ctx, tenantID, system, user)
	if llmErr != nil {
		return 0, fmt.Errorf("immigration_sentinel: LLM call: %w", llmErr)
	}

	// Step 4: tolerant parse — reject any deadline without a real source ref.
	deadlines := parseImmigrationResponse(raw)
	if len(deadlines) == 0 {
		logger.Info("immigration_sentinel: LLM returned no grounded deadlines",
			zap.String("tenant", tenantID))
		return 0, nil
	}

	// Step 5: upsert — tenant-scoped, RLS-enforced via db.WithTenantConn.
	n, upsertErr := upsertImmigrationDeadlines(ctx, pool, logger, tenantID, deadlines)
	if upsertErr != nil {
		return 0, fmt.Errorf("immigration_sentinel: upsert: %w", upsertErr)
	}
	logger.Info("immigration_sentinel: scan complete",
		zap.String("tenant", tenantID), zap.Int("upserted", n))
	return n, nil
}

// ---------- evidence gathering ----------

// immigrationMaterial holds raw evidence for the LLM reasoning pass.
type immigrationMaterial struct {
	DocSnippets   []immigrationDocSnippet
	EmailSnippets []immigrationEmailSnippet
}

type immigrationDocSnippet struct {
	Path    string
	Excerpt string
}

type immigrationEmailSnippet struct {
	Subject string
	From    string
	Excerpt string
}

func (m immigrationMaterial) isEmpty() bool {
	return len(m.DocSnippets) == 0 && len(m.EmailSnippets) == 0
}

// gatherImmigrationMaterial calls the personal-docs bridge to collect immigration
// PDFs and USCIS mail.  Returns whatever it could gather; partial is fine.
func gatherImmigrationMaterial(ctx context.Context, tenantID string) (immigrationMaterial, error) {
	var mat immigrationMaterial
	var lastErr error

	// --- personal files ---
	searchRes, err := executePersonalDocsTool(ctx, tenantID, "search_personal_files", map[string]any{
		"query": immigrationDocQuery,
		"limit": maxImmigrationDocsToRead,
	})
	if err != nil {
		lastErr = fmt.Errorf("search_personal_files: %w", err)
	} else {
		var parsed struct {
			Results []struct {
				Path string `json:"path"`
			} `json:"results"`
		}
		if b, _ := json.Marshal(searchRes); json.Unmarshal(b, &parsed) == nil {
			for i, r := range parsed.Results {
				if i >= maxImmigrationDocsToRead || r.Path == "" {
					break
				}
				content, readErr := executePersonalDocsTool(ctx, tenantID, "read_personal_file", map[string]any{
					"path": r.Path,
				})
				if readErr != nil {
					lastErr = fmt.Errorf("read_personal_file %q: %w", r.Path, readErr)
					continue
				}
				text := extractTextFromDocResult(content)
				if text == "" {
					continue
				}
				const docExcerptMax = 4000
				if len(text) > docExcerptMax {
					text = text[:docExcerptMax]
				}
				mat.DocSnippets = append(mat.DocSnippets, immigrationDocSnippet{Path: r.Path, Excerpt: text})
			}
		}
	}

	// --- email ---
	emailRes, err := executePersonalDocsTool(ctx, tenantID, "search_email", map[string]any{
		"query": immigrationEmailQuery,
		"limit": maxImmigrationEmailsToRead,
	})
	if err != nil {
		if lastErr == nil {
			lastErr = fmt.Errorf("search_email: %w", err)
		}
	} else {
		var parsed struct {
			Results []struct {
				Subject string `json:"subject"`
				From    string `json:"from"`
				Snippet string `json:"snippet"`
			} `json:"results"`
		}
		if b, _ := json.Marshal(emailRes); json.Unmarshal(b, &parsed) == nil {
			for i, r := range parsed.Results {
				if i >= maxImmigrationEmailsToRead {
					break
				}
				if r.Subject == "" && r.Snippet == "" {
					continue
				}
				mat.EmailSnippets = append(mat.EmailSnippets, immigrationEmailSnippet{
					Subject: r.Subject,
					From:    r.From,
					Excerpt: r.Snippet,
				})
			}
		}
	}
	return mat, lastErr
}

// extractTextFromDocResult pulls plain text from a personal-docs bridge result.
func extractTextFromDocResult(result any) string {
	if result == nil {
		return ""
	}
	if m, ok := result.(map[string]any); ok {
		// A bridge error payload ({"error":"permission denied","path":"…EAD.pdf"})
		// must NOT be fed to the LLM as document text — the filename alone could
		// nudge it to reason about contents it never saw. Treat as no content.
		if errMsg, ok := m["error"].(string); ok && strings.TrimSpace(errMsg) != "" {
			return ""
		}
		for _, key := range []string{"text", "content", "body"} {
			if v, found := m[key]; found {
				if s, ok := v.(string); ok {
					return s
				}
			}
		}
	}
	b, _ := json.Marshal(result)
	return string(b)
}

// ---------- prompt builder (pure function) ----------

// buildImmigrationPrompt returns the system and user prompts for the LLM
// reasoning pass.  Pure function; easy to unit-test.
func buildImmigrationPrompt(mat immigrationMaterial) (system, user string) {
	system = `You are an immigration document analyst helping a family track their USCIS deadlines.

Your task: identify CONCRETE, GROUNDED deadlines from the provided documents and email snippets.

Rules:
- ONLY emit a deadline if you found the specific date explicitly in a provided source.
- NEVER guess or extrapolate a date. If you cannot find an explicit date, omit the entry.
- "source_refs" must list the exact file path(s) or email subject(s) where you found the date.
- "doc_type" should be a short identifier: "EAD", "AP", "Biometrics", "I-485 response", "RFE response", "I-131 renewal", "I-94 expiry", etc.
- "confidence": 0.90–1.0 for explicitly printed dates; 0.60–0.89 for dates needing light inference (e.g. "valid for 2 years from" + issue date).
- "deadline" must be a date in YYYY-MM-DD format.
- If no grounded deadlines exist, return: {"deadlines":[]}
- Return ONLY valid JSON. Do not wrap in markdown code fences.

Output shape:
{"deadlines":[{"who":string,"doc_type":string,"deadline":"YYYY-MM-DD","basis":string,"source_refs":[string],"confidence":float}]}`

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Today is %s.\n\n", time.Now().UTC().Format("2006-01-02")))

	if len(mat.DocSnippets) > 0 {
		sb.WriteString("## Immigration documents found on this device\n\n")
		for _, d := range mat.DocSnippets {
			sb.WriteString(fmt.Sprintf("### %s\n%s\n\n", d.Path, d.Excerpt))
		}
	}
	if len(mat.EmailSnippets) > 0 {
		sb.WriteString("## Relevant email messages\n\n")
		for _, e := range mat.EmailSnippets {
			sb.WriteString(fmt.Sprintf("### Subject: %s\nFrom: %s\n%s\n\n", e.Subject, e.From, e.Excerpt))
		}
	}
	sb.WriteString("Analyze the above and return derived immigration deadlines as JSON.")
	user = sb.String()
	return
}

// ---------- response parser (pure function) ----------

// parseImmigrationResponse tolerantly extracts ImmigrationDeadlines from the
// raw LLM string.  It:
//   - strips markdown fences
//   - finds the first {...} JSON object
//   - validates each deadline: non-empty core fields, ≥1 source ref, parseable date, confidence ≥ minImmigrationConfidence
//
// Returns nil on total parse failure; never panics.
func parseImmigrationResponse(raw string) []ImmigrationDeadline {
	s := strings.TrimSpace(raw)
	s = strings.TrimPrefix(s, "```json")
	s = strings.TrimPrefix(s, "```")
	s = strings.TrimSuffix(s, "```")
	s = strings.TrimSpace(s)

	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start < 0 || end <= start {
		return nil
	}
	s = s[start : end+1]

	var payload struct {
		Deadlines []ImmigrationDeadline `json:"deadlines"`
	}
	if err := json.Unmarshal([]byte(s), &payload); err != nil {
		return nil
	}

	out := payload.Deadlines[:0]
	for _, d := range payload.Deadlines {
		if strings.TrimSpace(d.Who) == "" ||
			strings.TrimSpace(d.DocType) == "" ||
			strings.TrimSpace(d.Basis) == "" ||
			strings.TrimSpace(d.Deadline) == "" {
			continue
		}
		// Require at least one NON-BLANK source ref. An empty slice OR a
		// whitespace-only element ([""], [" "]) is ungrounded = fabrication
		// risk (a hallucinated deadline can emit "source_refs":[""]).
		hasGroundedRef := false
		for _, r := range d.SourceRefs {
			if strings.TrimSpace(r) != "" {
				hasGroundedRef = true
				break
			}
		}
		if !hasGroundedRef {
			continue
		}
		if d.Confidence < minImmigrationConfidence {
			continue
		}
		if _, err := time.Parse("2006-01-02", d.Deadline); err != nil {
			continue
		}
		out = append(out, d)
	}
	return out
}

// ---------- DB persistence ----------

// upsertImmigrationDeadlines persists derived deadlines for a tenant.
// Uses INSERT ON CONFLICT so a re-scan updates basis/confidence/source_refs
// rather than duplicating.  All writes go through db.WithTenantConn (RLS).
func upsertImmigrationDeadlines(
	ctx context.Context,
	pool *pgxpool.Pool,
	logger *zap.Logger,
	tenantID string,
	deadlines []ImmigrationDeadline,
) (int, error) {
	if len(deadlines) == 0 {
		return 0, nil
	}
	scanID := newImmigrationScanID()
	n := 0

	err := db.WithTenantConn(ctx, pool, tenantID, func(tx pgx.Tx) error {
		for _, d := range deadlines {
			refs, _ := json.Marshal(d.SourceRefs)
			_, qErr := tx.Exec(ctx, `
				INSERT INTO immigration_deadlines
					(tenant_id, who, doc_type, deadline, basis, source_refs, confidence, scan_id)
				VALUES ($1::uuid, $2, $3, $4::date, $5, $6::jsonb, $7, $8::uuid)
				ON CONFLICT (tenant_id, who, doc_type, deadline) DO UPDATE
				  SET basis       = EXCLUDED.basis,
				      source_refs = EXCLUDED.source_refs,
				      confidence  = EXCLUDED.confidence,
				      scan_id     = EXCLUDED.scan_id,
				      updated_at  = now()
			`, tenantID, d.Who, d.DocType, d.Deadline, d.Basis, refs, d.Confidence, scanID)
			if qErr != nil {
				logger.Warn("immigration_sentinel: upsert row skipped",
					zap.String("who", d.Who), zap.String("doc_type", d.DocType),
					zap.String("deadline", d.Deadline), zap.Error(qErr))
				continue // non-fatal; try remaining rows
			}
			n++
		}
		return nil
	})
	return n, err
}

// queryImmigrationDeadlines reads stored deadlines inside an open transaction.
// windowDays=0 returns all future deadlines; >0 limits to that many days ahead.
func queryImmigrationDeadlines(ctx context.Context, tx pgx.Tx, tenantID string, windowDays int) ([]storedImmigrationDeadline, error) {
	var q string
	var args []any
	if windowDays > 0 {
		q = `
			SELECT id, who, doc_type, deadline, basis, source_refs, confidence, scan_id, updated_at
			FROM immigration_deadlines
			WHERE tenant_id = $1::uuid
			  AND deadline BETWEEN current_date AND current_date + ($2 * interval '1 day')
			ORDER BY deadline ASC`
		args = []any{tenantID, windowDays}
	} else {
		q = `
			SELECT id, who, doc_type, deadline, basis, source_refs, confidence, scan_id, updated_at
			FROM immigration_deadlines
			WHERE tenant_id = $1::uuid
			  AND deadline >= current_date
			ORDER BY deadline ASC`
		args = []any{tenantID}
	}

	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("query immigration_deadlines: %w", err)
	}
	defer rows.Close()

	var results []storedImmigrationDeadline
	for rows.Next() {
		var r storedImmigrationDeadline
		var deadlineTime time.Time
		var refs []byte
		if err := rows.Scan(&r.ID, &r.Who, &r.DocType, &deadlineTime,
			&r.Basis, &refs, &r.Confidence, &r.ScanID, &r.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan immigration_deadlines row: %w", err)
		}
		r.Deadline = deadlineTime.Format("2006-01-02")
		_ = json.Unmarshal(refs, &r.SourceRefs)
		results = append(results, r)
	}
	return results, rows.Err()
}

// newImmigrationScanID returns a random UUID v4 string for grouping a scan's results.
func newImmigrationScanID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant bits RFC 4122
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// ---------- Jarvis brief integration ----------

// immigrationBriefSection returns a brief line listing immigration deadlines
// within the next 90 days, or "" if none / flag is off.
// Called from JarvisHandler.composeBrief (additive, non-breaking).
func immigrationBriefSection(ctx context.Context, srv *server.Server, tenantID string, logger *zap.Logger) string {
	if !immigrationSentinelEnabled() {
		return ""
	}

	var rows []storedImmigrationDeadline
	tCtx := middleware.InjectTenantID(ctx, tenantID)
	if err := srv.WithTenant(tCtx, func(tx pgx.Tx) error {
		var qerr error
		rows, qerr = queryImmigrationDeadlines(tCtx, tx, tenantID, 90)
		return qerr
	}); err != nil {
		// A query failure must NOT look like "no deadlines" — that would drop a
		// looming EAD/RFE clock from the brief with no signal. Log and omit.
		if logger != nil {
			logger.Warn("immigration brief query failed — section omitted", zap.Error(err))
		}
		return ""
	}
	if len(rows) == 0 {
		return ""
	}

	var sb strings.Builder
	sb.WriteString("⚠️ Immigration deadlines coming up:\n")
	for _, r := range rows {
		deadline, _ := time.Parse("2006-01-02", r.Deadline)
		daysLeft := int(time.Until(deadline).Hours() / 24)
		urgency := ""
		switch {
		case daysLeft <= 14:
			urgency = " 🔴 URGENT"
		case daysLeft <= 30:
			urgency = " 🟠 soon"
		}
		sb.WriteString(fmt.Sprintf("  • %s %s — %s%s (%d days)\n",
			r.Who, r.DocType, r.Deadline, urgency, daysLeft))
	}
	return strings.TrimRight(sb.String(), "\n")
}
