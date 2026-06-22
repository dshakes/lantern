package db

import (
	"context"
	"embed"
	"errors"
	"fmt"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database/postgres"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Migrate applies all pending schema migrations and, when seedDev is true,
// inserts the well-known dev tenant and admin user.
//
// The schema migrations are versioned SQL files embedded from
// internal/db/migrations/. The dev seed is data (not schema) and must never
// run in production.
func Migrate(ctx context.Context, pool *pgxpool.Pool, seedDev bool) error {
	sqlDB := stdlib.OpenDB(*pool.Config().ConnConfig)
	defer sqlDB.Close()

	src, err := iofs.New(migrationsFS, "migrations")
	if err != nil {
		return fmt.Errorf("db.Migrate: build iofs source: %w", err)
	}

	driver, err := postgres.WithInstance(sqlDB, &postgres.Config{})
	if err != nil {
		return fmt.Errorf("db.Migrate: build postgres driver: %w", err)
	}

	m, err := migrate.NewWithInstance("iofs", src, "postgres", driver)
	if err != nil {
		return fmt.Errorf("db.Migrate: create migrator: %w", err)
	}

	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("db.Migrate: apply migrations: %w", err)
	}

	if seedDev {
		for i, stmt := range devSeedStatements {
			if _, err := pool.Exec(ctx, stmt); err != nil {
				return fmt.Errorf("dev seed statement %d failed: %w", i, err)
			}
		}
	}
	return nil
}

// devSeedStatements are run only when seedDev is true (local development).
// They create a fixed tenant + admin account with a well-known password so
// `make dev` works out-of-the-box without any manual bootstrapping.
// These statements MUST NOT run in production — a static bcrypt hash for a
// known password ("lantern") is a trivially-exploitable backdoor.
var devSeedStatements = []string{
	// ---------------------------------------------------------------
	// Seed default dev tenant and admin user
	// Password is "lantern" hashed with bcrypt.
	// ---------------------------------------------------------------
	`INSERT INTO tenants (id, slug, name, tier, k8s_namespace)
	 VALUES ('00000000-0000-0000-0000-000000000001', 'dev', 'Development', 'team', 'lantern-t-dev')
	 ON CONFLICT (id) DO NOTHING`,

	`INSERT INTO users (id, tenant_id, email, display_name, auth_provider, auth_subject, password_hash, role)
	 VALUES (
		'00000000-0000-0000-0000-000000000002',
		'00000000-0000-0000-0000-000000000001',
		'admin@lantern.dev',
		'Admin',
		'local',
		'admin@lantern.dev',
		'$2b$10$.hAunSjVIs5aiTYrzIAmfuLbpy1Im2N4xIvhjFVG5v3fak/eeyP7W',
		'owner'
	 )
	 ON CONFLICT DO NOTHING`,
}
