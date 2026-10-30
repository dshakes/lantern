#!/bin/bash
# End-to-end test of pal-cutover.sh against a synthetic machine. Nothing real is
# touched:
#   - HOME is a throwaway dir under /private/tmp with a fake ~/.lantern tree,
#     fake LaunchAgents and fake secrets
#   - launchctl / docker / cargo / go / npm / curl resolve to recorders in
#     scripts/cutover/sandbox (docker forwards ONLY `exec`/`inspect` against the
#     Postgres container, where this test creates throwaway *_test roles and a
#     cutover_test database and drops them again at the end)
#   - the checkout is a synthetic git repo with an "old" and a "release" commit
#
# Sequence: plan → backup → apply → verify → rollback → verify --old, then
# three failure injections (early, mid-DB, during the build after checkout),
# each of which must auto-roll back to a snapshot byte-identical to the start.
#
#   scripts/cutover/test-sandbox.sh            # needs docker + the dev postgres container
#   KEEP=1 scripts/cutover/test-sandbox.sh     # keep the sandbox dir for inspection
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_SRC="$(cd "$HERE/../.." && pwd)"
CUT="$HERE/pal-cutover.sh"
REAL_DOCKER="$(command -v docker)"
PG_CONTAINER="${PG_CONTAINER:-docker-postgres-1}"
PG_ADMIN="${PG_ADMIN:-lantern}"   # used ONLY by this harness to create/drop the *_test objects
SB="$(mktemp -d /private/tmp/pal-cutover-sandbox.XXXXXX)"
PASS=0; FAILS=0

say()  { printf '\n######## %s\n' "$*"; }
pass() { printf '  PASS  %s\n' "$*"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }
check(){ local d="$1"; shift; if "$@"; then pass "$d"; else fail "$d"; fi; }
apg()  { "$REAL_DOCKER" exec -i "$PG_CONTAINER" psql -X -q -At -v ON_ERROR_STOP=1 -U "$PG_ADMIN" -d "${1:-postgres}"; }

cleanup_db() {
  apg <<'SQL' >/dev/null 2>&1
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname LIKE 'cutover\_test%';
SQL
  for d in $(echo "select datname from pg_database where datname like 'cutover\_test%'" | apg); do echo "DROP DATABASE \"$d\";" | apg; done
  for r in pal_test_cutover_tmp pal_app_test pal_test lantern_app_test lantern_test; do echo "DROP ROLE IF EXISTS $r;" | apg; done
}
finish() {
  cleanup_db
  if [[ "${KEEP:-0}" == 1 ]]; then echo "sandbox kept at $SB"; else rm -rf "$SB"; fi
}
trap finish EXIT

# ------------------------------------------------------------------ environment
export HOME="$SB/home"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/Lantern" "$SB/stub-state"
export PAL_CUTOVER_SANDBOX=1 PAL_CUTOVER_STUB_BIN="$HERE/sandbox" PAL_CUTOVER_STASH=1
export STUB_STATE="$SB/stub-state" STUB_REAL_DOCKER="$REAL_DOCKER" STUB_DB_CONTAINER="$PG_CONTAINER"
export STUB_HELPER="$HERE/cutover_helper.py" STUB_OLD_PREFIX=dev.lantern STUB_NEW_PREFIX=dev.pal
export STUB_TENANT=00000000-0000-0000-0000-000000000001
export REPO_DIR="$HOME/workspace/lantern" REPO_REMOTE_URL="$SB/remote/pal.git"
export STUB_WA_CREDS="$REPO_DIR/services/whatsapp-bridge/auth_sessions"
export DB_CONTAINER="$PG_CONTAINER" DB_OLD_NAME=cutover_test DB_NEW_NAME=cutover_test_pal
export DB_OLD_USER=lantern_test DB_NEW_USER=pal_test DB_OLD_APP_ROLE=lantern_app_test DB_NEW_APP_ROLE=pal_app_test
export HEALTH_TIMEOUT_SECS=10
export NEW_BUCKET_PREFIX=lantern-   # phase-1 scenario: no bucket rename (phase 2 has its own suite)
STUBPATH="$HERE/sandbox"
launchctl_s() { PATH="$STUBPATH:$PATH" launchctl "$@"; }

# ------------------------------------------------------------------ throwaway database
say "setup: throwaway Postgres objects"
cleanup_db
apg <<'SQL' || { echo "cannot create sandbox DB objects"; exit 1; }
CREATE ROLE lantern_test SUPERUSER LOGIN PASSWORD 'oldpw-test';
CREATE ROLE lantern_app_test LOGIN PASSWORD 'apppw-old-test';
CREATE DATABASE cutover_test OWNER lantern_test;
SQL
"$REAL_DOCKER" exec -i "$PG_CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U lantern_test -d cutover_test <<'SQL' || exit 1
CREATE TABLE agents (id bigserial PRIMARY KEY, tenant_id text NOT NULL, name text, labels jsonb);
CREATE TABLE runs (id bigserial PRIMARY KEY, tenant_id text NOT NULL, agent_id bigint REFERENCES agents(id), output text);
INSERT INTO agents (tenant_id, name, labels) SELECT 't' || (g % 3), 'agent-' || g, jsonb_build_object('n', g, 'u', 'naïve ☕')
  FROM generate_series(1, 500) g;
INSERT INTO runs (tenant_id, agent_id, output) SELECT 't' || (g % 3), (g % 500) + 1, repeat('x', g % 97) FROM generate_series(1, 2000) g;
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agents USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
GRANT SELECT, INSERT, UPDATE ON agents, runs TO lantern_app_test;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO lantern_app_test;
CREATE TABLE schema_migrations (version bigint NOT NULL PRIMARY KEY, dirty boolean NOT NULL);
INSERT INTO schema_migrations VALUES (2, false);
SQL
echo "  created roles lantern_test (superuser), lantern_app_test and database cutover_test"

# ------------------------------------------------------------------ fake state dir
say "setup: fake ~/.lantern"
L="$HOME/.lantern"; mkdir -p "$L/introspect" "$L/logs" "$L/ocr-cache" "$L/shortcuts-web" "$L/whatsapp"
umask 022
cat > "$L/bridge.env" <<'EOF'
# bridge overrides (fake values)
LANTERN_PERSONAL_DOCS_ROOTS=~/Documents:~/.lantern/docs
export LANTERN_BRIDGE_TOKEN="fake-wa-token-123"   # live format: export + quotes + inline comment
LANTERN_IMESSAGE_BRIDGE_TOKEN="fake im token with spaces"
LANTERN_CONFIDENCE_GATE=1
LANTERN_WEIRD=a=b=c
OTHER_TOOL_FLAG=keep-me

LANTERN_WA_OWNER_JID=15555550100
EOF
printf 'LANTERN_CREDENTIAL_KEY=%s\nLANTERN_APP_DB_PASSWORD=apppw-new-test\nLANTERN_JARVIS_BRIEF_HOUR=7\n' "$(printf 'k%.0s' {1..64})" > "$L/control-plane.env"
echo 'LANTERN_IMESSAGE_OWNER_HANDLE=owner@example.test' > "$L/imessage.env"
chmod 600 "$L/bridge.env" "$L/control-plane.env"; chmod 644 "$L/imessage.env"
head -c 4096 /dev/urandom > "$L/episodes.jsonl"; chmod 600 "$L/episodes.jsonl"
for i in 1 2 3; do head -c 300 /dev/urandom > "$L/ocr-cache/$i.txt"; chmod 600 "$L/ocr-cache/$i.txt"; done
echo '{"pausedUntil":0}' > "$L/agent state with spaces.json"
echo "log" > "$L/logs/introspect.log"; : > "$L/whatsapp-overnight-queue.jsonl"; chmod 600 "$L/whatsapp-overnight-queue.jsonl"
chmod 700 "$L/ocr-cache"

mkdir -p "$HOME/fake-x64-bin" "$HOME/.nvm/versions/node/v99.0.0/bin"
printf '#!/bin/sh\necho fake-x64-node\n' > "$HOME/fake-x64-bin/node"
printf '#!/bin/sh\necho fake-nvm-node\n' > "$HOME/.nvm/versions/node/v99.0.0/bin/node"
chmod +x "$HOME/fake-x64-bin/node" "$HOME/.nvm/versions/node/v99.0.0/bin/node"

# ------------------------------------------------------------------ fake checkout
say "setup: synthetic repo (old commit + release commit)"
mkdir -p "$SB/remote" && git init -q --bare "$SB/remote/pal.git" && ln -s pal.git "$SB/remote/lantern.git"
git init -q -b master "$REPO_DIR"; cd "$REPO_DIR" || exit 1
git config user.email sandbox@example.test; git config user.name sandbox
mkdir -p scripts/launchd infra/docker packages/bridge-core/src services/control-plane/cmd/server services/whatsapp-bridge/src services/imessage-bridge/src apps/web
for s in api dashboard whatsapp-bridge imessage-bridge infra; do cp "$REPO_SRC/scripts/launchd/dev.lantern.$s.plist" scripts/launchd/; done
cp "$REPO_SRC/infra/docker/docker-compose.yml" infra/docker/
plutil -replace EnvironmentVariables.DATABASE_URL -string 'postgres://lantern_test:oldpw-test@localhost:5432/cutover_test?sslmode=disable' scripts/launchd/dev.lantern.api.plist
# live: the dashboard resolves an x64 node (Rosetta) from its plist PATH; the bridges use the newest nvm node
plutil -replace EnvironmentVariables.PATH -string '__HOME__/fake-x64-bin:/usr/bin:/bin' scripts/launchd/dev.lantern.dashboard.plist
echo 'export const dir = join(homedir(), ".lantern");' > packages/bridge-core/src/state-dir.ts
echo 'cfg.ConnConfig.User = "lantern_app_test"' > services/control-plane/cmd/server/main.go
echo 'const BRIDGE_TOKEN = process.env.LANTERN_BRIDGE_TOKEN || "";' > services/whatsapp-bridge/src/index.ts
printf 'bridge_state/\nauth_sessions/\nnode_modules/\n' > services/whatsapp-bridge/.gitignore
printf 'bridge_state/\nnode_modules/\n' > services/imessage-bridge/.gitignore
echo '{}' > apps/web/package.json
cp "$REPO_SRC/scripts/launchd/run-bridge-wrapper.sh" scripts/launchd/
mkdir -p services/control-plane/internal/db/migrations
echo 'select 1;' > services/control-plane/internal/db/migrations/0001_baseline.up.sql
echo 'select 2;' > services/control-plane/internal/db/migrations/0002_second.up.sql
echo '// imessage session' > services/imessage-bridge/src/session.ts
git add -A && git commit -qm "old: lantern names" && OLD_SHA="$(git rev-parse HEAD)"
# release commit: what the zero-lantern code ships
for s in api dashboard whatsapp-bridge imessage-bridge infra; do
  sed -e 's/dev\.lantern\./dev.pal./g' -e 's#Logs/Lantern#Logs/PAL#g' -e 's/LANTERN_/PAL_/g' \
    "scripts/launchd/dev.lantern.$s.plist" > "scripts/launchd/dev.pal.$s.plist"
  git rm -q "scripts/launchd/dev.lantern.$s.plist"
done
plutil -replace EnvironmentVariables.DATABASE_URL -string 'postgres://pal_test:newpw-test@localhost:5432/cutover_test_pal?sslmode=disable' scripts/launchd/dev.pal.api.plist
echo 'export const dir = join(homedir(), ".pal");' > packages/bridge-core/src/state-dir.ts
echo 'cfg.ConnConfig.User = os.Getenv("PAL_APP_DB_ROLE")' > services/control-plane/cmd/server/main.go
echo 'const BRIDGE_TOKEN = process.env.PAL_BRIDGE_TOKEN || "";' > services/whatsapp-bridge/src/index.ts
echo 'select 3;' > services/control-plane/internal/db/migrations/0003_third.up.sql
git add -A && git commit -qm "release: pal names" && REL="$(git rev-parse HEAD)"
git push -q "$SB/remote/pal.git" master
git reset -q --hard "$OLD_SHA"                          # the live checkout is stale
git remote add origin "$SB/remote/lantern.git"          # …and still points at the pre-rename URL
git fetch -q origin
echo '// owner hotfix, not committed' >> services/imessage-bridge/src/session.ts   # tracked + dirty (like the live session.ts)
echo scratch > notes.txt                                                          # untracked
mkdir -p services/whatsapp-bridge/bridge_state/t1 services/imessage-bridge/bridge_state "services/whatsapp-bridge/auth_sessions/$STUB_TENANT"
head -c 2048 /dev/urandom > "services/whatsapp-bridge/auth_sessions/$STUB_TENANT/creds.json"
head -c 512 /dev/urandom > "services/whatsapp-bridge/auth_sessions/$STUB_TENANT/pre-key-1.json"
echo '{"skills":[]}' > services/whatsapp-bridge/bridge_state/t1/skills.json
echo '{"seen":[]}' > services/imessage-bridge/bridge_state/event-scout.json
echo "  old=${OLD_SHA:0:9} release=${REL:0:9}; checkout stale + dirty; origin=lantern.git (symlink to pal.git, like GitHub's rename redirect)"

# ------------------------------------------------------------------ fake LaunchAgents
say "setup: fake LaunchAgents (old labels, live-only secrets, stray files)"
LA="$HOME/Library/LaunchAgents"
for s in api dashboard whatsapp-bridge imessage-bridge infra; do
  sed -e "s|__NODE__|/usr/local/bin/node|g" -e "s|__REPO_ROOT__|$REPO_DIR|g" -e "s|__HOME__|$HOME|g" -e "s|__UID__|$(id -u)|g" \
    "scripts/launchd/dev.lantern.$s.plist" > "$LA/dev.lantern.$s.plist"
done
P="$LA/dev.lantern.api.plist"
plutil -insert EnvironmentVariables.GOOGLE_CLIENT_SECRET -string fake-google-secret "$P"
plutil -insert EnvironmentVariables.LANTERN_SIGNAL_TOKEN -string fake-signal-token "$P"
plutil -insert EnvironmentVariables.LANTERN_PUBLIC_BASE_URL -string https://fake.trycloudflare.com "$P"
plutil -replace EnvironmentVariables.LOG_LEVEL -string debug "$P"   # a deliberate local override
chmod 600 "$P"
cat > "$LA/dev.lantern.tunnel.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>dev.lantern.tunnel</string>
<key>ProgramArguments</key><array><string>/opt/homebrew/bin/cloudflared</string><string>tunnel</string><string>--url</string><string>http://localhost:8080</string></array>
<key>StandardErrorPath</key><string>$HOME/Library/Logs/Lantern/tunnel.err.log</string>
<key>RunAtLoad</key><true/></dict></plist>
EOF
cat > "$LA/dev.lantern.signal-watchdog.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>dev.lantern.signal-watchdog</string>
<key>ProgramArguments</key><array><string>/bin/bash</string><string>$REPO_DIR/scripts/signal-watchdog.sh</string><string>dev.lantern.api</string><string>$HOME/.lantern/watchdog.state</string></array>
<key>EnvironmentVariables</key><dict><key>LANTERN_SIGNAL_TOKEN</key><string>fake-signal-token</string></dict>
<key>StartInterval</key><integer>300</integer></dict></plist>
EOF
sed 's/signal-watchdog/post-reboot-check/g' "$LA/dev.lantern.signal-watchdog.plist" > "$LA/dev.lantern.post-reboot-check.plist"
cp "$LA/dev.lantern.dashboard.plist" "$LA/dev.lantern.dashboard.plist.bak.1782444082"
chmod 644 "$LA/dev.lantern.tunnel.plist"
for f in "$LA"/dev.lantern.*.plist; do
  [[ "$f" == *post-reboot-check* ]] && continue   # installed but not loaded, like the live machine
  launchctl_s bootstrap "gui/$(id -u)" "$f"
done
echo "  loaded: $(launchctl_s list | awk 'NR>1{print $3}' | tr '\n' ' ')"

snap() { "$CUT" snapshot "$1" old >/dev/null 2>&1; }
same_snap() { diff -u "$1" "$2" > "$SB/last.diff"; }
cd "$SB" || exit 1
snap "$SB/S0"
check "baseline snapshot covers state + plists + DB" grep -q "^db cutover_test owner=lantern_test sha=" "$SB/S0"

# ------------------------------------------------------------------ 1. plan
say "1. plan (dry run)"
"$CUT" plan > "$SB/plan.out" 2>&1; rc=$?
sed 's/^/    /' "$SB/plan.out" | grep -E 'FAIL|WARN|would|summary|template-wins|carried' | head -60
check "plan exits 0" test "$rc" = 0
snap "$SB/S0p"; check "plan changed nothing" same_snap "$SB/S0" "$SB/S0p"
DB_NEW_NAME=cutover_test_mismatch "$CUT" plan > "$SB/plan-bad.out" 2>&1; rc=$?
check "plan fails when a rendered DATABASE_URL disagrees with the contract (render-time failure)" test "$rc" != 0
check "plan never prints a secret value" bash -c "! grep -qE 'fake-google-secret|fake-wa-token|fake-signal-token|oldpw-test|newpw-test|apppw|kkkkkkkk' '$SB/plan.out'"

# ------------------------------------------------------------------ 2. backup
say "2. backup (standalone)"
"$CUT" backup > "$SB/backup.out" 2>&1; rc=$?
tail -3 "$SB/backup.out" | sed 's/^/    /'
B1="$(find "$HOME" -maxdepth 1 -name 'pal-cutover-backup-*' | sort | tail -1)"
check "backup exits 0" test "$rc" = 0
check "backup dir is 0700" test "$(stat -f %Lp "$B1")" = 700
check "every backup file is 0600" bash -c "[ -z \"\$(find '$B1' -maxdepth 1 -type f ! -perm 600)\" ]"
check "backup archives verify" bash -c "cd '$B1' && shasum -a 256 -c -s SHA256SUMS"
snap "$SB/S0b"; check "standalone backup changed nothing" same_snap "$SB/S0" "$SB/S0b"
sleep 1

# ------------------------------------------------------------------ 3. apply
say "3. apply"
STUB_BOOTSTRAP_FAIL_ONCE=whatsapp-bridge "$CUT" apply > "$SB/apply.out" 2>&1; rc=$?
grep -E '===|FAIL|WARN|COMPLETE|ok +(moved|database|role|TCP|HEAD|installed|WhatsApp|iMessage|API|stashed)' "$SB/apply.out" | sed 's/^/    /' | head -70
check "apply exits 0" test "$rc" = 0
check "state dir .pal is a real dir" test -d "$HOME/.pal" -a ! -L "$HOME/.pal"
check ".lantern is now a compat symlink to .pal" test "$(readlink "$HOME/.lantern")" = "$HOME/.pal"
check "no LANTERN_ keys left in env files" bash -c "! grep -hE '^(export +)?LANTERN_' '$HOME'/.pal/*.env"
check "env values byte-identical after the key rename" bash -c "diff <(tar -xzOf \"\$(find '$HOME' -maxdepth 1 -name 'pal-cutover-backup-*' | sort | tail -1)/state.tgz\" .lantern/bridge.env | sed -E 's/^(export +)?LANTERN_/\\1PAL_/') '$HOME/.pal/bridge.env'"
check "env files written 0600 (imessage.env was 0644)" bash -c "[ -z \"\$(find '$HOME/.pal' -maxdepth 1 -name '*.env' ! -perm 600)\" ]"
check "non-LANTERN key untouched" grep -q '^OTHER_TOOL_FLAG=keep-me$' "$HOME/.pal/bridge.env"
check "no dev.lantern.* files left in LaunchAgents" bash -c "! ls '$LA'/dev.lantern.* >/dev/null 2>&1"
check "dev.pal.api.plist carried the live-only secret" test "$(python3 -I "$STUB_HELPER" plist-get "$LA/dev.pal.api.plist" env:GOOGLE_CLIENT_SECRET)" = fake-google-secret
check "dev.pal.api.plist renamed LANTERN_SIGNAL_TOKEN" test "$(python3 -I "$STUB_HELPER" plist-get "$LA/dev.pal.api.plist" env:PAL_SIGNAL_TOKEN)" = fake-signal-token
check "live override LOG_LEVEL kept over the template" test "$(python3 -I "$STUB_HELPER" plist-get "$LA/dev.pal.api.plist" env:LOG_LEVEL)" = debug
check "template DATABASE_URL won" bash -c "python3 -I '$STUB_HELPER' plist-get '$LA/dev.pal.api.plist' env:DATABASE_URL | grep -q 'pal_test:'"
check "live-only agent converted (label + log path)" bash -c "grep -q 'dev.pal.tunnel' '$LA/dev.pal.tunnel.plist' && grep -q 'Logs/PAL/tunnel' '$LA/dev.pal.tunnel.plist'"
check "label references in arguments converted" grep -q 'dev.pal.api' "$LA/dev.pal.signal-watchdog.plist"
check "unloaded agent installed but NOT started" bash -c "[ -f '$LA/dev.pal.post-reboot-check.plist' ] && [ ! -e '$STUB_STATE/jobs/dev.pal.post-reboot-check' ]"
check "every previously loaded job runs under dev.pal" bash -c "[ \$(ls '$STUB_STATE/jobs' | grep -c '^dev.pal') = 7 ] && ! ls '$STUB_STATE/jobs' | grep -q '^dev.lantern'"
check "bootstrap retry recovered an injected bootstrap failure" grep -q 'started dev.pal.whatsapp-bridge' "$SB/apply.out"
check "database + roles renamed" bash -c "echo \"select string_agg(datname,',') from pg_database where datname like 'cutover%'\" | $REAL_DOCKER exec -i $PG_CONTAINER psql -XAt -U pal_test -d postgres | grep -qx cutover_test_pal"
check "TCP password login as pal_test with the template password" bash -c "printf 'newpw-test\n' | $REAL_DOCKER exec -i $PG_CONTAINER sh -c 'IFS= read -r PGPASSWORD; export PGPASSWORD; psql -XAt -h 127.0.0.1 -U pal_test -d cutover_test_pal -c \"select count(*) from agents\"' | grep -qx 500"
check "app role password reset from PAL_APP_DB_PASSWORD" bash -c "printf 'apppw-new-test\n' | $REAL_DOCKER exec -i $PG_CONTAINER sh -c 'IFS= read -r PGPASSWORD; export PGPASSWORD; psql -XAt -h 127.0.0.1 -U pal_app_test -d cutover_test_pal -c \"select 1\"' | grep -qx 1"
check "temp superuser dropped" bash -c "[ -z \"\$(echo \"select 1 from pg_roles where rolname='pal_test_cutover_tmp'\" | $REAL_DOCKER exec -i $PG_CONTAINER psql -XAt -U pal_test -d postgres)\" ]"
check "checkout at the release commit" test "$(git -C "$REPO_DIR" rev-parse HEAD)" = "$REL"
check "origin points at the renamed repo" test "$(git -C "$REPO_DIR" remote get-url origin)" = "$SB/remote/pal.git"
check "owner's uncommitted change stashed, untracked file left alone" bash -c "git -C '$REPO_DIR' stash list | grep -q pal-cutover && [ -f '$REPO_DIR/notes.txt' ]"
check "WhatsApp creds untouched" bash -c "diff <(grep -A99 '# services/whatsapp-bridge/auth_sessions' '$SB/S0' | sed '/^## /q') <('$CUT' snapshot /dev/stdout old 2>/dev/null | grep -A99 '# services/whatsapp-bridge/auth_sessions' | sed '/^## /q')"
check "dashboard deps + next build ran under the node its plist PATH resolves (x64 fake)" bash -c "grep -q 'npm install --no-audit --no-fund (cwd=workspace/lantern/apps/web) node=fake-x64-bin/node' '$STUB_STATE/calls.log' && grep -q 'npm run build (cwd=workspace/lantern/apps/web) node=fake-x64-bin/node' '$STUB_STATE/calls.log'"
check "bridge deps installed under the newest nvm node (what run-bridge-wrapper.sh execs)" grep -q 'npm install --no-audit --no-fund (cwd=workspace/lantern/services/whatsapp-bridge) node=.nvm/versions/node/v99.0.0/bin/node' "$STUB_STATE/calls.log"
check "apply output never prints a secret value" bash -c "! grep -qE 'fake-google-secret|fake-wa-token|fake im token|fake-signal-token|oldpw-test|newpw-test|apppw|kkkkkkkk' '$SB/apply.out'"

# ------------------------------------------------------------------ 4. verify
say "4. verify (new side)"
"$CUT" verify > "$SB/verify.out" 2>&1; rc=$?
grep -E 'ok|FAIL|WARN|LIVENESS' "$SB/verify.out" | sed 's/^/    /' | head -30
check "verify exits 0" test "$rc" = 0
check "signals endpoint accepts x-pal-signal-token" grep -q 'accepts x-pal-signal-token' "$SB/verify.out"

# ------------------------------------------------------------------ 5. rollback
say "5. rollback"
"$CUT" rollback > "$SB/rollback.out" 2>&1; rc=$?
grep -E '===|FAIL|WARN|IDENTICAL|restored|back' "$SB/rollback.out" | sed 's/^/    /' | head -40
check "rollback exits 0" test "$rc" = 0
check "rollback reports an IDENTICAL snapshot" grep -q 'snapshot IDENTICAL' "$SB/rollback.out"

say "6. verify --old"
"$CUT" verify --old > "$SB/verify-old.out" 2>&1; rc=$?
grep -E 'FAIL|WARN|connected|chat.db|accepts' "$SB/verify-old.out" | sed 's/^/    /'
check "verify --old exits 0" test "$rc" = 0
snap "$SB/S1"; check "after rollback: byte-identical to the start (S0 == S1)" same_snap "$SB/S0" "$SB/S1"
[[ -s "$SB/last.diff" ]] && sed 's/^/      /' "$SB/last.diff" | head -30
check "post-cutover DB kept aside, not dropped" bash -c "echo \"select 1 from pg_database where datname like 'cutover_test_postcutover_%'\" | $REAL_DOCKER exec -i $PG_CONTAINER psql -XAt -U lantern_test -d postgres | grep -q 1"
check "owner's stashed change re-applied" grep -q 'owner hotfix' "$REPO_DIR/services/imessage-bridge/src/session.ts"

# ------------------------------------------------------------------ 7. failure injection
inject() {  # inject NAME ENV=VAL
  local name="$1"; shift
  say "7. failure injection: $name"
  sleep 1
  env "$@" "$CUT" apply > "$SB/fail-$name.out" 2>&1; rc=$?
  grep -E "FAILED|injected|auto-rollback|IDENTICAL|FAIL " "$SB/fail-$name.out" | sed 's/^/    /' | head -12
  check "[$name] apply exits non-zero" test "$rc" != 0
  check "[$name] auto-rollback reported IDENTICAL or had nothing to restore" grep -qE 'snapshot IDENTICAL|no verified backup' "$SB/fail-$name.out"
  snap "$SB/S-$name"; check "[$name] byte-identical to the start" same_snap "$SB/S0" "$SB/S-$name"
  [[ -s "$SB/last.diff" ]] && sed 's/^/      /' "$SB/last.diff" | head -30
}
inject after-state-move PAL_CUTOVER_FAIL_AT=state-move
inject after-db         PAL_CUTOVER_FAIL_AT=db
inject build-failure    STUB_BUILD_FAIL="npm run build"

# ------------------------------------------------------------------ 8. schema ahead of the old code
setver() { echo "UPDATE schema_migrations SET version=$1, dirty=false;" | "$REAL_DOCKER" exec -i "$PG_CONTAINER" psql -Xq -U lantern_test -d cutover_test; }
say "8a. DB schema v3 > old code's newest migration (2): plan must refuse until the owner picks"
setver 3; snap "$SB/S3"; sleep 1
"$CUT" plan > "$SB/plan-v3.out" 2>&1; rc=$?
grep -E 'schema v|ROLL|rollback target' "$SB/plan-v3.out" | cut -c12-260 | sed 's/^/    /'
check "[v3] plan fails without a choice" test "$rc" != 0
check "[v3] plan names the rollback target and both remedies" grep -q 'PAL_CUTOVER_ROLLBACK_REF=.*PAL_CUTOVER_ROLL_FORWARD_ONLY=1' "$SB/plan-v3.out"
check "[v3] plan warns the CURRENT API cannot restart" grep -q 'cannot even RESTART' "$SB/plan-v3.out"
PAL_CUTOVER_ROLL_FORWARD_ONLY=1 "$CUT" plan > "$SB/plan-v3-rfo.out" 2>&1; rc=$?
check "[v3] plan passes once roll-forward-only is acknowledged" test "$rc" = 0

say "8b. DB schema v4 > the RELEASE's newest migration (3): the release itself cannot start"
setver 4
PAL_CUTOVER_ROLL_FORWARD_ONLY=1 "$CUT" plan > "$SB/plan-v4.out" 2>&1; rc=$?
grep -E 'release: ' "$SB/plan-v4.out" | cut -c12-220 | sed 's/^/    /'
check "[v4] plan fails: release cannot start" bash -c "[ $rc != 0 ] && grep -q 'release: cutover_test is at schema v4' '$SB/plan-v4.out'"
setver 3

say "8c. v3 + PAL_CUTOVER_ROLLBACK_REF=release: apply → rollback restores everything but keeps startable code"
sleep 1
PAL_CUTOVER_ROLLBACK_REF="$REL" "$CUT" apply > "$SB/apply-v3.out" 2>&1; rc=$?
check "[v3/ref] apply exits 0" test "$rc" = 0
PAL_CUTOVER_ROLLBACK_REF="$REL" "$CUT" rollback > "$SB/rollback-v3.out" 2>&1; rc=$?
grep -E 'rollback target|schema v|HEAD at' "$SB/rollback-v3.out" | cut -c12-200 | sed 's/^/    /'
check "[v3/ref] rollback exits 0" test "$rc" = 0
check "[v3/ref] checkout left at the release (startable) commit" test "$(git -C "$REPO_DIR" rev-parse HEAD)" = "$REL"
"$CUT" verify --old > "$SB/verify-v3.out" 2>&1; rc=$?
check "[v3/ref] verify --old passes (schema check included)" bash -c "[ $rc = 0 ] && grep -q 'running checkout: cutover_test schema v3' '$SB/verify-v3.out'"
snap "$SB/S3r"
check "[v3/ref] state, plists, launchd, DB identical (git differs by design)" bash -c "diff <(sed '/^## git$/,/^## db$/d' '$SB/S3') <(sed '/^## git$/,/^## db$/d' '$SB/S3r') > '$SB/last.diff'"
git -C "$REPO_DIR" reset -q --keep "$OLD_SHA"   # back to the stale commit for the next case

say "8d. v3 + roll-forward-only: rollback must REPORT that the old code cannot start"
sleep 1
PAL_CUTOVER_ROLL_FORWARD_ONLY=1 "$CUT" apply > "$SB/apply-v3b.out" 2>&1; rc=$?
check "[v3/rfo] apply exits 0" test "$rc" = 0
"$CUT" rollback > "$SB/rollback-v3b.out" 2>&1; rc=$?
grep -E 'FAIL' "$SB/rollback-v3b.out" | cut -c12-230 | sed 's/^/    /'
check "[v3/rfo] rollback exits non-zero" test "$rc" != 0
check "[v3/rfo] rollback names the unstartable checkout" grep -q 'rollback checkout: cutover_test is at schema v3' "$SB/rollback-v3b.out"
"$CUT" verify --old > "$SB/verify-v3b.out" 2>&1; rc=$?
check "[v3/rfo] verify --old fails on the schema check" bash -c "[ $rc != 0 ] && grep -q 'FAIL  running checkout' '$SB/verify-v3b.out'"
setver 2

# ------------------------------------------------------------------ 9. live-found: target state dir appears mid-cutover
say "9a. something writes ~/.pal/credentials.json while services stop (the 08:05 live race)"
sleep 1; S9="$SB/S9"; snap "$S9"
STUB_ON_BOOTOUT_CREATE="$HOME/.pal/credentials.json" "$CUT" apply > "$SB/race.out" 2>&1; rc=$?
grep -E 'NOT empty|rename|NESTED|IDENTICAL|left .* alone' "$SB/race.out" | cut -c12-220 | sed 's/^/    /'
check "[race] apply refuses (non-zero)" test "$rc" != 0
check "[race] refusal names the non-empty target" grep -q 'is NOT empty (credentials.json' "$SB/race.out"
check "[race] state never nested" test ! -e "$HOME/.pal/.lantern"
check "[race] the foreign ~/.pal/credentials.json is left where it was" test -f "$HOME/.pal/credentials.json"
check "[race] old state intact and byte-identical (auto-rollback)" bash -c "'$CUT' snapshot '$SB/S9b' old >/dev/null 2>&1; diff -q '$S9' '$SB/S9b' >/dev/null"
rm -rf "$HOME/.pal"

say "9b. an EMPTY ~/.pal appears mid-cutover: replaced, cutover succeeds, then rollback"
sleep 1
STUB_ON_BOOTOUT_MKDIR="$HOME/.pal" "$CUT" apply > "$SB/race-empty.out" 2>&1; rc=$?
check "[empty-target] apply succeeds" test "$rc" = 0
check "[empty-target] sentinel at the top of ~/.pal, nothing nested" bash -c "[ -f '$HOME/.pal/bridge.env' ] && [ ! -e '$HOME/.pal/.lantern' ]"
check "[empty-target] env step saw every env file" bash -c "! grep -q 'env file(s) in' '$SB/race-empty.out'"
"$CUT" rollback > "$SB/race-empty-rb.out" 2>&1; rc=$?
check "[empty-target] rollback IDENTICAL" bash -c "[ $rc = 0 ] && grep -q 'snapshot IDENTICAL' '$SB/race-empty-rb.out'"

say "RESULT: $PASS passed, $FAILS failed"
echo "launchctl/docker/build calls recorded: $(wc -l < "$STUB_STATE/calls.log" | tr -d ' ')"
[[ "$FAILS" == 0 ]]
