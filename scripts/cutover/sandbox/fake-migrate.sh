#!/bin/bash
# What the release API does on start, for the sandbox: golang-migrate Up() to the
# newest embedded migration, and (like 0036_pal_brand_rename) rename the app role
# ONLY if the old one exists and the new one does not. Uses the throwaway DB.
set -uo pipefail
psql_() { "$STUB_REAL_DOCKER" exec -i "$STUB_DB_CONTAINER" psql -X -q -At -v ON_ERROR_STOP=1 "$@"; }
u="$DB_NEW_USER"; d="$DB_NEW_NAME"
psql_ -U "$u" -d "$d" -c 'select 1' >/dev/null 2>&1 || { u="$DB_OLD_USER"; d="$DB_OLD_NAME"; }
mdir="$REPO_DIR/services/control-plane/internal/db/migrations"
max="$(find "$mdir" -name '*.up.sql' -exec basename {} \; | sed -nE 's/^0*([0-9]+)_.*$/\1/p' | sort -n | tail -1)"
psql_ -U "$u" -d "$d" -c "UPDATE schema_migrations SET version=$max, dirty=false"
if [[ -n "$(find "$mdir" -name '*_pal_brand_rename.up.sql')" ]]; then
  psql_ -U "$u" -d postgres <<SQL
DO \$\$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='$DB_OLD_APP_ROLE') AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='$DB_NEW_APP_ROLE') THEN
    EXECUTE 'ALTER ROLE $DB_OLD_APP_ROLE RENAME TO $DB_NEW_APP_ROLE';
    RAISE NOTICE 'migration renamed the app role';
  END IF;
END \$\$;
SQL
fi
echo "fake-migrate: $u@$d -> v$max"
