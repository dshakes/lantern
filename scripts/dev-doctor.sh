#!/usr/bin/env bash
# dev-doctor.sh — one-shot health check for the local dev stack.
#
# Usage:   make dev-doctor
# Exits:   0 if everything is green, 1 if any check fails red.
#
# Designed to be the first command you run when the dashboard shows
# 'API offline' or things feel weird. Each check prints a status line
# and (on failure) the exact next-step to recover. Total runtime < 5s.
#
# Add a check by appending a `check_<name>` function and calling it
# from the main() block at the bottom.

set -o pipefail

# Colors. Disable if NO_COLOR=1 or stdout isn't a terminal.
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  RED=$'\033[0;31m'
  GRN=$'\033[0;32m'
  YLW=$'\033[0;33m'
  DIM=$'\033[2m'
  BLD=$'\033[1m'
  RST=$'\033[0m'
else
  RED=''; GRN=''; YLW=''; DIM=''; BLD=''; RST=''
fi

OK_ICON="${GRN}✓${RST}"
WARN_ICON="${YLW}⚠${RST}"
FAIL_ICON="${RED}✗${RST}"

# Tracks how many checks failed.
FAILS=0
WARNS=0

# section <title> — group header
section() {
  printf "\n${BLD}%s${RST}\n" "$1"
}

# pass <name> <detail?>
pass() {
  printf "  %s %s" "$OK_ICON" "$1"
  [[ -n "${2:-}" ]] && printf " ${DIM}— %s${RST}" "$2"
  printf "\n"
}

# warn <name> <detail> <hint>
warn() {
  printf "  %s %s" "$WARN_ICON" "$1"
  [[ -n "${2:-}" ]] && printf " ${DIM}— %s${RST}" "$2"
  printf "\n"
  [[ -n "${3:-}" ]] && printf "    ${DIM}→ %s${RST}\n" "$3"
  WARNS=$((WARNS + 1))
}

# fail <name> <detail> <hint>
fail() {
  printf "  %s %s" "$FAIL_ICON" "$1"
  [[ -n "${2:-}" ]] && printf " ${DIM}— %s${RST}" "$2"
  printf "\n"
  [[ -n "${3:-}" ]] && printf "    ${DIM}→ %s${RST}\n" "$3"
  FAILS=$((FAILS + 1))
}

# port_listen <port> — true if anything is listening on the port
port_listen() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | grep -q LISTEN
}

# curl_status <url> — print HTTP status code or empty on fail
curl_status() {
  curl -sS -o /dev/null -w "%{http_code}" "$1" -m 2 2>/dev/null
}

# ---- Checks -----------------------------------------------------------------

check_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    fail "docker CLI" "" "Install Docker Desktop (https://docker.com/products/docker-desktop)"
    return
  fi
  if ! docker info >/dev/null 2>&1; then
    fail "docker daemon" "not running" "Start Docker Desktop, then re-run \`make dev-doctor\`"
    return
  fi
  pass "docker daemon" "$(docker version --format '{{.Server.Version}}' 2>/dev/null)"
}

check_postgres() {
  if ! port_listen 5432; then
    fail "postgres :5432" "no listener" "Run: ${BLD}make dev-infra${RST}"
    return
  fi
  if ! PGPASSWORD=lantern psql -h localhost -U lantern -d lantern -c 'SELECT 1' >/dev/null 2>&1; then
    fail "postgres auth" "listener up but query fails" "DB may be initializing — wait 10s and re-run"
    return
  fi
  local agents_count
  agents_count=$(PGPASSWORD=lantern psql -h localhost -U lantern -d lantern -tAc "SELECT COUNT(*) FROM agents WHERE archived_at IS NULL" 2>/dev/null)
  pass "postgres :5432" "agents=${agents_count:-0}"
}

check_redis() {
  if ! port_listen 6379; then
    fail "redis :6379" "no listener" "Run: ${BLD}make dev-infra${RST}"
    return
  fi
  # Use bash /dev/tcp ping since redis-cli isn't always installed.
  if ! exec 3<>/dev/tcp/localhost/6379 2>/dev/null; then
    fail "redis :6379" "connect failed"
    return
  fi
  printf 'PING\r\n' >&3
  local resp
  read -r -t 1 resp <&3 || true
  exec 3<&- 3>&- 2>/dev/null
  if [[ "$resp" == "+PONG"* ]]; then
    pass "redis :6379" "PONG"
  else
    warn "redis :6379" "listener up but no PONG" "Restart with \`make dev-infra\`"
  fi
}

check_minio() {
  if ! port_listen 9000; then
    warn "minio :9000" "no listener" "Run \`make dev-infra\` if you need bundle storage"
    return
  fi
  local code
  code=$(curl_status http://localhost:9000/minio/health/live)
  if [[ "$code" == "200" ]]; then
    pass "minio :9000" "live"
  else
    warn "minio :9000" "listener up but health=${code:-?}" "Storage operations may fail"
  fi
}

check_api() {
  if ! port_listen 8080; then
    fail "control-plane :8080" "no listener" "Run: ${BLD}make run-api${RST} (in a separate terminal)"
    return
  fi
  local code
  code=$(curl_status http://localhost:8080/healthz)
  if [[ "$code" != "200" ]]; then
    fail "control-plane /healthz" "got ${code:-no-response}" "Tail \`/tmp/lantern-api.log\` for the error"
    return
  fi
  # Verify login works — proves DB connection AND JWT signing are healthy.
  local login_body
  login_body=$(curl -sS -X POST http://localhost:8080/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"email":"admin@lantern.dev","password":"lantern"}' -m 3 2>/dev/null)
  if [[ "$login_body" == *'"token":'* ]]; then
    pass "control-plane :8080" "healthz=200, login=OK"
  else
    fail "control-plane auth" "login returned: ${login_body:0:80}" \
      "Likely postgres broke after the API started. Re-run ${BLD}make run-api${RST}"
  fi
}

check_grpc() {
  if port_listen 50051; then
    pass "control-plane gRPC :50051"
  else
    warn "control-plane gRPC :50051" "no listener" "SDKs that use gRPC won't connect"
  fi
}

check_bridge() {
  if ! port_listen 3100; then
    warn "whatsapp-bridge :3100" "no listener" "Run \`make run-whatsapp-bridge\` if you need WhatsApp"
    return
  fi
  local code
  code=$(curl_status http://localhost:3100/health)
  if [[ "$code" != "200" ]]; then
    fail "whatsapp-bridge /health" "got ${code:-no-response}" "Tail \`/tmp/lantern-whatsapp-bridge.log\`"
    return
  fi
  # Inspect session state for the dev tenant.
  local diag state paired
  diag=$(curl -sS "http://localhost:3100/session/00000000-0000-0000-0000-000000000001/diagnostics" -m 2 2>/dev/null)
  state=$(echo "$diag" | sed -nE 's/.*"state":"([^"]+)".*/\1/p')
  paired=$(echo "$diag" | sed -nE 's/.*"paired":(true|false).*/\1/p')
  case "$state" in
    connected)
      pass "whatsapp-bridge :3100" "session=connected, paired=$paired"
      ;;
    idle|"")
      warn "whatsapp-bridge :3100" "no active session" "Open Channels → WhatsApp in dashboard and click Pair"
      ;;
    conflict)
      fail "whatsapp-bridge :3100" "session=conflict" \
        "Another WhatsApp Web session is active. Log out other Linked Devices on phone, then click Forget device + re-pair"
      ;;
    logged_out)
      fail "whatsapp-bridge :3100" "session=logged_out" "Phone unlinked the bridge. Click Pair to relink"
      ;;
    reconnecting|connecting|starting|qr_ready)
      warn "whatsapp-bridge :3100" "session=$state" "Transient — re-run \`make dev-doctor\` in 5s"
      ;;
    *)
      warn "whatsapp-bridge :3100" "session=$state" ""
      ;;
  esac
}

check_dashboard() {
  if ! port_listen 3001; then
    warn "dashboard :3001" "no listener" "Run \`make dashboard-dev\`"
    return
  fi
  local code
  code=$(curl_status http://localhost:3001/)
  if [[ "$code" == "200" || "$code" == "307" || "$code" == "302" ]]; then
    pass "dashboard :3001" "Next.js responding (${code})"
  else
    warn "dashboard :3001" "unexpected status ${code:-?}" "Tail \`/tmp/lantern-dashboard.log\`"
  fi
}

# ---- Main -------------------------------------------------------------------

main() {
  printf "${BLD}Lantern dev doctor${RST} ${DIM}— $(date '+%H:%M:%S')${RST}\n"

  section "Infrastructure"
  check_docker
  check_postgres
  check_redis
  check_minio

  section "Services"
  check_api
  check_grpc
  check_bridge
  check_dashboard

  section "Summary"
  if [[ $FAILS -eq 0 && $WARNS -eq 0 ]]; then
    printf "  ${GRN}All systems healthy.${RST}\n"
    exit 0
  fi
  if [[ $FAILS -eq 0 ]]; then
    printf "  ${YLW}%d warning(s)${RST} — dev stack works but some surfaces are inactive.\n" "$WARNS"
    exit 0
  fi
  printf "  ${RED}%d failure(s)${RST}" "$FAILS"
  [[ $WARNS -gt 0 ]] && printf ", ${YLW}%d warning(s)${RST}" "$WARNS"
  printf " — follow the → hints above.\n"
  exit 1
}

main "$@"
