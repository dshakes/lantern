// Command reencrypt-credentials re-writes stored credentials through the
// current LANTERN_CREDENTIAL_KEY.
//
// # Why this exists
//
// internal/secrets encrypts on write and detects legacy plaintext on read, so
// setting a key for the first time is backward compatible — but existing rows
// stay plaintext until something happens to rewrite them. For an LLM API key
// or an OAuth token that may be never. This turns "encrypted eventually" into
// "encrypted now", and is also the re-encrypt half of a key rotation
// (ADR 0008: rotation = set the new key, then re-encrypt rows).
//
// # Safety
//
// Every row is verified before it is committed: the new ciphertext is decrypted
// and compared byte-for-byte against what was read. A mismatch aborts the whole
// transaction. Rows already encrypted under the CURRENT key are skipped, so the
// command is idempotent and safe to re-run.
//
// Rows encrypted under a DIFFERENT (lost) key cannot be read and are reported,
// not touched — the only fix for those is re-authorizing the connector.
//
// Usage:
//
//	LANTERN_CREDENTIAL_KEY=... DATABASE_URL=... go run ./cmd/reencrypt-credentials [-dry-run]
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dshakes/lantern/services/control-plane/internal/secrets"
)

// target describes one credential-bearing column.
type target struct {
	table  string
	column string
	idCol  string
	label  string
}

var targets = []target{
	{"llm_provider_configs", "api_key_encrypted", "id", "LLM provider key"},
	{"connector_installs", "oauth_token_encrypted", "id", "connector OAuth token"},
	{"connector_installs", "config", "id", "connector config"},
}

func main() {
	dryRun := flag.Bool("dry-run", false, "report what would change without writing")
	flag.Parse()

	enabled, err := secrets.EncryptionEnabled()
	if err != nil {
		fatalf("LANTERN_CREDENTIAL_KEY is malformed: %v", err)
	}
	if !enabled {
		fatalf("LANTERN_CREDENTIAL_KEY is not set — nothing to re-encrypt to.\n" +
			"Set a 32-byte key (openssl rand -hex 32) and re-run.")
	}

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		fatalf("DATABASE_URL is not set")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		fatalf("connect: %v", err)
	}
	defer pool.Close()

	var totalEncrypted, totalSkipped, totalUnreadable int
	for _, t := range targets {
		enc, skip, bad, err := process(ctx, pool, t, *dryRun)
		if err != nil {
			fatalf("%s.%s: %v", t.table, t.column, err)
		}
		totalEncrypted += enc
		totalSkipped += skip
		totalUnreadable += bad
	}

	fmt.Printf("\n%s: %d re-encrypted, %d already encrypted, %d unreadable\n",
		map[bool]string{true: "DRY RUN", false: "done"}[*dryRun],
		totalEncrypted, totalSkipped, totalUnreadable)

	if totalUnreadable > 0 {
		fmt.Printf("\n%d value(s) could not be decrypted — they were written under a different\n"+
			"key that is no longer available. Re-authorize those connectors; no tool can\n"+
			"recover the plaintext.\n", totalUnreadable)
	}
}

// process re-encrypts one column. Runs in a single transaction so a verify
// failure anywhere leaves the table untouched.
func process(ctx context.Context, pool *pgxpool.Pool, t target, dryRun bool) (encrypted, skipped, unreadable int, err error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, 0, 0, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit

	rows, err := tx.Query(ctx,
		fmt.Sprintf(`SELECT %s, %s FROM %s WHERE %s IS NOT NULL`, t.idCol, t.column, t.table, t.column))
	if err != nil {
		return 0, 0, 0, err
	}

	type pending struct {
		id    string
		value []byte
	}
	var todo []pending

	for rows.Next() {
		var id string
		var stored []byte
		if sErr := rows.Scan(&id, &stored); sErr != nil {
			rows.Close()
			return 0, 0, 0, sErr
		}
		plain, dErr := secrets.Decrypt(stored)
		if dErr != nil {
			// Encrypted under a key we do not have. Report, never touch.
			fmt.Printf("  ! %s %s: unreadable (%v)\n", t.label, id, dErr)
			unreadable++
			continue
		}
		// Already under the current key: Decrypt succeeded AND the stored form
		// carries the envelope marker.
		if isEnveloped(stored) {
			skipped++
			continue
		}
		todo = append(todo, pending{id: id, value: plain})
	}
	rows.Close()
	if rErr := rows.Err(); rErr != nil {
		return 0, 0, 0, rErr
	}

	for _, p := range todo {
		ct, eErr := secrets.Encrypt(p.value)
		if eErr != nil {
			return 0, 0, 0, fmt.Errorf("encrypt %s: %w", p.id, eErr)
		}
		// Verify BEFORE writing: the new ciphertext must decrypt back to
		// exactly what was read. Anything else aborts the transaction.
		back, vErr := secrets.Decrypt(ct)
		if vErr != nil {
			return 0, 0, 0, fmt.Errorf("verify %s: %w", p.id, vErr)
		}
		if string(back) != string(p.value) {
			return 0, 0, 0, fmt.Errorf("verify %s: round-trip mismatch — aborting, no rows changed", p.id)
		}
		if dryRun {
			encrypted++
			fmt.Printf("  ~ %s %s: would encrypt\n", t.label, p.id)
			continue
		}
		if _, uErr := tx.Exec(ctx,
			fmt.Sprintf(`UPDATE %s SET %s = $2::jsonb WHERE %s = $1`, t.table, t.column, t.idCol),
			p.id, string(ct)); uErr != nil {
			return 0, 0, 0, fmt.Errorf("update %s: %w", p.id, uErr)
		}
		encrypted++
		fmt.Printf("  + %s %s: encrypted\n", t.label, p.id)
	}

	if dryRun {
		return encrypted, skipped, unreadable, nil
	}
	return encrypted, skipped, unreadable, tx.Commit(ctx)
}

// isEnveloped reports whether a stored value already carries the secrets
// envelope marker — i.e. it is ciphertext under the CURRENT key, not legacy
// plaintext that merely decrypted successfully by passing through.
func isEnveloped(stored []byte) bool {
	var probe map[string]any
	if err := json.Unmarshal(stored, &probe); err != nil {
		return false
	}
	_, ok := probe["__lantern_enc__"]
	return ok
}

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "reencrypt-credentials: "+format+"\n", args...)
	os.Exit(1)
}
