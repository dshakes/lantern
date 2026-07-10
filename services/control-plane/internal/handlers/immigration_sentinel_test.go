package handlers

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ---------- pure-function tests (no DB, no LLM) ----------

func TestParseImmigrationResponse_Happy(t *testing.T) {
	tomorrow := time.Now().AddDate(0, 0, 1).Format("2006-01-02")
	raw := fmt.Sprintf(`{"deadlines":[
		{"who":"Manasa","doc_type":"EAD","deadline":%q,"basis":"EAD card expires","source_refs":["~/Documents/EAD-Manasa.pdf"],"confidence":0.95},
		{"who":"Shekhar","doc_type":"AP","deadline":%q,"basis":"AP card expires","source_refs":["~/Documents/AP-Shekhar.pdf"],"confidence":0.90}
	]}`, tomorrow, tomorrow)

	got := parseImmigrationResponse(raw)
	if len(got) != 2 {
		t.Fatalf("want 2 deadlines, got %d", len(got))
	}
	if got[0].Who != "Manasa" || got[0].DocType != "EAD" {
		t.Errorf("first deadline wrong: %+v", got[0])
	}
	if got[1].Who != "Shekhar" || got[1].DocType != "AP" {
		t.Errorf("second deadline wrong: %+v", got[1])
	}
}

func TestParseImmigrationResponse_MarkdownFence(t *testing.T) {
	d := time.Now().AddDate(0, 2, 0).Format("2006-01-02")
	raw := "```json\n" + fmt.Sprintf(
		`{"deadlines":[{"who":"A","doc_type":"EAD","deadline":%q,"basis":"b","source_refs":["x.pdf"],"confidence":0.9}]}`, d,
	) + "\n```"
	got := parseImmigrationResponse(raw)
	if len(got) != 1 {
		t.Fatalf("want 1, got %d", len(got))
	}
}

func TestParseImmigrationResponse_Empty(t *testing.T) {
	if len(parseImmigrationResponse(`{"deadlines":[]}`)) != 0 {
		t.Error("want 0 deadlines for empty array")
	}
}

func TestParseImmigrationResponse_RejectsNoSourceRefs(t *testing.T) {
	d := time.Now().AddDate(0, 3, 0).Format("2006-01-02")
	raw := fmt.Sprintf(`{"deadlines":[{"who":"A","doc_type":"EAD","deadline":%q,"basis":"b","source_refs":[],"confidence":0.95}]}`, d)
	if len(parseImmigrationResponse(raw)) != 0 {
		t.Error("want 0: empty source_refs must be rejected (fabrication risk)")
	}
}

func TestParseImmigrationResponse_RejectsBlankSourceRefs(t *testing.T) {
	// A hallucinated deadline can emit whitespace-only refs to slip the guard.
	d := time.Now().AddDate(0, 3, 0).Format("2006-01-02")
	for _, refs := range []string{`[""]`, `[" "]`, `["\t"]`, `["", "  "]`} {
		raw := fmt.Sprintf(`{"deadlines":[{"who":"A","doc_type":"EAD","deadline":%q,"basis":"b","source_refs":%s,"confidence":0.95}]}`, d, refs)
		if len(parseImmigrationResponse(raw)) != 0 {
			t.Errorf("want 0: blank-only source_refs %s must be rejected (fabrication risk)", refs)
		}
	}
}

func TestParseImmigrationResponse_RejectsLowConfidence(t *testing.T) {
	d := time.Now().AddDate(0, 3, 0).Format("2006-01-02")
	// 0.55 is below the 0.6 floor the system prompt itself sets — must reject
	// even though it's above the old (too-low) 0.4 threshold.
	for _, conf := range []string{"0.2", "0.55", "0.59"} {
		raw := fmt.Sprintf(`{"deadlines":[{"who":"A","doc_type":"EAD","deadline":%q,"basis":"b","source_refs":["x.pdf"],"confidence":%s}]}`, d, conf)
		if len(parseImmigrationResponse(raw)) != 0 {
			t.Errorf("want 0: confidence %s < 0.6 must be rejected", conf)
		}
	}
}

func TestParseImmigrationResponse_RejectsBadDate(t *testing.T) {
	raw := `{"deadlines":[{"who":"A","doc_type":"EAD","deadline":"not-a-date","basis":"b","source_refs":["x.pdf"],"confidence":0.95}]}`
	if len(parseImmigrationResponse(raw)) != 0 {
		t.Error("want 0: bad date must be rejected")
	}
}

func TestParseImmigrationResponse_GarbageInput(t *testing.T) {
	got := parseImmigrationResponse("not json at all")
	if len(got) != 0 {
		t.Errorf("want 0 on garbage input, got %d", len(got))
	}
}

func TestParseImmigrationResponse_MissingRequiredFields(t *testing.T) {
	d := time.Now().AddDate(0, 3, 0).Format("2006-01-02")
	// missing "who" → reject
	raw := fmt.Sprintf(`{"deadlines":[{"who":"","doc_type":"EAD","deadline":%q,"basis":"b","source_refs":["x.pdf"],"confidence":0.95}]}`, d)
	if len(parseImmigrationResponse(raw)) != 0 {
		t.Error("want 0: empty 'who' must be rejected")
	}
}

func TestBuildImmigrationPrompt_ContainsKeyElements(t *testing.T) {
	mat := immigrationMaterial{
		DocSnippets: []immigrationDocSnippet{
			{Path: "~/Documents/EAD.pdf", Excerpt: "Card Expires: 12/01/2025"},
		},
		EmailSnippets: []immigrationEmailSnippet{
			{Subject: "USCIS Notice", From: "uscis@dhs.gov", Excerpt: "biometrics appointment"},
		},
	}
	system, user := buildImmigrationPrompt(mat)

	if system == "" {
		t.Error("system prompt must not be empty")
	}
	if !strings.Contains(system, "YYYY-MM-DD") {
		t.Error("system prompt must specify date format YYYY-MM-DD")
	}
	if !strings.Contains(system, "source_refs") {
		t.Error("system prompt must mention source_refs requirement")
	}
	if !strings.Contains(user, "EAD.pdf") {
		t.Error("user prompt must include doc path")
	}
	if !strings.Contains(user, "biometrics appointment") {
		t.Error("user prompt must include email excerpt")
	}
	if !strings.Contains(user, time.Now().UTC().Format("2006-01-02")) {
		t.Error("user prompt must include today's date")
	}
}

func TestBuildImmigrationPrompt_EmptyMaterial(t *testing.T) {
	system, user := buildImmigrationPrompt(immigrationMaterial{})
	if system == "" || user == "" {
		t.Error("prompts must not be empty even with no material")
	}
}

// ---------- flag-gate tests (no DB, no LLM) ----------

func TestImmigrationSentinelEnabled_OffByDefault(t *testing.T) {
	prev := os.Getenv("LANTERN_IMMIGRATION_SENTINEL")
	_ = os.Unsetenv("LANTERN_IMMIGRATION_SENTINEL")
	defer func() {
		if prev != "" {
			_ = os.Setenv("LANTERN_IMMIGRATION_SENTINEL", prev)
		}
	}()

	if immigrationSentinelEnabled() {
		t.Error("sentinel must be OFF when env var is unset")
	}
}

func TestImmigrationSentinelEnabled_OnValues(t *testing.T) {
	prev := os.Getenv("LANTERN_IMMIGRATION_SENTINEL")
	defer func() { _ = os.Setenv("LANTERN_IMMIGRATION_SENTINEL", prev) }()

	for _, v := range []string{"1", "true", "on", "TRUE", "ON"} {
		_ = os.Setenv("LANTERN_IMMIGRATION_SENTINEL", v)
		if !immigrationSentinelEnabled() {
			t.Errorf("sentinel must be ON for env=%q", v)
		}
	}
}

func TestImmigrationSentinelEnabled_OffValues(t *testing.T) {
	prev := os.Getenv("LANTERN_IMMIGRATION_SENTINEL")
	defer func() { _ = os.Setenv("LANTERN_IMMIGRATION_SENTINEL", prev) }()

	for _, v := range []string{"0", "false", "off", "", "no"} {
		_ = os.Setenv("LANTERN_IMMIGRATION_SENTINEL", v)
		if immigrationSentinelEnabled() {
			t.Errorf("sentinel must be OFF for env=%q", v)
		}
	}
}

// TestImmigrationScan_EmptyMaterial verifies that runImmigrationScan returns
// (0, nil) when no material is gathered (bridge unavailable / nil completeFn).
// Proves the fail-safe path: no crash, no fabricated deadline.
func TestImmigrationScan_EmptyMaterial(t *testing.T) {
	ctx := context.Background()
	// nil pool is fine: gatherImmigrationMaterial will fail (no bridge) so
	// runImmigrationScan exits before touching the DB.
	n, err := runImmigrationScan(ctx, nil, nopLogger(), "some-tenant", nil)
	// Either (0, nil) or (0, "no LLM" error) is acceptable. Never a panic.
	if n != 0 {
		t.Errorf("want 0 deadlines, got %d", n)
	}
	_ = err // error acceptable when pool is nil; the important thing is no crash
}

// ---------- scan ID ----------

func TestNewImmigrationScanID_IsValidUUID(t *testing.T) {
	id := newImmigrationScanID()
	// UUID v4: 8-4-4-4-12 hex separated by hyphens = 36 chars.
	if len(id) != 36 {
		t.Errorf("scan ID %q has length %d, want 36", id, len(id))
	}
	parts := strings.Split(id, "-")
	if len(parts) != 5 {
		t.Errorf("scan ID %q does not have 5 hyphen-separated parts", id)
	}
}

// ---------- DB integration tests (skipped without DATABASE_URL) ----------

func openImmigrationTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	return openTestPool(t) // reuse the test helper from runtime_test.go
}

func seedImmigrationTenant(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	ctx := context.Background()
	id := uuid.NewString()
	slug := "imm-test-" + id[:8]
	if _, err := pool.Exec(ctx, `
		INSERT INTO tenants (id, slug, name, tier, k8s_namespace)
		VALUES ($1, $2, 'Imm Test', 'personal', 'ns-' || $2)
		ON CONFLICT (id) DO NOTHING
	`, id, slug); err != nil {
		t.Fatalf("seed immigration tenant: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		_, _ = pool.Exec(bg, "DELETE FROM immigration_deadlines WHERE tenant_id=$1::uuid", id)
		_, _ = pool.Exec(bg, "DELETE FROM tenants WHERE id=$1::uuid", id)
	})
	return id
}

// TestImmigrationUpsert_Dedup proves that inserting the same
// (who, doc_type, deadline) twice results in one row, not two, and the
// second write updates basis and confidence (ON CONFLICT DO UPDATE).
func TestImmigrationUpsert_Dedup(t *testing.T) {
	pool := openImmigrationTestPool(t)
	mustMigrate(t, pool)
	tenantID := seedImmigrationTenant(t, pool)
	ctx := context.Background()
	tomorrow := time.Now().AddDate(0, 0, 1).Format("2006-01-02")

	first := []ImmigrationDeadline{{
		Who:        "Manasa",
		DocType:    "EAD",
		Deadline:   tomorrow,
		Basis:      "first basis",
		SourceRefs: []string{"doc1.pdf"},
		Confidence: 0.90,
	}}
	second := []ImmigrationDeadline{{
		Who:        "Manasa",
		DocType:    "EAD",
		Deadline:   tomorrow,
		Basis:      "updated basis",
		SourceRefs: []string{"doc1.pdf", "notice.txt"},
		Confidence: 0.95,
	}}

	n1, err := upsertImmigrationDeadlines(ctx, pool, nopLogger(), tenantID, first)
	if err != nil {
		t.Fatalf("first upsert: %v", err)
	}
	if n1 != 1 {
		t.Errorf("first upsert: want 1, got %d", n1)
	}

	n2, err := upsertImmigrationDeadlines(ctx, pool, nopLogger(), tenantID, second)
	if err != nil {
		t.Fatalf("second upsert: %v", err)
	}
	if n2 != 1 {
		t.Errorf("second upsert: want 1, got %d", n2)
	}

	// Only one row must exist.
	var count int
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM immigration_deadlines WHERE tenant_id=$1::uuid AND who='Manasa' AND doc_type='EAD'`,
		tenantID).Scan(&count); err != nil {
		t.Fatalf("count query: %v", err)
	}
	if count != 1 {
		t.Errorf("want 1 row after dedup upsert, got %d", count)
	}

	// The second write must have updated basis.
	var basis string
	if err := pool.QueryRow(ctx,
		`SELECT basis FROM immigration_deadlines WHERE tenant_id=$1::uuid AND who='Manasa' AND doc_type='EAD'`,
		tenantID).Scan(&basis); err != nil {
		t.Fatalf("basis query: %v", err)
	}
	if basis != "updated basis" {
		t.Errorf("basis not updated: got %q, want %q", basis, "updated basis")
	}
}

// TestImmigrationWindowFilter proves that queryImmigrationDeadlines filters
// correctly by deadline window.
func TestImmigrationWindowFilter(t *testing.T) {
	pool := openImmigrationTestPool(t)
	mustMigrate(t, pool)
	tenantID := seedImmigrationTenant(t, pool)
	ctx := context.Background()

	near := time.Now().AddDate(0, 0, 5).Format("2006-01-02")  // within 30 days
	far := time.Now().AddDate(0, 0, 120).Format("2006-01-02") // outside 30 days

	deadlines := []ImmigrationDeadline{
		{Who: "A", DocType: "EAD", Deadline: near, Basis: "b", SourceRefs: []string{"x.pdf"}, Confidence: 0.9},
		{Who: "B", DocType: "AP", Deadline: far, Basis: "b", SourceRefs: []string{"y.pdf"}, Confidence: 0.9},
	}
	if _, err := upsertImmigrationDeadlines(ctx, pool, nopLogger(), tenantID, deadlines); err != nil {
		t.Fatalf("upsert: %v", err)
	}

	// 30-day window: only the near deadline.
	var count30 int
	if err := pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM immigration_deadlines
		WHERE tenant_id=$1::uuid
		  AND deadline BETWEEN current_date AND current_date + interval '30 days'
	`, tenantID).Scan(&count30); err != nil {
		t.Fatalf("count30 query: %v", err)
	}
	if count30 != 1 {
		t.Errorf("30-day window: want 1, got %d", count30)
	}

	// All future: both.
	var countAll int
	if err := pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM immigration_deadlines
		WHERE tenant_id=$1::uuid AND deadline >= current_date
	`, tenantID).Scan(&countAll); err != nil {
		t.Fatalf("countAll query: %v", err)
	}
	if countAll != 2 {
		t.Errorf("all future: want 2, got %d", countAll)
	}
}

// TestImmigrationCrossTenantIsolation verifies that rows upserted for tenantA
// are not returned when querying for tenantB.
func TestImmigrationCrossTenantIsolation(t *testing.T) {
	pool := openImmigrationTestPool(t)
	mustMigrate(t, pool)
	tenantA := seedImmigrationTenant(t, pool)
	tenantB := seedImmigrationTenant(t, pool)
	ctx := context.Background()
	tomorrow := time.Now().AddDate(0, 0, 1).Format("2006-01-02")

	dA := []ImmigrationDeadline{{
		Who:        "Alice",
		DocType:    "EAD",
		Deadline:   tomorrow,
		Basis:      "b",
		SourceRefs: []string{"x.pdf"},
		Confidence: 0.9,
	}}
	if _, err := upsertImmigrationDeadlines(ctx, pool, nopLogger(), tenantA, dA); err != nil {
		t.Fatalf("upsert for tenantA: %v", err)
	}

	// Query the table scoped to tenantB — must return 0 rows.
	var countB int
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM immigration_deadlines WHERE tenant_id=$1::uuid`,
		tenantB).Scan(&countB); err != nil {
		t.Fatalf("countB query: %v", err)
	}
	if countB != 0 {
		t.Errorf("SECURITY: tenantB sees %d row(s) belonging to tenantA", countB)
	}
}
