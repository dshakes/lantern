#!/usr/bin/env bash
# bridge-setup.sh — interactive onboarding wizard for the personal-assistant bridges.
#
# Usage:   make bridge-setup
#          bash scripts/bridge-setup.sh
#
# What it does:
#   1. Checks prereqs (macOS, Docker, Node ≥ 20, repo root)
#   2. Creates .env.local from .env.example if absent (never overwrites)
#   3. Prompts for core identity vars, updating .env.local in-place
#   4. Validates iMessage macOS permissions non-destructively
#   5. Prints a "what to run next" block
#
# Idempotent — safe to re-run at any time.
#
# LANTERN_ENV_FILE — override the target env file (useful for testing):
#   LANTERN_ENV_FILE=/tmp/test.env bash scripts/bridge-setup.sh

set -o pipefail

# ---- Colour setup (mirrors dev-doctor.sh) -----------------------------------

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  RED=$'\033[0;31m'
  GRN=$'\033[0;32m'
  YLW=$'\033[0;33m'
  CYN=$'\033[0;36m'
  DIM=$'\033[2m'
  BLD=$'\033[1m'
  RST=$'\033[0m'
else
  RED=''; GRN=''; YLW=''; CYN=''; DIM=''; BLD=''; RST=''
fi

OK_ICON="${GRN}✓${RST}"
WARN_ICON="${YLW}⚠${RST}"
FAIL_ICON="${RED}✗${RST}"
INFO_ICON="${CYN}→${RST}"

FAILS=0

# ---- Helpers ----------------------------------------------------------------

section() {
  printf "\n${BLD}%s${RST}\n" "$1"
}

pass() {
  printf "  %s %s" "$OK_ICON" "$1"
  [[ -n "${2:-}" ]] && printf " ${DIM}— %s${RST}" "$2"
  printf "\n"
}

warn() {
  printf "  %s %s" "$WARN_ICON" "$1"
  [[ -n "${2:-}" ]] && printf " ${DIM}— %s${RST}" "$2"
  printf "\n"
  [[ -n "${3:-}" ]] && printf "    ${DIM}→ %s${RST}\n" "$3"
}

fail() {
  printf "  %s %s" "$FAIL_ICON" "$1"
  [[ -n "${2:-}" ]] && printf " ${DIM}— %s${RST}" "$2"
  printf "\n"
  [[ -n "${3:-}" ]] && printf "    ${DIM}→ %s${RST}\n" "$3"
  FAILS=$((FAILS + 1))
}

info() {
  printf "  %s %s\n" "$INFO_ICON" "$1"
}

# prompt_with_default <varname> <prompt-label> <current-default>
# Reads a line from stdin; if empty, uses the default.
prompt_with_default() {
  local varname="$1"
  local label="$2"
  local default="$3"
  local value
  if [[ -n "$default" ]]; then
    printf "  ${BLD}%s${RST} ${DIM}[%s]${RST}: " "$label" "$default"
  else
    printf "  ${BLD}%s${RST}: " "$label"
  fi
  read -r value
  if [[ -z "$value" ]]; then
    value="$default"
  fi
  printf -v "$varname" '%s' "$value"
}

# prompt_yn <varname> <question> <default y|n>
# Sets varname to "y" or "n".
prompt_yn() {
  local varname="$1"
  local question="$2"
  local default="${3:-n}"
  local hint
  if [[ "$default" == "y" ]]; then
    hint="Y/n"
  else
    hint="y/N"
  fi
  printf "  ${BLD}%s${RST} [%s]: " "$question" "$hint"
  local value
  read -r value
  value=$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')
  if [[ -z "$value" ]]; then
    value="$default"
  fi
  case "$value" in
    y|yes) printf -v "$varname" 'y' ;;
    *)     printf -v "$varname" 'n' ;;
  esac
}

# env_get <file> <key>  — print the current value of KEY in env file, or empty
env_get() {
  local file="$1"
  local key="$2"
  if [[ ! -f "$file" ]]; then
    printf ''
    return
  fi
  # Match uncommented KEY=value lines (BSD + GNU sed compatible)
  grep -E "^${key}=" "$file" | tail -1 | sed 's/^[^=]*=//'
}

# env_set <file> <key> <value>
# Updates key in-place if present (including commented-out form), appends if absent.
# Uses only POSIX-portable sed features — no \| alternation, no in-place -i ''.
env_set() {
  local file="$1"
  local key="$2"
  local value="$3"

  if grep -qE "^#?${key}=" "$file" 2>/dev/null; then
    # Replace the first matching line (commented or not) — BSD sed compatible
    # We use a temp file instead of sed -i '' to avoid the GNU/BSD sed -i quirk.
    local tmp
    tmp="$(mktemp)"
    awk -v k="$key" -v v="$value" -v done=0 '
      !done && /^#?[[:space:]]*/ && $0 ~ "^#?"k"=" {
        print k"="v
        done=1
        next
      }
      { print }
    ' "$file" > "$tmp"
    mv "$tmp" "$file"
  else
    # Append
    printf '\n%s=%s\n' "$key" "$value" >> "$file"
  fi
}

# detect_timezone — best-effort IANA timezone from /etc/localtime symlink
detect_timezone() {
  local tz
  tz=$(readlink /etc/localtime 2>/dev/null | sed 's|.*/zoneinfo/||')
  if [[ -z "$tz" ]]; then
    # Fallback for systems where /etc/localtime is a copy, not a symlink
    tz=$(timedatectl show --property=Timezone --value 2>/dev/null || true)
  fi
  printf '%s' "${tz:-America/Los_Angeles}"
}

# ---- Repo root detection ----------------------------------------------------

REPO_ROOT=""
find_repo_root() {
  local dir
  dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  while [[ "$dir" != "/" ]]; do
    if [[ -f "$dir/Makefile" && -f "$dir/.env.example" ]]; then
      REPO_ROOT="$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

# ---- ENV FILE ---------------------------------------------------------------

# Allow override for testing: LANTERN_ENV_FILE=/tmp/test.env bash bridge-setup.sh
setup_env_file() {
  local env_file="$1"
  local example_file="${REPO_ROOT}/.env.example"

  if [[ -f "$env_file" ]]; then
    pass ".env.local" "already exists — will update in-place (never overwrites)"
  else
    if [[ -f "$example_file" ]]; then
      cp "$example_file" "$env_file"
      pass ".env.local" "created from .env.example"
    else
      # Create a minimal stub
      printf '# Lantern env — created by bridge-setup.sh\n' > "$env_file"
      warn ".env.local" "created minimal stub (.env.example not found)"
    fi
  fi
}

# ---- Prereq checks ----------------------------------------------------------

check_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    fail "macOS" "detected $(uname -s)" \
      "The iMessage bridge is macOS-only (reads ~/Library/Messages/chat.db and drives Messages.app via AppleScript). WhatsApp bridge works on Linux but this wizard targets macOS personal setup."
    printf "\n  ${YLW}Continuing anyway — WhatsApp-only setups work cross-platform.${RST}\n"
  else
    pass "macOS" "$(sw_vers -productVersion 2>/dev/null || echo "detected")"
  fi
}

check_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    fail "Docker CLI" "" "Install Docker Desktop: https://docker.com/products/docker-desktop"
    return
  fi
  if ! docker info >/dev/null 2>&1; then
    fail "Docker daemon" "not running" "Start Docker Desktop, then re-run \`make bridge-setup\`"
    return
  fi
  pass "Docker" "$(docker version --format '{{.Server.Version}}' 2>/dev/null)"
}

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    fail "Node.js" "not found" "Install Node 20+: https://nodejs.org or \`brew install node\`"
    return
  fi
  local ver
  ver=$(node --version | sed 's/v//')
  local major
  major=$(printf '%s' "$ver" | cut -d. -f1)
  if [[ "$major" -lt 20 ]]; then
    fail "Node.js" "v${ver} — need ≥ 20" "Upgrade: \`nvm install 20\` or \`brew upgrade node\`"
  else
    pass "Node.js" "v${ver}"
  fi
}

check_repo_root() {
  if ! find_repo_root; then
    fail "Lantern repo root" "Makefile + .env.example not found walking up from script location" \
      "Run this script from inside the cloned lantern repo."
    printf "\n"
    exit 1
  fi
  pass "Repo root" "$REPO_ROOT"
}

# ---- Identity prompts -------------------------------------------------------

collect_identity() {
  local env_file="$1"

  printf "\n  ${DIM}Core identity vars — used by both bridges and the control-plane.${RST}\n"
  printf "  ${DIM}Press Enter to keep the value shown in [brackets].${RST}\n\n"

  # LANTERN_OWNER_NAME
  local cur_name
  cur_name=$(env_get "$env_file" "LANTERN_OWNER_NAME")
  prompt_with_default LANTERN_OWNER_NAME "Your first name" "${cur_name:-}"
  if [[ -n "$LANTERN_OWNER_NAME" ]]; then
    env_set "$env_file" "LANTERN_OWNER_NAME" "$LANTERN_OWNER_NAME"
    pass "LANTERN_OWNER_NAME" "$LANTERN_OWNER_NAME"
  fi

  # LANTERN_OWNER_EMAIL
  local cur_email
  cur_email=$(env_get "$env_file" "LANTERN_OWNER_EMAIL")
  prompt_with_default LANTERN_OWNER_EMAIL "Your email address (for mirror alerts)" "${cur_email:-}"
  if [[ -n "$LANTERN_OWNER_EMAIL" ]]; then
    env_set "$env_file" "LANTERN_OWNER_EMAIL" "$LANTERN_OWNER_EMAIL"
    pass "LANTERN_OWNER_EMAIL" "$LANTERN_OWNER_EMAIL"
  fi

  # LANTERN_OWNER_TIMEZONE
  local cur_tz detected_tz
  cur_tz=$(env_get "$env_file" "LANTERN_OWNER_TIMEZONE")
  detected_tz=$(detect_timezone)
  local tz_default="${cur_tz:-$detected_tz}"
  prompt_with_default LANTERN_OWNER_TIMEZONE "Your IANA timezone (quiet hours + digest)" "$tz_default"
  if [[ -n "$LANTERN_OWNER_TIMEZONE" ]]; then
    env_set "$env_file" "LANTERN_OWNER_TIMEZONE" "$LANTERN_OWNER_TIMEZONE"
    pass "LANTERN_OWNER_TIMEZONE" "$LANTERN_OWNER_TIMEZONE"
  fi
}

collect_optional_jids() {
  local env_file="$1"

  printf "\n  ${DIM}Owner identity for the bridges — controls who gets owner-level access.${RST}\n"
  printf "  ${DIM}Self-chat mode: owner messages their own WhatsApp/iMessage number (default).${RST}\n"
  printf "  ${DIM}Bot-account mode: owner DMs a SEPARATE bot number — set the JID below.${RST}\n\n"

  local yn
  prompt_yn yn "Configure a dedicated WhatsApp bot account? (sets LANTERN_WA_OWNER_JID)" "n"
  if [[ "$yn" == "y" ]]; then
    local cur_jid
    cur_jid=$(env_get "$env_file" "LANTERN_WA_OWNER_JID")
    prompt_with_default LANTERN_WA_OWNER_JID \
      "Your WhatsApp number (digits only, e.g. 15125551234)" \
      "${cur_jid:-}"
    if [[ -n "$LANTERN_WA_OWNER_JID" ]]; then
      env_set "$env_file" "LANTERN_WA_OWNER_JID" "$LANTERN_WA_OWNER_JID"
      pass "LANTERN_WA_OWNER_JID" "$LANTERN_WA_OWNER_JID"
    fi
  else
    info "Skipped — WhatsApp will use self-chat mode (owner messages their own number)"
  fi

  printf "\n"
  prompt_yn yn "Configure a dedicated iMessage bot account? (sets LANTERN_IMESSAGE_OWNER_HANDLE)" "n"
  if [[ "$yn" == "y" ]]; then
    local cur_handle
    cur_handle=$(env_get "$env_file" "LANTERN_IMESSAGE_OWNER_HANDLE")
    prompt_with_default LANTERN_IMESSAGE_OWNER_HANDLE \
      "Your iMessage handle (phone +15125551234 or Apple ID email)" \
      "${cur_handle:-}"
    if [[ -n "$LANTERN_IMESSAGE_OWNER_HANDLE" ]]; then
      env_set "$env_file" "LANTERN_IMESSAGE_OWNER_HANDLE" "$LANTERN_IMESSAGE_OWNER_HANDLE"
      pass "LANTERN_IMESSAGE_OWNER_HANDLE" "$LANTERN_IMESSAGE_OWNER_HANDLE"
    fi
  else
    info "Skipped — iMessage will use self-chat mode (owner messages their own number)"
  fi
}

# ---- Bridge selection -------------------------------------------------------

collect_bridges() {
  local whatsapp_yn imessage_yn
  printf "\n  ${DIM}Which bridges do you want to set up?${RST}\n\n"
  prompt_yn whatsapp_yn "Set up WhatsApp bridge?" "y"
  prompt_yn imessage_yn "Set up iMessage bridge? (macOS only)" "y"
  WANT_WHATSAPP="$whatsapp_yn"
  WANT_IMESSAGE="$imessage_yn"
}

# ---- iMessage TCC probe -----------------------------------------------------

check_imessage_permissions() {
  printf "\n  ${DIM}Probing iMessage Full Disk Access (non-destructive read test)…${RST}\n"
  local db="$HOME/Library/Messages/chat.db"

  if [[ ! -f "$db" ]]; then
    warn "chat.db" "not found at $db" \
      "Make sure you are signed into iMessage in Messages.app and have sent at least one message."
    return
  fi

  if sqlite3 "$db" "SELECT 1 LIMIT 1" >/dev/null 2>&1; then
    pass "Full Disk Access" "chat.db readable — no action needed"
  else
    fail "Full Disk Access" "cannot read ~/Library/Messages/chat.db" \
      "Grant FDA to the binary that runs the bridge:"
    printf "\n"
    printf "    ${BLD}System Settings → Privacy & Security → Full Disk Access${RST}\n"
    printf "    Click + and add:\n"
    printf "      • ${BLD}Terminal.app${RST} or ${BLD}iTerm.app${RST} (if running via \`make run-imessage-bridge\`)\n"
    printf "      • Your Node binary (run \`which node\` to find it) for LaunchAgent/always-on\n"
    printf "\n"
    printf "    After granting, restart the bridge (\`make run-imessage-bridge\`).\n"
  fi

  printf "\n"
  printf "  ${WARN_ICON} Automation → Messages\n"
  printf "    ${DIM}The bridge sends replies by driving Messages.app via AppleScript.${RST}\n"
  printf "    ${BLD}System Settings → Privacy & Security → Automation${RST}\n"
  printf "    Find your terminal / Node binary → expand → toggle ${BLD}Messages${RST} ON.\n"
  printf "    macOS will pop a permission dialog on first send — click Allow.\n"
}

# ---- Next steps block -------------------------------------------------------

print_next_steps() {
  local want_wa="$1"
  local want_im="$2"

  printf "\n"
  printf "${BLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}\n"
  printf "${BLD}  Next steps${RST}\n"
  printf "${BLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}\n\n"

  printf "  ${BLD}1. Start infrastructure (Postgres + Redis + MinIO)${RST}\n"
  printf "       make dev-infra\n\n"

  printf "  ${BLD}2. Start the control-plane API${RST}\n"
  printf "       make run-api\n\n"

  printf "  ${BLD}3. Start the dashboard${RST}\n"
  printf "       make dashboard-dev\n\n"

  printf "  ${BLD}4. Open the dashboard${RST}\n"
  printf "       http://localhost:3001\n"
  printf "       Login: ${CYN}admin@lantern.dev${RST} / ${CYN}lantern${RST}\n\n"

  printf "  ${BLD}5. Add an LLM provider key${RST}\n"
  printf "       Dashboard → Settings → LLM Providers\n"
  printf "       Add an Anthropic or OpenAI key. Without this the assistant has no brain.\n"
  printf '       '"${DIM}"'Free alternative: add LANTERN_USE_CLAUDE_CODE=1 to .env.local to route\n'
  printf '       through your local `claude` CLI (Claude Max subscription, $0 API cost).'"${RST}"'\n\n'

  if [[ "$want_wa" == "y" ]]; then
    printf "  ${BLD}6. Pair WhatsApp${RST}\n"
    printf "       make run-whatsapp-bridge\n"
    printf "       Then: Dashboard → Channels → WhatsApp → Pair WhatsApp\n"
    printf "       Scan the QR with your phone (WhatsApp → Settings → Linked Devices → Link a Device)\n\n"
  fi

  if [[ "$want_im" == "y" ]]; then
    local step=6
    [[ "$want_wa" == "y" ]] && step=7
    printf "  ${BLD}%d. Start iMessage bridge${RST}\n" "$step"
    printf "       make run-imessage-bridge\n"
    printf "       ${DIM}Requires Full Disk Access + Automation → Messages (see check above).${RST}\n\n"
  fi

  local next_step=6
  [[ "$want_wa" == "y" ]] && next_step=$((next_step + 1))
  [[ "$want_im" == "y" ]] && next_step=$((next_step + 1))

  printf "  ${BLD}%d. Always-on (optional — starts everything at login)${RST}\n" "$next_step"
  printf "       make autostart-install\n\n"

  printf "  ${DIM}Full guide: docs/personal/SETUP.md${RST}\n"
  printf "  ${DIM}Dedicated bot account setup: docs/personal/BOT-SETUP.md${RST}\n"
  printf "  ${DIM}Health check: make dev-doctor${RST}\n\n"
}

# ---- Main -------------------------------------------------------------------

main() {
  printf "${BLD}Lantern bridge setup wizard${RST} ${DIM}— personal-assistant onboarding${RST}\n"

  # Determine env file path (testable via LANTERN_ENV_FILE override)
  section "Repo detection"
  check_repo_root

  local ENV_FILE="${LANTERN_ENV_FILE:-${REPO_ROOT}/.env.local}"

  section "Prereq checks"
  check_macos
  check_docker
  check_node

  if [[ $FAILS -gt 0 ]]; then
    printf "\n  ${RED}%d prereq failure(s) — resolve the → hints above, then re-run \`make bridge-setup\`.${RST}\n\n" "$FAILS"
    exit 1
  fi

  section "Environment file"
  setup_env_file "$ENV_FILE"
  printf "  ${DIM}env file: %s${RST}\n" "$ENV_FILE"

  section "Identity"
  collect_identity "$ENV_FILE"

  section "Owner handles (dedicated bot mode)"
  collect_optional_jids "$ENV_FILE"

  section "Bridge selection"
  collect_bridges

  if [[ "${WANT_IMESSAGE:-n}" == "y" && "$(uname -s)" == "Darwin" ]]; then
    section "iMessage permissions"
    check_imessage_permissions
  fi

  section "Done"
  pass ".env.local updated" "$ENV_FILE"
  print_next_steps "${WANT_WHATSAPP:-n}" "${WANT_IMESSAGE:-n}"
}

main "$@"
