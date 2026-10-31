#!/bin/bash
# Phase-2 sandbox: a replica of the live machine AFTER phase 1 —
#   dev.pal.* agents, ~/.pal (+ ~/.lantern compat symlink), PAL_* env files,
#   DB/user/role still on the old names at schema v35, MinIO still on the old
#   root credentials with lantern-* buckets, agent_versions.bundle_uri on
#   s3://lantern-*, gateway/runtime-scheduler pinning the OLD dev JWT secret,
#   runtime-manager pinning BUNDLE_S3_BUCKET=lantern-bundles, a checkout
#   .env.local with LANTERN_* / NEXT_PUBLIC_LANTERN_* keys
# — taken to the zero-lantern names with pal-phase2.contract, rolled back, and
# failure-injected. Real throwaway Postgres objects (*_test) and a real
# throwaway MinIO container (pal-cutover-sandbox-minio-test); everything else is
# recorded by the stubs. Nothing live is touched.
#
#   scripts/cutover/test-sandbox-phase2.sh       (KEEP=1 to keep the sandbox)
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_SRC="$(cd "$HERE/../.." && pwd)"
CUT="$HERE/pal-cutover.sh"
REAL_DOCKER="$(command -v docker)"
PG_CONTAINER="${PG_CONTAINER:-docker-postgres-1}"
PG_ADMIN="${PG_ADMIN:-lantern}"   # used ONLY by this harness to create/drop the *_test objects
MINIO_IMAGE="${MINIO_IMAGE:-minio/minio:latest}"
SB="$(mktemp -d /private/tmp/pal-cutover-p2.XXXXXX)"
PASS=0; FAILS=0
# E2E_REAL_MIGRATIONS=1: a throwaway Postgres CONTAINER (never the shared server: the brand
# migration renames cluster-global roles), the REAL names, and the REAL master / zero-lantern
# `migrate` binaries (MIGRATE_MASTER / MIGRATE_ZERO, built from those commits) run on API start.
E2E="${E2E_REAL_MIGRATIONS:-0}"
OU=lantern_test NU=pal_test OD=cutover_test ND=cutover_test_pal OA=lantern_app_test NA=pal_app_test
if [[ "$E2E" == 1 ]]; then
  : "${MIGRATE_MASTER:?}" "${MIGRATE_ZERO:?}" "${MIGRATIONS_OLD_SRC:?}" "${MIGRATIONS_NEW_SRC:?}"
  PG_CONTAINER=pal-cutover-e2e-pg-test; PG_ADMIN=lantern; E2E_PORT="${E2E_PORT:-55432}"
  OU=lantern NU=pal OD=lantern ND=pal OA=lantern_app NA=pal_app
fi
say()  { printf '\n######## %s\n' "$*"; }
pass() { printf '  PASS  %s\n' "$*"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }
check(){ local d="$1"; shift; if "$@"; then pass "$d"; else fail "$d"; fi; }
apg()  { "$REAL_DOCKER" exec -i "$PG_CONTAINER" psql -X -q -At -v ON_ERROR_STOP=1 -U "$PG_ADMIN" -d "${1:-postgres}"; }
q()    { "$REAL_DOCKER" exec -i "$PG_CONTAINER" psql -X -q -At -U "$1" -d "$2" -c "$3" 2>/dev/null; }

export STUB_MINIO_CONTAINER=pal-cutover-sandbox-minio-test STUB_MINIO_VOLUME=pal-cutover-sandbox-minio-test-data STUB_MINIO_IMAGE="$MINIO_IMAGE"
mc_() {  # mc_ USER PASS args… against the sandbox MinIO
  local u="$1" p="$2"; shift 2
  "$REAL_DOCKER" exec -e MC_HOST_s="http://$u:$p@localhost:9000" "$STUB_MINIO_CONTAINER" mc "$@"
}
objs() { mc_ "$1" "$2" ls -r --json "s/$3" 2>/dev/null | python3 -I "$HERE/cutover_helper.py" objects; }

cleanup() {
  if [[ "$E2E" == 1 ]]; then
    "$REAL_DOCKER" rm -f "$PG_CONTAINER" >/dev/null 2>&1
    "$REAL_DOCKER" rm -f "$STUB_MINIO_CONTAINER" >/dev/null 2>&1; "$REAL_DOCKER" volume rm "$STUB_MINIO_VOLUME" >/dev/null 2>&1
    return 0
  fi
  apg <<'SQL' >/dev/null 2>&1
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname LIKE 'cutover\_test%';
SQL
  for d in $(echo "select datname from pg_database where datname like 'cutover\_test%'" | apg); do echo "DROP DATABASE \"$d\";" | apg; done
  for r in pal_test_cutover_tmp pal_app_test pal_test lantern_app_test lantern_test; do echo "DROP ROLE IF EXISTS $r;" | apg; done
  "$REAL_DOCKER" rm -f "$STUB_MINIO_CONTAINER" >/dev/null 2>&1
  "$REAL_DOCKER" volume rm "$STUB_MINIO_VOLUME" >/dev/null 2>&1
}
finish() { cleanup; if [[ "${KEEP:-0}" == 1 ]]; then echo "sandbox kept at $SB"; else rm -rf "$SB"; fi; }
trap finish EXIT

# ------------------------------------------------------------------ environment
export HOME="$SB/home"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/PAL" "$SB/stub-state"
export PAL_CUTOVER_SANDBOX=1 PAL_CUTOVER_STUB_BIN="$HERE/sandbox" PAL_CUTOVER_CONTRACT="$HERE/pal-phase2.contract"
export STUB_STATE="$SB/stub-state" STUB_REAL_DOCKER="$REAL_DOCKER" STUB_DB_CONTAINER="$PG_CONTAINER"
export STUB_HELPER="$HERE/cutover_helper.py" STUB_OLD_PREFIX=dev.pal STUB_NEW_PREFIX=dev.pal
export STUB_OLD_ENV_PREFIX=PAL_ STUB_OLD_STATE="$SB/home/.pal"
export STUB_TENANT=00000000-0000-0000-0000-000000000001
export REPO_DIR="$HOME/workspace/lantern" REPO_REMOTE_URL="$SB/remote/pal.git"
export STUB_WA_CREDS="$REPO_DIR/services/whatsapp-bridge/auth_sessions"
export DB_CONTAINER="$PG_CONTAINER" DB_OLD_NAME="$OD" DB_NEW_NAME="$ND"
export DB_OLD_USER="$OU" DB_NEW_USER="$NU" DB_OLD_APP_ROLE="$OA" DB_NEW_APP_ROLE="$NA"
export MINIO_CONTAINER="$STUB_MINIO_CONTAINER" MINIO_RECREATE_CMD="$HERE/sandbox/minio-recreate.sh"
export STUB_ON_API_START="$HERE/sandbox/fake-migrate.sh"
if [[ "$E2E" == 1 ]]; then export STUB_ON_API_START="$HERE/sandbox/real-migrate.sh" MIGRATE_MASTER MIGRATE_ZERO E2E_PORT; fi
export HEALTH_TIMEOUT_SECS=10 DASHBOARD_TIMEOUT_SECS=10
launchctl_s() { PATH="$HERE/sandbox:$PATH" launchctl "$@"; }
export REAL_DOCKER PG_CONTAINER
export -f q mc_ objs
OLDJWT=lantern-dev-jwt-secret-do-not-use-in-production NEWJWT=pal-dev-jwt-secret-do-not-use-in-production

# ------------------------------------------------------------------ throwaway Postgres at schema v35, old names
if [[ "$E2E" == 1 ]]; then
say "setup: throwaway Postgres container + REAL master migrations (old names)"
cleanup
"$REAL_DOCKER" run -d --name "$PG_CONTAINER" -p "127.0.0.1:$E2E_PORT:5432" -e POSTGRES_USER=lantern -e POSTGRES_PASSWORD=lantern \
  -e POSTGRES_DB=lantern pgvector/pgvector:pg16 >/dev/null || exit 1
for _ in $(seq 1 60); do "$REAL_DOCKER" exec "$PG_CONTAINER" psql -U lantern -d lantern -Atc 'select 1' >/dev/null 2>&1 && break; sleep 1; done
sleep 3
DATABASE_URL="postgres://lantern:lantern@127.0.0.1:$E2E_PORT/lantern?sslmode=disable" SEED_DEV=1 "$MIGRATE_MASTER" > "$SB/migrate-master.log" 2>&1 || { echo "master migrations failed"; tail -5 "$SB/migrate-master.log"; exit 1; }
apg lantern <<'SQL' || exit 1
ALTER ROLE lantern_app PASSWORD 'apppw-test';
INSERT INTO agents (id, tenant_id, name) VALUES ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000001', 'e2e-agent');
INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
  SELECT '11111111-1111-1111-1111-111111111111', v, decode(md5(v), 'hex'), u, '{}'::jsonb
  FROM (VALUES ('1','s3://lantern-bundles/t1/a.tgz'), ('2','s3://lantern-bundles/t1/b.tgz'), ('3','s3://lantern-bundles-dev/x.tgz'), ('4','s3://test/y.tgz')) AS t(v,u);
INSERT INTO connector_installs (tenant_id, connector_id, display_name, config)
  VALUES ('00000000-0000-0000-0000-000000000001', 'e2e-conn', 'E2E', '{"token": {"__lantern_enc__": "ciphertext-fixture"}}'::jsonb);
SQL
echo "  real schema: v$(q lantern lantern 'select version from schema_migrations'), admin=$(q lantern lantern "select email from users where id='00000000-0000-0000-0000-000000000002'"), ns=$(q lantern lantern "select k8s_namespace from tenants where slug='dev'")"
else
say "setup: Postgres (old names, schema v35, bundle_uri on s3://lantern-*)"
cleanup
apg <<'SQL' || { echo "cannot create sandbox DB objects"; exit 1; }
CREATE ROLE lantern_test SUPERUSER LOGIN PASSWORD 'lantern';
CREATE ROLE lantern_app_test LOGIN PASSWORD 'apppw-test';
CREATE DATABASE cutover_test OWNER lantern_test;
SQL
"$REAL_DOCKER" exec -i "$PG_CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U lantern_test -d cutover_test <<'SQL' || exit 1
CREATE TABLE schema_migrations (version bigint NOT NULL PRIMARY KEY, dirty boolean NOT NULL);
INSERT INTO schema_migrations VALUES (35, false);
CREATE TABLE agent_versions (id bigserial PRIMARY KEY, tenant_id text, bundle_uri text);
INSERT INTO agent_versions (tenant_id, bundle_uri) VALUES
  ('t1','s3://lantern-bundles/t1/a.tgz'), ('t1','s3://lantern-bundles/t1/b.tgz'),
  ('t2','s3://lantern-bundles-dev/x.tgz'), ('t2','s3://test/y.tgz'), ('t3', NULL);
CREATE TABLE tenants (id text PRIMARY KEY, k8s_namespace text);
INSERT INTO tenants VALUES ('t1','lantern-t-t1');
ALTER TABLE agent_versions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON agent_versions, tenants TO lantern_app_test;
SQL

fi
# ------------------------------------------------------------------ throwaway MinIO on the old creds
say "setup: MinIO container on lantern/lanternsecret with lantern-* buckets"
"$REAL_DOCKER" volume create "$STUB_MINIO_VOLUME" >/dev/null
"$REAL_DOCKER" run -d --name "$STUB_MINIO_CONTAINER" -v "$STUB_MINIO_VOLUME:/data" \
  -e MINIO_ROOT_USER=lantern -e MINIO_ROOT_PASSWORD=lanternsecret "$MINIO_IMAGE" server /data >/dev/null || exit 1
for _ in $(seq 1 30); do mc_ lantern lanternsecret ls s/ >/dev/null 2>&1 && break; sleep 1; done
for b in lantern-dev lantern-bundles lantern-snapshots lantern-bundles-dev; do mc_ lantern lanternsecret mb "s/$b" >/dev/null; done
"$REAL_DOCKER" exec "$STUB_MINIO_CONTAINER" sh -c 'mkdir -p /tmp/o/t1 && head -c 3000 /dev/urandom > /tmp/o/t1/a.tgz && head -c 70000 /dev/urandom > /tmp/o/t1/b.tgz && echo snap > /tmp/o/s1.json'
mc_ lantern lanternsecret cp -q /tmp/o/t1/a.tgz s/lantern-bundles/t1/a.tgz >/dev/null
mc_ lantern lanternsecret cp -q /tmp/o/t1/b.tgz s/lantern-bundles/t1/b.tgz >/dev/null
mc_ lantern lanternsecret cp -q /tmp/o/s1.json s/lantern-snapshots/s1.json >/dev/null
mc_ lantern lanternsecret cp -q /tmp/o/s1.json "s/lantern-bundles-dev/x.tgz" >/dev/null
echo "  objects: bundles=$(objs lantern lanternsecret lantern-bundles | grep -c .) snapshots=$(objs lantern lanternsecret lantern-snapshots | grep -c .)"

# ------------------------------------------------------------------ ~/.pal (post phase 1)
say "setup: ~/.pal + ~/.lantern compat symlink, PAL_* env"
P="$HOME/.pal"; mkdir -p "$P/ocr-cache" "$P/introspect"
umask 022
cat > "$P/bridge.env" <<'EOF'
export PAL_BRIDGE_TOKEN="fake-wa-token-123"   # wa
export PAL_IMESSAGE_BRIDGE_TOKEN='fake im token'
PAL_CONFIDENCE_GATE=1
EOF
printf 'PAL_CREDENTIAL_KEY=%s\nPAL_JARVIS_BRIEF_HOUR=7\n' "$(printf 'k%.0s' {1..64})" > "$P/control-plane.env"
echo 'PAL_IMESSAGE_OWNER_HANDLE=owner@example.test' > "$P/imessage.env"
chmod 600 "$P"/*.env; head -c 2048 /dev/urandom > "$P/state.key"; chmod 600 "$P/state.key"
ln -s "$P" "$HOME/.lantern"
mkdir -p "$HOME/fake-x64-bin" "$HOME/.nvm/versions/node/v99.0.0/bin"
printf '#!/bin/sh\necho x\n' > "$HOME/fake-x64-bin/node"; printf '#!/bin/sh\necho n\n' > "$HOME/.nvm/versions/node/v99.0.0/bin/node"
chmod +x "$HOME/fake-x64-bin/node" "$HOME/.nvm/versions/node/v99.0.0/bin/node"

# ------------------------------------------------------------------ checkout: "aeaaa3f3" (old DB/MinIO names) and the zero-lantern release
say "setup: synthetic repo (current master + zero-lantern release)"
mkdir -p "$SB/remote" && git init -q --bare "$SB/remote/pal.git"
git init -q -b master "$REPO_DIR"; cd "$REPO_DIR" || exit 1
git config user.email sandbox@example.test; git config user.name sandbox
mkdir -p scripts/launchd infra/docker packages/bridge-core/src services/control-plane/cmd/server \
         services/control-plane/internal/db/migrations services/whatsapp-bridge/src services/imessage-bridge/src apps/web
for s in api dashboard gateway runtime-manager runtime-scheduler whatsapp-bridge imessage-bridge infra; do
  sed -e 's/dev\.lantern\./dev.pal./g' -e 's#Logs/Lantern#Logs/PAL#g' -e 's/LANTERN_/PAL_/g' \
    "$REPO_SRC/scripts/launchd/dev.lantern.$s.plist" > "scripts/launchd/dev.pal.$s.plist" 2>/dev/null \
    || cp "$REPO_SRC/scripts/launchd/dev.pal.$s.plist" "scripts/launchd/dev.pal.$s.plist"
done
cp "$REPO_SRC/scripts/launchd/run-bridge-wrapper.sh" scripts/launchd/
plutil -replace EnvironmentVariables.DATABASE_URL -string "postgres://$OU:lantern@localhost:5432/$OD?sslmode=disable" scripts/launchd/dev.pal.api.plist
plutil -replace EnvironmentVariables.PATH -string '__HOME__/fake-x64-bin:/usr/bin:/bin' scripts/launchd/dev.pal.dashboard.plist
cat > infra/docker/docker-compose.yml <<'EOF'
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: lantern
      POSTGRES_PASSWORD: lantern
    volumes:
      - pg-data:/var/lib/postgresql/data
  minio:
    image: minio/minio:latest
    environment:
      MINIO_ROOT_USER: lantern
      MINIO_ROOT_PASSWORD: lanternsecret
    volumes:
      - minio-data:/data
  minio-init:
    entrypoint: >
      sh -c "mc alias set local http://minio:9000 lantern lanternsecret && mc mb local/lantern-dev --ignore-existing"
volumes:
  pg-data:
  minio-data:
EOF
if [[ "$E2E" == 1 ]]; then for f in "$MIGRATIONS_OLD_SRC"/*.up.sql; do echo "-- name only" > "services/control-plane/internal/db/migrations/$(basename "$f")"; done
else for n in 0034_a 0035_billing; do echo "select 1;" > "services/control-plane/internal/db/migrations/$n.up.sql"; done; fi
echo 'export const dir = join(homedir(), ".pal");' > packages/bridge-core/src/state-dir.ts
echo 'const BRIDGE_TOKEN = process.env.PAL_BRIDGE_TOKEN || "";' > services/whatsapp-bridge/src/index.ts
echo '// imessage session' > services/imessage-bridge/src/session.ts
echo 'cfg.ConnConfig.User = envOr("PAL_APP_DB_USER", "pal_app")' > services/control-plane/cmd/server/main.go
printf 'bridge_state/\nauth_sessions/\nnode_modules/\n' > services/whatsapp-bridge/.gitignore
printf '.env.local\n' > .gitignore
echo '{}' > apps/web/package.json
git add -A && git commit -qm "aeaaa3f3-like: pal labels, old DB/MinIO names" && OLD_SHA="$(git rev-parse HEAD)"
# release (#401): new DB URL, MinIO creds/buckets, brand migration, new JWT default
plutil -replace EnvironmentVariables.DATABASE_URL -string "postgres://$NU:pal@localhost:5432/$ND?sslmode=disable" scripts/launchd/dev.pal.api.plist
plutil -replace EnvironmentVariables.BUNDLE_S3_BUCKET -string 'pal-bundles' scripts/launchd/dev.pal.runtime-manager.plist 2>/dev/null \
  || plutil -insert EnvironmentVariables.BUNDLE_S3_BUCKET -string 'pal-bundles' scripts/launchd/dev.pal.runtime-manager.plist
sed -i '' -e 's/MINIO_ROOT_USER: lantern/MINIO_ROOT_USER: pal/' -e 's/MINIO_ROOT_PASSWORD: lanternsecret/MINIO_ROOT_PASSWORD: palsecret/' \
  -e 's#lantern lanternsecret && mc mb local/lantern-dev#pal palsecret \&\& mc mb local/pal-dev#' \
  -e 's/POSTGRES_USER: lantern/POSTGRES_USER: pal/' infra/docker/docker-compose.yml
if [[ "$E2E" == 1 ]]; then for f in "$MIGRATIONS_NEW_SRC"/*.up.sql; do echo "-- name only" > "services/control-plane/internal/db/migrations/$(basename "$f")"; done
else echo "select 1;" > services/control-plane/internal/db/migrations/0036_pal_brand_rename.up.sql; fi
git add -A && git commit -qm "zero-lantern release" && REL="$(git rev-parse HEAD)"
git push -q "$SB/remote/pal.git" master
git reset -q --hard "$OLD_SHA"; git remote add origin "$SB/remote/pal.git"; git fetch -q origin
printf 'GOOGLE_CLIENT_ID=fake\nLANTERN_OWNER_EMAIL=owner@example.test\nNEXT_PUBLIC_LANTERN_BRIDGE_URL=http://localhost:3100\n' > .env.local
mkdir -p "services/whatsapp-bridge/auth_sessions/$STUB_TENANT" services/whatsapp-bridge/bridge_state services/imessage-bridge/bridge_state
head -c 2048 /dev/urandom > "services/whatsapp-bridge/auth_sessions/$STUB_TENANT/creds.json"

# ------------------------------------------------------------------ LaunchAgents (dev.pal.*, old DB URL, old JWT, old bucket)
say "setup: dev.pal.* LaunchAgents as phase 1 left them"
LA="$HOME/Library/LaunchAgents"
for s in api dashboard gateway runtime-manager runtime-scheduler whatsapp-bridge imessage-bridge infra; do
  sed -e "s|__NODE__|/usr/local/bin/node|g" -e "s|__REPO_ROOT__|$REPO_DIR|g" -e "s|__HOME__|$HOME|g" -e "s|__UID__|$(id -u)|g" \
    "scripts/launchd/dev.pal.$s.plist" > "$LA/dev.pal.$s.plist"
done
for s in gateway runtime-scheduler; do
  plutil -replace EnvironmentVariables.JWT_SECRET -string "$OLDJWT" "$LA/dev.pal.$s.plist" 2>/dev/null || plutil -insert EnvironmentVariables.JWT_SECRET -string "$OLDJWT" "$LA/dev.pal.$s.plist"
done
plutil -replace EnvironmentVariables.BUNDLE_S3_BUCKET -string lantern-bundles "$LA/dev.pal.runtime-manager.plist" 2>/dev/null || plutil -insert EnvironmentVariables.BUNDLE_S3_BUCKET -string lantern-bundles "$LA/dev.pal.runtime-manager.plist"
plutil -insert EnvironmentVariables.PAL_SIGNAL_TOKEN -string fake-signal-token "$LA/dev.pal.api.plist"
plutil -replace EnvironmentVariables.NEXT_PUBLIC_API_URL -string http://100.64.0.1:8080 "$LA/dev.pal.dashboard.plist"
chmod 600 "$LA"/*.plist
for f in "$LA"/dev.pal.*.plist; do launchctl_s bootstrap "gui/$(id -u)" "$f"; done
cd "$SB" || exit 1
# residue gate: a live-only key still pointing at the OLD database must stop the plan
plutil -insert EnvironmentVariables.LEGACY_DB_URL -string "postgres://$OU:lantern@localhost:5432/$OD" "$LA/dev.pal.api.plist"
RELEASE_REF="$REL" "$CUT" plan > "$SB/plan-residue.out" 2>&1; rc=$?
plutil -remove EnvironmentVariables.LEGACY_DB_URL "$LA/dev.pal.api.plist"
check "residue gate: plan fails on a live-only value that still names the old DB (key reported, value not)" bash -c "[ $rc != 0 ] && grep -q 'dev.pal.api.plist:LEGACY_DB_URL' '$SB/plan-residue.out' && ! grep -q ':lantern@localhost' '$SB/plan-residue.out'"
# a stray target role (another run's leftover, as found on the live server) must stop the plan
q "$OU" postgres "CREATE ROLE $NA LOGIN" >/dev/null
RELEASE_REF="$REL" "$CUT" plan > "$SB/plan-stray.out" 2>&1; rc=$?
q "$OU" postgres "DROP ROLE $NA" >/dev/null
check "stray target role: plan fails and names it with a remedy" bash -c "[ $rc != 0 ] && grep -q 'role $NA already exists (objects in: none)' '$SB/plan-stray.out'"
snap() { "$CUT" snapshot "$1" old >/dev/null 2>&1; }
same() { diff -u "$1" "$2" > "$SB/last.diff"; }
snap "$SB/S0"
pal_buckets() { mc_ "$1" "$2" ls --json s/ 2>/dev/null | python3 -I -c 'import json,sys
print(" ".join(sorted(json.loads(l)["key"].rstrip("/") for l in sys.stdin if l.strip())))'; }

ROLES_NEW="$(printf '%s\n' "$NA" "$NU" | sort | tr '\n' ' ' | sed 's/ $//')"
ROLES_OLD="$(printf '%s\n' "$OA" "$OU" | sort | tr '\n' ' ' | sed 's/ $//')"
# ------------------------------------------------------------------ plan
say "1. plan"
RELEASE_REF="$REL" "$CUT" plan > "$SB/plan.out" 2>&1; rc=$?
grep -E 'FAIL|WARN|would (mirror|UPDATE|rewrite)|value-mapped\[[^]]|summary' "$SB/plan.out" | cut -c12-220 | sed 's/^/    /' | head -30
check "plan exits 0" test "$rc" = 0
snap "$SB/S0p"; check "plan changed nothing" same "$SB/S0" "$SB/S0p"
check "plan prints no secret value" bash -c "! grep -qE 'fake-wa-token|fake im token|fake-signal-token|lanternsecret|palsecret|kkkkkkkk|apppw' '$SB/plan.out'"

# ------------------------------------------------------------------ apply
say "2. apply"
sleep 1
RELEASE_REF="$REL" "$CUT" apply > "$SB/apply.out" 2>&1; rc=$?
grep -E '===|FAIL|WARN|COMPLETE|verified|bundle_uri|MinIO|role|schema' "$SB/apply.out" | cut -c12-200 | sed 's/^/    /' | head -60
check "apply exits 0" test "$rc" = 0
check "DB renamed, superuser + app role renamed, old app role gone" bash -c "[ \"\$(q $NU postgres \"select string_agg(rolname,' ' order by rolname) from pg_roles where rolname in ('$OU','$OA','$NU','$NA')\")\" = \"$ROLES_NEW\" ] && [ \"\$(q $NU postgres \"select count(*) from pg_database where datname='$ND'\")\" = 1 ]"
check "superuser password reset to the contract value (TCP login $NU/pal)" bash -c "printf 'pal\n' | $REAL_DOCKER exec -i $PG_CONTAINER sh -c 'IFS= read -r PGPASSWORD; export PGPASSWORD; psql -XAt -h 127.0.0.1 -U $NU -d $ND -c \"select 1\"' | grep -qx 1"
check "app role kept its SCRAM password through the rename" bash -c "printf 'apppw-test\n' | $REAL_DOCKER exec -i $PG_CONTAINER sh -c 'IFS= read -r PGPASSWORD; export PGPASSWORD; psql -XAt -h 127.0.0.1 -U $NA -d $ND -c \"select 1\"' | grep -qx 1"
check "migration ran on API start (schema v36) and found nothing to rename (no fight)" bash -c "[ \"\$(q $NU $ND 'select version from schema_migrations')\" = 36 ] && ! grep -q 'migration renamed the app role' '$STUB_STATE/api-start.log'"
check "bundle_uri: s3://lantern-* rewritten (3 rows), others untouched" bash -c "[ \"\$(q $NU $ND \"select count(*) from agent_versions where bundle_uri like 's3://lantern-%'\")\" = 0 ] && [ \"\$(q $NU $ND \"select count(*) from agent_versions where bundle_uri like 's3://pal-bundles%'\")\" = 3 ] && [ \"\$(q $NU $ND \"select count(*) from agent_versions where bundle_uri = 's3://test/y.tgz'\")\" = 1 ]"
check "MinIO now on pal/palsecret; old root creds rejected" bash -c "mc_() { $REAL_DOCKER exec -e MC_HOST_s=\"http://\$1:\$2@localhost:9000\" $STUB_MINIO_CONTAINER mc ls s/ >/dev/null 2>&1; }; mc_ pal palsecret && ! mc_ lantern lanternsecret"
check "pal-* mirrors exist, old buckets kept" test "$(pal_buckets pal palsecret)" = "lantern-bundles lantern-bundles-dev lantern-dev lantern-snapshots pal-bundles pal-bundles-dev pal-dev pal-snapshots"
A1="$(objs pal palsecret lantern-bundles)"; A2="$(objs pal palsecret pal-bundles)"
check "mirrored objects identical (key/size/etag), non-empty" bash -c "[ -n \"\$1\" ] && [ \"\$1\" = \"\$2\" ]" _ "$A1" "$A2"
check "gateway + runtime-scheduler JWT_SECRET mapped to the NEW dev constant" bash -c "for s in gateway runtime-scheduler; do [ \"\$(python3 -I '$STUB_HELPER' plist-get '$LA/dev.pal.'\$s'.plist' env:JWT_SECRET)\" = '$NEWJWT' ] || exit 1; done"
check "runtime-manager BUNDLE_S3_BUCKET → pal-bundles" test "$(python3 -I "$STUB_HELPER" plist-get "$LA/dev.pal.runtime-manager.plist" env:BUNDLE_S3_BUCKET)" = pal-bundles
check "api DATABASE_URL = release template ($NU@$ND)" bash -c "python3 -I '$STUB_HELPER' plist-get '$LA/dev.pal.api.plist' env:DATABASE_URL | grep -q '$NU:pal@localhost:5432/$ND'"
check "live-only PAL_SIGNAL_TOKEN carried" test "$(python3 -I "$STUB_HELPER" plist-get "$LA/dev.pal.api.plist" env:PAL_SIGNAL_TOKEN)" = fake-signal-token
check "dashboard live NEXT_PUBLIC_API_URL kept" test "$(python3 -I "$STUB_HELPER" plist-get "$LA/dev.pal.dashboard.plist" env:NEXT_PUBLIC_API_URL)" = http://100.64.0.1:8080
check "checkout .env.local: LANTERN_* and NEXT_PUBLIC_LANTERN_* keys renamed, other keys kept" bash -c "grep -q '^PAL_OWNER_EMAIL=' '$REPO_DIR/.env.local' && grep -q '^NEXT_PUBLIC_PAL_BRIDGE_URL=' '$REPO_DIR/.env.local' && grep -q '^GOOGLE_CLIENT_ID=' '$REPO_DIR/.env.local' && ! grep -q LANTERN '$REPO_DIR/.env.local'"
check "dashboard built with its plist env (NEXT_PUBLIC_API_URL present at build)" grep -q 'build-env NEXT_PUBLIC: .*NEXT_PUBLIC_API_URL' "$STUB_STATE/calls.log"
check "dashboard built under the plist-PATH node" grep -q 'npm run build (cwd=workspace/lantern/apps/web) node=fake-x64-bin/node' "$STUB_STATE/calls.log"
check "WhatsApp auth_sessions untouched (no re-pair)" bash -c "diff <(grep -A3 'auth_sessions' '$SB/S0') <('$CUT' snapshot /dev/stdout old 2>/dev/null | grep -A3 'auth_sessions') >/dev/null"
check "state dir untouched in place (no move, no nesting)" bash -c "[ -f '$HOME/.pal/state.key' ] && [ ! -e '$HOME/.pal/.pal' ] && [ -L '$HOME/.lantern' ]"
check "apply prints no secret value" bash -c "! grep -qE 'fake-wa-token|fake im token|fake-signal-token|lanternsecret|palsecret|kkkkkkkk|apppw' '$SB/apply.out'"

lastmig() { find "$1" -name '*.up.sql' -exec basename {} \; | sed -nE 's/^0*([0-9]+)_.*/\1/p' | sort -n | tail -1; }
if [[ "$E2E" == 1 ]]; then
  check "[e2e] REAL brand migration ran: dev namespace pal-t-dev" test "$(q "$NU" "$ND" "select k8s_namespace from tenants where slug='dev'")" = pal-t-dev
  SEED_EMAIL="$(sed -nE "s/^[[:space:]]*'(admin@pal[.][a-z]+)',?$/\1/p" "$MIGRATIONS_NEW_SRC/../migrate.go" | head -1)"
  check "[e2e] REAL dev seed moved the admin to the branch's seed email ($SEED_EMAIL)" test "$(q "$NU" "$ND" "select email from users where id='00000000-0000-0000-0000-000000000002'")" = "$SEED_EMAIL"
  check "[e2e] REAL brand migration rewrote the at-rest envelope marker (__lantern_enc__ -> __pal_enc__)" test "$(q "$NU" "$ND" "select config->'token' ? '__pal_enc__' and not (config->'token' ? '__lantern_enc__') from connector_installs where connector_id='e2e-conn'")" = t
  check "[e2e] schema at the zero-lantern newest migration" test "$(q "$NU" "$ND" 'select version from schema_migrations')" = "$(lastmig "$MIGRATIONS_NEW_SRC")"
fi
say "3. verify"
"$CUT" verify > "$SB/verify.out" 2>&1; rc=$?
grep -E 'FAIL|WARN|schema|role|MinIO' "$SB/verify.out" | cut -c12-200 | sed 's/^/    /'
check "verify exits 0" test "$rc" = 0

# ------------------------------------------------------------------ rollback
say "4. rollback (back to the old commit, schema v35 from the dump, MinIO on old creds)"
"$CUT" rollback > "$SB/rollback.out" 2>&1; rc=$?
grep -E '===|FAIL|WARN|IDENTICAL|MinIO|restored|schema' "$SB/rollback.out" | cut -c12-200 | sed 's/^/    /' | head -30
check "rollback exits 0" test "$rc" = 0
check "rollback IDENTICAL" grep -q 'snapshot IDENTICAL' "$SB/rollback.out"
"$CUT" verify --old > "$SB/verify-old.out" 2>&1; rc=$?
check "verify --old exits 0 (schema 35 startable on the old commit; MinIO old creds)" bash -c "[ $rc = 0 ] && grep -q 'MinIO on the old root credentials' '$SB/verify-old.out'"
snap "$SB/S1"; check "byte-identical to the start" same "$SB/S0" "$SB/S1"
[[ -s "$SB/last.diff" ]] && sed 's/^/      /' "$SB/last.diff" | head -20
check "checkout back at the old commit" test "$(git -C "$REPO_DIR" rev-parse HEAD)" = "$OLD_SHA"
if [[ "$E2E" == 1 ]]; then
  check "[e2e] after rollback: lantern-t-dev namespace back (dump restored)" test "$(q "$OU" "$OD" "select k8s_namespace from tenants where slug='dev'")" = lantern-t-dev
  check "[e2e] after rollback: envelope marker back to __lantern_enc__ (old code can decrypt)" test "$(q "$OU" "$OD" "select config->'token' ? '__lantern_enc__' from connector_installs where connector_id='e2e-conn'")" = t
  check "[e2e] after rollback: schema back at master's newest migration" test "$(q "$OU" "$OD" 'select version from schema_migrations')" = "$(lastmig "$MIGRATIONS_OLD_SRC")"
  check "[e2e] REAL master migrate boots against the rolled-back DB" env DATABASE_URL="postgres://lantern:lantern@127.0.0.1:$E2E_PORT/lantern?sslmode=disable" "$MIGRATE_MASTER"
fi

# ------------------------------------------------------------------ live state: stray target role on the cluster
say "4b. a stray $NA role already exists and owns a table in another test DB (the live finding)"
SDB=cutover_test_stray; [[ "$E2E" == 1 ]] && SDB=p4_stray_test
q "$OU" postgres "CREATE ROLE $NA LOGIN PASSWORD 'stray-test'" >/dev/null
q "$OU" postgres "CREATE DATABASE $SDB" >/dev/null
q "$OU" "$SDB" "CREATE TABLE leftover(id int); ALTER TABLE leftover OWNER TO $NA; INSERT INTO leftover VALUES (1)" >/dev/null
sleep 1
RELEASE_REF="$REL" "$CUT" plan > "$SB/plan-stray2.out" 2>&1; rc=$?
check "[stray] plan refuses without the flag and names the holding DB" bash -c "[ $rc != 0 ] && grep -q 'role $NA already exists (objects in: $SDB)' '$SB/plan-stray2.out'"
PAL_CUTOVER_DROP_STRAY_ROLE=1 RELEASE_REF="$REL" "$CUT" plan > "$SB/plan-stray3.out" 2>&1; rc=$?
check "[stray] with PAL_CUTOVER_DROP_STRAY_ROLE=1 the plan passes and lists the REASSIGN/DROP" bash -c "[ $rc = 0 ] && grep -q 'in $SDB: REASSIGN OWNED BY $NA TO $OU; DROP OWNED BY $NA' '$SB/plan-stray3.out'"
OLD_APP_OID="$(q "$OU" postgres "select oid from pg_roles where rolname='$OA'")"
sleep 1
PAL_CUTOVER_DROP_STRAY_ROLE=1 RELEASE_REF="$REL" "$CUT" apply > "$SB/apply-stray.out" 2>&1; rc=$?
check "[stray] apply succeeds" test "$rc" = 0
check "[stray] $NA is now the RENAMED live app role (same oid as $OA had), migration did not skip" test "$(q "$NU" postgres "select oid from pg_roles where rolname='$NA'")" = "$OLD_APP_OID"
check "[stray] the leftover table survived, now owned by the superuser" test "$(q "$NU" "$SDB" "select tableowner from pg_tables where tablename='leftover'")" = "$NU"
"$CUT" rollback > "$SB/rollback-stray.out" 2>&1; rc=$?
check "[stray] rollback IDENTICAL" bash -c "[ $rc = 0 ] && grep -q 'snapshot IDENTICAL' '$SB/rollback-stray.out'"
check "[stray] after rollback: $OA back, stray role not recreated" test "$(q "$OU" postgres "select string_agg(rolname,' ' order by rolname) from pg_roles where rolname in ('$OA','$NA')")" = "$OA"
q "$OU" postgres "DROP DATABASE $SDB" >/dev/null

# ------------------------------------------------------------------ failure injection
inject() {
  local name="$1"; shift
  say "5. failure injection: $name"
  sleep 1
  env RELEASE_REF="$REL" "$@" "$CUT" apply > "$SB/fail-$name.out" 2>&1; rc=$?
  grep -E "FAILED|injected|IDENTICAL|MinIO" "$SB/fail-$name.out" | cut -c12-200 | sed 's/^/    /' | head -8
  check "[$name] apply exits non-zero" test "$rc" != 0
  check "[$name] auto-rollback IDENTICAL" grep -q 'snapshot IDENTICAL' "$SB/fail-$name.out"
  snap "$SB/S-$name"; check "[$name] byte-identical to the start" same "$SB/S0" "$SB/S-$name"
  check "[$name] MinIO back on the old root creds" bash -c "$REAL_DOCKER exec -e MC_HOST_s=http://lantern:lanternsecret@localhost:9000 $STUB_MINIO_CONTAINER mc ls s/ >/dev/null 2>&1"
  check "[$name] old role names back" test "$(q "$OU" postgres "select string_agg(rolname,' ' order by rolname) from pg_roles where rolname in ('$OU','$OA','$NU','$NA')")" = "$ROLES_OLD"
}
inject after-minio PAL_CUTOVER_FAIL_AT=minio
inject after-infra PAL_CUTOVER_FAIL_AT=infra

say "RESULT: $PASS passed, $FAILS failed"
[[ "$FAILS" == 0 ]]
