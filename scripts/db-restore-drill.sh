#!/usr/bin/env bash
# db-restore-drill.sh -- prove a Postgres backup can actually be restored.
#
#   scripts/db-restore-drill.sh <lantern-ts.sql.gz>  restore a real backup (CronJob format; a pg_dump -Fc
#                                                    custom-format file also works) into a throwaway server
#   scripts/db-restore-drill.sh --self-test          seed a throwaway DB, dump it the way the CronJob does,
#                                                    restore it, compare
#
# Needs only docker. Scratch servers are removed on exit; nothing touches a live database.
# A backup you have never restored is a hope, not a backup -- run this against the newest dump
# monthly and after any schema/major-version change (docs/runbooks/db-restore.md).
#
# Env: DRILL_PG_IMAGE (default pgvector/pgvector:pg16, must match the server major version)
#      DRILL_EXPECT_TABLES (space-separated, default "agents runs journal_events")
set -euo pipefail

IMAGE="${DRILL_PG_IMAGE:-pgvector/pgvector:pg16}"
EXPECT="${DRILL_EXPECT_TABLES:-agents runs journal_events}"
NAME="lantern-restore-drill-$$"
SRC="${NAME}-src"
trap 'docker rm -f "$NAME" "$SRC" >/dev/null 2>&1 || true' EXIT

start() { # <container>
  docker run -d --name "$1" -e POSTGRES_PASSWORD=drill "$IMAGE" >/dev/null
  for _ in $(seq 60); do
    docker exec "$1" pg_isready -U postgres >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "FAIL: $1 did not become ready" >&2
  exit 1
}
psql_in() { docker exec -i "$1" psql -U postgres -v ON_ERROR_STOP=1 -qtAX "${@:2}"; }

GZ=0
start "$NAME"
case "${1:-}" in
  --self-test)
    EXPECT="drill_items"
    start "$SRC"
    psql_in "$SRC" <<'SQL'
CREATE TABLE drill_items (id serial PRIMARY KEY, body text NOT NULL);
INSERT INTO drill_items (body) SELECT 'row ' || g FROM generate_series(1, 250) g;
SQL
    # same flags as templates/backup-cronjob.yaml
    docker exec "$SRC" sh -c 'pg_dump -U postgres --no-owner --no-privileges --clean --if-exists postgres | gzip -9 > /tmp/restore.dump'
    docker cp "$SRC:/tmp/restore.dump" - | docker cp - "$NAME:/tmp/"
    GZ=1
    ;;
  "" | -h | --help)
    sed -n 2,11p "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
  *)
    [ -s "$1" ] || { echo "FAIL: $1 missing or empty" >&2; exit 1; }
    docker cp "$1" "$NAME:/tmp/restore.dump"
    case "$1" in *.gz) GZ=1 ;; esac
    ;;
esac

docker exec "$NAME" createdb -U postgres restored
# --exit-on-error: a restore that "mostly worked" is not a restore.
if [ "$GZ" = 1 ]; then
  docker exec "$NAME" sh -c 'gunzip -c /tmp/restore.dump | psql -U postgres -d restored -v ON_ERROR_STOP=1 -q -o /dev/null'
else
  docker exec "$NAME" pg_restore -U postgres -d restored --no-owner --exit-on-error /tmp/restore.dump
fi

fail=0
for t in $EXPECT; do
  n="$(psql_in "$NAME" -d restored -c "SELECT count(*) FROM public.\"$t\"" 2>/dev/null || echo MISSING)"
  printf '  %-20s %s rows\n' "$t" "$n"
  case "$n" in MISSING | 0) fail=1 ;; esac
done
if [ "${1:-}" = "--self-test" ]; then
  want="$(psql_in "$SRC" -c 'SELECT count(*) FROM drill_items')"
  got="$(psql_in "$NAME" -d restored -c 'SELECT count(*) FROM drill_items')"
  [ "$want" = "$got" ] || { echo "FAIL: source $want rows, restored $got" >&2; fail=1; }
fi
if [ "$fail" = 0 ]; then
  echo "restore drill: PASS"
else
  echo "restore drill: FAIL" >&2
  exit 1
fi
