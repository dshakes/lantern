// Command migrate applies the control-plane database schema and exits.
//
// The control-plane normally migrates on server startup, but CI (and ops)
// need a way to apply the schema without booting the full server — e.g. so
// DB-gated tests have their tables before `go test` runs. Reads DATABASE_URL;
// set SEED_DEV=1 to also seed the dev tenant/admin (used in CI + local dev).
package main

import (
	"context"
	"log"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dshakes/lantern/services/control-plane/internal/db"
)

func main() {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		log.Fatal("migrate: DATABASE_URL is required")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		log.Fatalf("migrate: connect: %v", err)
	}
	defer pool.Close()

	seedDev := os.Getenv("SEED_DEV") == "1" || os.Getenv("SEED_DEV") == "true"
	if err := db.Migrate(ctx, pool, seedDev); err != nil {
		log.Fatalf("migrate: %v", err)
	}
	log.Printf("migrate: schema applied (seedDev=%v)", seedDev)
}
