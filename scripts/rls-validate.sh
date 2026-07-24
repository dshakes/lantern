#!/usr/bin/env bash
# scripts/rls-validate.sh — pre-flip RLS validation for the control-plane.
#
# Runs the full RLS test suite (internal/handlers/ -run RLS and
# internal/db/ -run RLS) against a Postgres instance.  Prints a PASS/FAIL
# summary and exits non-zero on any failure.
#
# Modes
# -----
#   Normal (default): uses DATABASE_URL (or the dev default).  Tests run
#   against the existing database.  Fast; safe for repeated runs.
#
#   Fresh (RLS_VALIDATE_FRESH=1): creates a throwaway Postgres database,
#   runs the idempotent Migrate() into it, validates there, then drops it.
#   Use this mode before flipping LANTERN_RLS_ENFORCE=1 on a new environment
#   to rule out dirty-state false-positives.
#
# Usage
# -----
#   ./scripts/rls-validate.sh                  # normal mode
#   RLS_VALIDATE_FRESH=1 ./scripts/rls-validate.sh    # fresh-DB mode
#
# Environment
# -----------
#   DATABASE_URL   Postgres DSN (default: postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable)
#   RLS_VALIDATE_FRESH   Set to 1 to create+migrate+drop a throwaway DB.
#
# Exit codes
#   0  All tests passed.
#   1  One or more tests failed.
#   2  Prerequisite not met (psql not found, DB unreachable, etc.).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CP_DIR="${REPO_ROOT}/services/control-plane"

DEV_DSN="postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable"
DATABASE_URL="${DATABASE_URL:-${DEV_DSN}}"

RLS_VALIDATE_FRESH="${RLS_VALIDATE_FRESH:-0}"

# ─── Colours ────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RESET='\033[0m'

pass() { echo -e "${GREEN}✓${RESET}  $*"; }
fail() { echo -e "${RED}✗${RESET}  $*"; }
info() { echo -e "${CYAN}→${RESET}  $*"; }
warn() { echo -e "${YELLOW}!${RESET}  $*"; }

FAILED=0

# ─── Prerequisites ──────────────────────────────────────────────────────────
echo
echo -e "${CYAN}=== Lantern RLS validation ===${RESET}"
echo

info "DATABASE_URL = ${DATABASE_URL}"
info "Fresh mode   = ${RLS_VALIDATE_FRESH}"
echo

# psql must be available for the fresh-mode createdb/dropdb step.
if [[ "${RLS_VALIDATE_FRESH}" == "1" ]]; then
  if ! command -v psql &>/dev/null; then
    echo -e "${RED}ERROR${RESET}: psql not found — required for fresh-DB mode."
    exit 2
  fi
fi

# Verify the Postgres server is reachable.
info "Checking Postgres reachability..."
if ! psql "${DATABASE_URL}" -c "SELECT 1" &>/dev/null 2>&1; then
  echo -e "${RED}ERROR${RESET}: cannot connect to ${DATABASE_URL}"
  echo "  Run 'make dev-infra' to start the local Postgres, then retry."
  exit 2
fi
pass "Postgres reachable"
echo

# ─── Fresh-DB setup ──────────────────────────────────────────────────────────
FRESH_DB_NAME=""
FRESH_DATABASE_URL=""

if [[ "${RLS_VALIDATE_FRESH}" == "1" ]]; then
  FRESH_DB_NAME="lantern_rls_validate_$$"
  info "Creating throwaway database: ${FRESH_DB_NAME}"

  # Build an admin DSN (postgres database) by swapping the DB name.
  # Works with the dev DSN; for custom DSNs the user must ensure createdb rights.
  ADMIN_DSN="${DATABASE_URL/%lantern?sslmode=disable/postgres?sslmode=disable}"
  ADMIN_DSN="${ADMIN_DSN/%lantern/postgres}"

  psql "${DATABASE_URL}" -c "CREATE DATABASE ${FRESH_DB_NAME};" &>/dev/null || {
    echo -e "${RED}ERROR${RESET}: could not create ${FRESH_DB_NAME} — does the DB user have CREATEDB?"
    exit 2
  }
  pass "Created throwaway database: ${FRESH_DB_NAME}"

  # Build the fresh DSN by substituting the database name.
  FRESH_DATABASE_URL="${DATABASE_URL/\/lantern?/\/${FRESH_DB_NAME}?}"

  # Cleanup on exit — always, even on error.
  cleanup_fresh() {
    info "Dropping throwaway database: ${FRESH_DB_NAME}"
    psql "${DATABASE_URL}" -c "DROP DATABASE IF EXISTS ${FRESH_DB_NAME};" &>/dev/null || true
  }
  trap cleanup_fresh EXIT

  DATABASE_URL="${FRESH_DATABASE_URL}"
  info "Running migrations into ${FRESH_DB_NAME}..."
  # Migrations are run implicitly by the test harness (each test calls Migrate),
  # but we verify connectivity to the fresh DB first.
  if ! psql "${DATABASE_URL}" -c "SELECT 1" &>/dev/null; then
    echo -e "${RED}ERROR${RESET}: cannot connect to fresh DB ${FRESH_DB_NAME}"
    exit 2
  fi
  pass "Fresh database ready at ${DATABASE_URL}"
  echo
fi

# ─── Check lantern_app role ──────────────────────────────────────────────────
info "Checking lantern_app role..."
ROLE_EXISTS=$(psql "${DATABASE_URL}" -tAc "SELECT COUNT(1) FROM pg_roles WHERE rolname='lantern_app'" 2>/dev/null || echo "0")
if [[ "${ROLE_EXISTS}" == "1" ]]; then
  pass "lantern_app role exists"
else
  warn "lantern_app role not found — the test harness will create it via Migrate()"
fi
echo

# ─── Run the test suites ─────────────────────────────────────────────────────
run_suite() {
  local label="$1"
  local pkg="$2"
  local filter="$3"
  local extra_args="${4:-}"

  info "Running: ${label}"
  echo "  cd ${CP_DIR} && DATABASE_URL=... go test -race -p 1 -run '${filter}' ${pkg} ${extra_args}"
  echo

  local logfile
  logfile=$(mktemp /tmp/rls-validate-XXXXXXXX.log)

  set +e
  (
    cd "${CP_DIR}"
    DATABASE_URL="${DATABASE_URL}" \
    LANTERN_RLS_ENFORCE=1 \
      go test -race -p 1 -v -run "${filter}" "${pkg}" ${extra_args} 2>&1
  ) | tee "${logfile}"
  local exit_code=${PIPESTATUS[0]}
  set -e

  echo
  if [[ "${exit_code}" -eq 0 ]]; then
    pass "${label}: PASSED"
    # Print tail of log for evidence.
    tail -5 "${logfile}" | sed 's/^/    /'
  else
    fail "${label}: FAILED (exit ${exit_code})"
    FAILED=1
  fi
  echo

  rm -f "${logfile}"
}

run_suite \
  "internal/db  RLS catalog + cross-tenant" \
  "./internal/db/..." \
  "^TestRLSEnforcement" \
  ""

run_suite \
  "internal/handlers  RLS harness + handler cutover" \
  "./internal/handlers/..." \
  "^(TestRLS|TestRLSHarness)" \
  "-p 1"

# ─── Summary ─────────────────────────────────────────────────────────────────
echo
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [[ "${FAILED}" -eq 0 ]]; then
  echo -e "${GREEN}PASS${RESET}  All RLS validation suites passed."
  echo
  echo "  What was validated:"
  echo "    • Postgres catalog: ENABLE + FORCE RLS on all ~40 tenant tables"
  echo "    • lantern_app role present and RLS-subject (no BYPASSRLS)"
  echo "    • Cross-tenant reads return 0 rows under the app role"
  echo "    • Same-tenant reads still return the expected rows (no regression)"
  echo "    • Handler cutover paths (WithTenant / WithTenantConn) correct"
  echo
  echo "  What is NOT validated here (requires the target cluster):"
  echo "    • LANTERN_APP_DB_PASSWORD set and accepted by the target Postgres"
  echo "    • AppPool actually connects as lantern_app in the live API process"
  echo "    • Live traffic / RLS miss-rate under production load"
  echo
  echo "  When ready: set LANTERN_APP_DB_PASSWORD, then LANTERN_RLS_ENFORCE=1"
  echo "  See docs/runbooks/rls-flip.md for the full operator steps."
  exit 0
else
  echo -e "${RED}FAIL${RESET}  One or more RLS validation suites failed."
  echo
  echo "  Fix the failures above before flipping LANTERN_RLS_ENFORCE=1."
  echo "  See docs/runbooks/rls-flip.md for troubleshooting."
  exit 1
fi
