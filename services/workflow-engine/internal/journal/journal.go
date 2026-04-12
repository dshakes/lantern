package journal

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// JournalEntry represents a single event in a run's journal. The journal is
// the source of truth for a run's execution history — all state is derived
// from replaying these entries in sequence order.
type JournalEntry struct {
	RunID     string          `json:"run_id"`
	Seq       int64           `json:"seq"`
	Kind      string          `json:"kind"`
	StepID    string          `json:"step_id,omitempty"`
	Attempt   int             `json:"attempt"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt time.Time       `json:"created_at"`
}

// Append writes a journal entry within the given transaction. The sequence
// number is assigned by the database using a subquery to find the current max
// for the run, guaranteeing gap-free monotonic ordering per run.
func Append(ctx context.Context, tx pgx.Tx, entry *JournalEntry) error {
	return tx.QueryRow(ctx, `
		INSERT INTO journal_events (run_id, seq, kind, step_id, attempt, payload)
		VALUES (
			$1,
			COALESCE((SELECT MAX(seq) FROM journal_events WHERE run_id = $1), 0) + 1,
			$2, $3, $4, $5
		)
		RETURNING seq, created_at
	`, entry.RunID, entry.Kind, entry.StepID, entry.Attempt, []byte(entry.Payload),
	).Scan(&entry.Seq, &entry.CreatedAt)
}

// Load reads the full journal for a run, ordered by sequence number.
func Load(ctx context.Context, pool *pgxpool.Pool, runID string) ([]JournalEntry, error) {
	return LoadFrom(ctx, pool, runID, 0)
}

// LoadFrom reads journal entries for a run starting from (and including) the
// given sequence number. Pass fromSeq=0 to load the entire journal.
func LoadFrom(ctx context.Context, pool *pgxpool.Pool, runID string, fromSeq int64) ([]JournalEntry, error) {
	rows, err := pool.Query(ctx, `
		SELECT run_id, seq, kind, COALESCE(step_id, ''), attempt, payload, created_at
		FROM journal_events
		WHERE run_id = $1 AND seq >= $2
		ORDER BY seq ASC
	`, runID, fromSeq)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var entries []JournalEntry
	for rows.Next() {
		var e JournalEntry
		var payload []byte
		if err := rows.Scan(&e.RunID, &e.Seq, &e.Kind, &e.StepID, &e.Attempt, &payload, &e.CreatedAt); err != nil {
			return nil, err
		}
		e.Payload = json.RawMessage(payload)
		entries = append(entries, e)
	}
	return entries, rows.Err()
}

// LoadTx reads the full journal for a run within an existing transaction.
func LoadTx(ctx context.Context, tx pgx.Tx, runID string) ([]JournalEntry, error) {
	rows, err := tx.Query(ctx, `
		SELECT run_id, seq, kind, COALESCE(step_id, ''), attempt, payload, created_at
		FROM journal_events
		WHERE run_id = $1
		ORDER BY seq ASC
	`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var entries []JournalEntry
	for rows.Next() {
		var e JournalEntry
		var payload []byte
		if err := rows.Scan(&e.RunID, &e.Seq, &e.Kind, &e.StepID, &e.Attempt, &payload, &e.CreatedAt); err != nil {
			return nil, err
		}
		e.Payload = json.RawMessage(payload)
		entries = append(entries, e)
	}
	return entries, rows.Err()
}
