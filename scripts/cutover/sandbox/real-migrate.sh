#!/bin/bash
# E2E stand-in for "the API runs its migrations on start": the REAL golang-migrate
# binary of whichever checkout is live (zero-lantern when the brand migration is
# present, master otherwise), against the throwaway Postgres container's port.
set -uo pipefail
mdir="$REPO_DIR/services/control-plane/internal/db/migrations"
bin="$MIGRATE_MASTER"
[[ -n "$(find "$mdir" -name '*_pal_brand_rename.up.sql')" ]] && bin="$MIGRATE_ZERO"
for cand in "$DB_NEW_USER:pal:$DB_NEW_NAME" "$DB_OLD_USER:lantern:$DB_OLD_NAME"; do
  IFS=: read -r u p d <<< "$cand"
  if "$STUB_REAL_DOCKER" exec "$STUB_DB_CONTAINER" psql -U "$u" -d "$d" -Atc 'select 1' >/dev/null 2>&1; then
    echo "real-migrate: $(basename "$bin") on $u@$d"
    DATABASE_URL="postgres://$u:$p@127.0.0.1:${E2E_PORT:?}/$d?sslmode=disable" SEED_DEV=1 "$bin"
    exit $?
  fi
done
echo "real-migrate: no reachable DB"
exit 1
