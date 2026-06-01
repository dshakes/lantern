package handlers

// Gmail + Calendar ingestion into the unified timeline (Phase 2c).
//
// A periodic background job pulls recent Gmail messages and upcoming
// Calendar events, maps each to a canonical person by email, and writes
// them to memory_events (deduped by external_id). Now "what did Madhu
// email me about" and "what meetings do I have with Madhu" both join the
// same cross-channel timeline the bridges already populate.
//
// Everything is best-effort: if a connector isn't installed or a pull
// fails, we log and move on. Gated by LANTERN_MEMORY_INGEST (default on).

import (
	"context"
	"crypto/sha1"
	"encoding/json"
	"fmt"
	"net/mail"
	"os"
	"strings"
	"time"

	"go.uber.org/zap"

	"github.com/jackc/pgx/v5/pgxpool"
)

type MemoryIngestor struct {
	pool     *pgxpool.Pool
	logger   *zap.Logger
	identity *IdentityHandler
	tenantID string
	interval time.Duration
}

func NewMemoryIngestor(pool *pgxpool.Pool, logger *zap.Logger, identity *IdentityHandler) *MemoryIngestor {
	interval := 15 * time.Minute
	if v := strings.TrimSpace(os.Getenv("LANTERN_MEMORY_INGEST_INTERVAL")); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d >= time.Minute {
			interval = d
		}
	}
	return &MemoryIngestor{
		pool:     pool,
		logger:   logger.Named("memory-ingest"),
		identity: identity,
		tenantID: getEnvOr("LANTERN_DEFAULT_TENANT_ID", "00000000-0000-0000-0000-000000000001"),
		interval: interval,
	}
}

// Enabled reports whether ingestion should run (default on; off via env).
func (m *MemoryIngestor) Enabled() bool {
	return strings.ToLower(strings.TrimSpace(os.Getenv("LANTERN_MEMORY_INGEST"))) != "off"
}

// Run loops until ctx is cancelled. First tick fires after a short delay
// so it doesn't compete with startup.
func (m *MemoryIngestor) Run(ctx context.Context) {
	if !m.Enabled() {
		m.logger.Info("memory ingestion disabled (LANTERN_MEMORY_INGEST=off)")
		return
	}
	m.logger.Info("memory ingestion started", zap.Duration("interval", m.interval))
	select {
	case <-ctx.Done():
		return
	case <-time.After(30 * time.Second):
	}
	m.tick(ctx)
	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.tick(ctx)
		}
	}
}

func (m *MemoryIngestor) tick(ctx context.Context) {
	tctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	g := m.ingestGmail(tctx)
	c := m.ingestCalendar(tctx)
	if g > 0 || c > 0 {
		m.logger.Info("memory ingest tick", zap.Int("gmail", g), zap.Int("calendar", c))
	}
	// Eventual-consistency: embed any rows that still lack an embedding
	// (rate-limited earlier, or written before embeddings were enabled).
	m.identity.backfillEmbeddings(tctx, m.tenantID, 50)
}

// ownerEmail returns the lowercased owner email, used to skip self.
func ownerEmail() string {
	return strings.ToLower(strings.TrimSpace(os.Getenv("LANTERN_OWNER_EMAIL")))
}

// ingestGmail pulls recent messages and records them against the sender.
func (m *MemoryIngestor) ingestGmail(ctx context.Context) int {
	result, err := executeConnectorAction(ctx, m.pool, m.tenantID, "gmail", "list_messages", map[string]any{"limit": 25})
	if err != nil {
		m.logger.Debug("gmail ingest skipped", zap.Error(err))
		return 0
	}
	var parsed struct {
		Messages []struct {
			From    string `json:"from"`
			Subject string `json:"subject"`
			Date    string `json:"date"`
			Snippet string `json:"snippet"`
		} `json:"messages"`
	}
	if !remarshal(result, &parsed) {
		return 0
	}
	owner := ownerEmail()
	count := 0
	for _, msg := range parsed.Messages {
		name, email := parseEmailAddress(msg.From)
		if email == "" || strings.EqualFold(email, owner) {
			continue // skip unparseable + the owner's own sent mail
		}
		personID, _, err := m.identity.resolvePerson(ctx, m.tenantID, "email", email, name)
		if err != nil {
			continue
		}
		subject := strings.TrimSpace(msg.Subject)
		content := strings.TrimSpace(subject + " — " + msg.Snippet)
		// Stable synthetic id (Gmail metadata fetch doesn't expose the id):
		// same sender+subject+date never re-ingests.
		extID := shortHash(email + "|" + subject + "|" + msg.Date)
		occurred := parseEmailDate(msg.Date)
		inserted, err := m.identity.ingestExternal(ctx, m.tenantID, personID, "gmail", "email", content, extID, occurred,
			map[string]any{"from": email, "subject": subject})
		if err != nil {
			m.logger.Debug("gmail event insert failed", zap.Error(err))
			continue
		}
		if inserted {
			count++
		}
	}
	return count
}

// ingestCalendar pulls upcoming events and records them against each
// non-owner attendee, so per-person meeting history is queryable.
func (m *MemoryIngestor) ingestCalendar(ctx context.Context) int {
	result, err := executeConnectorAction(ctx, m.pool, m.tenantID, "google-calendar", "list_events", map[string]any{"limit": 25})
	if err != nil {
		m.logger.Debug("calendar ingest skipped", zap.Error(err))
		return 0
	}
	var parsed struct {
		Items []struct {
			ID      string `json:"id"`
			Summary string `json:"summary"`
			Start   struct {
				DateTime string `json:"dateTime"`
				Date     string `json:"date"`
			} `json:"start"`
			Attendees []struct {
				Email string `json:"email"`
			} `json:"attendees"`
		} `json:"items"`
	}
	if !remarshal(result, &parsed) {
		return 0
	}
	owner := ownerEmail()
	count := 0
	for _, ev := range parsed.Items {
		summary := strings.TrimSpace(ev.Summary)
		if summary == "" {
			summary = "(no title)"
		}
		when := ev.Start.DateTime
		if when == "" {
			when = ev.Start.Date
		}
		occurred := parseEmailDate(when) // RFC3339 also parses here
		content := fmt.Sprintf("📅 %s (%s)", summary, when)
		for _, att := range ev.Attendees {
			email := strings.ToLower(strings.TrimSpace(att.Email))
			if email == "" || strings.EqualFold(email, owner) {
				continue
			}
			personID, _, err := m.identity.resolvePerson(ctx, m.tenantID, "email", email, "")
			if err != nil {
				continue
			}
			// One row per (event, attendee) so re-pulls dedup cleanly.
			extID := shortHash(ev.ID + "|" + email)
			inserted, err := m.identity.ingestExternal(ctx, m.tenantID, personID, "calendar", "event", content, extID, occurred,
				map[string]any{"summary": summary, "start": when})
			if err != nil {
				continue
			}
			if inserted {
				count++
			}
		}
	}
	return count
}

// ---- helpers ---------------------------------------------------------------

// remarshal JSON-round-trips an arbitrary connector result into a typed
// target, insulating us from whether the executor returned typed structs
// or maps. Returns false on failure.
func remarshal(v any, target any) bool {
	b, err := json.Marshal(v)
	if err != nil {
		return false
	}
	return json.Unmarshal(b, target) == nil
}

// parseEmailAddress splits a From header ("Madhu K <madhu@x.com>") into a
// display name + lowercased email. Falls back to the raw string as email.
func parseEmailAddress(raw string) (name, email string) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", ""
	}
	if addr, err := mail.ParseAddress(raw); err == nil {
		return strings.TrimSpace(addr.Name), strings.ToLower(addr.Address)
	}
	if strings.Contains(raw, "@") && !strings.ContainsAny(raw, " <>") {
		return "", strings.ToLower(raw)
	}
	return "", ""
}

// parseEmailDate best-efforts an RFC1123/RFC3339 date string to a time,
// falling back to now so an unparseable header never drops the event.
func parseEmailDate(s string) time.Time {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Now()
	}
	for _, layout := range []string{time.RFC1123Z, time.RFC1123, time.RFC3339, "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Now()
}

// shortHash gives a stable external_id from arbitrary identifying text.
func shortHash(s string) string {
	sum := sha1.Sum([]byte(s))
	return fmt.Sprintf("%x", sum[:10])
}
