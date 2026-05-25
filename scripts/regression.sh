#!/usr/bin/env bash
# Lantern regression test — exercises the critical paths an alpha
# user depends on. Designed to run nightly via cron / CI, with a
# non-zero exit on failure.
#
# Tests:
#   1. Control-plane health
#   2. Auth/login works
#   3. WhatsApp + iMessage bridge /health endpoints respond
#   4. iMessage bridge can list chats (verifies FDA / chat.db access)
#   5. Session API creates + accepts messages
#   6. nl-commands parser handles all expected inputs
#   7. End-to-end: POST session message with noTools, verify reply comes back
#   8. Email mirror connector works (sends test mail to LANTERN_OWNER_EMAIL)
#
# Usage:
#   ./scripts/regression.sh                  # run all tests, exit non-zero on failure
#   ./scripts/regression.sh --skip-email     # skip the email test (no real send)
#   ./scripts/regression.sh --quiet          # only print failures

set -u

API_URL="${LANTERN_API_URL:-http://localhost:8080}"
WA_URL="${LANTERN_BRIDGE_URL:-http://localhost:3100}"
IM_URL="${LANTERN_IMESSAGE_BRIDGE_URL:-http://localhost:3200}"
TENANT="${LANTERN_DEFAULT_TENANT_ID:-00000000-0000-0000-0000-000000000001}"
EMAIL="${LANTERN_BRIDGE_EMAIL:-admin@lantern.dev}"
PASSWORD="${LANTERN_BRIDGE_PASSWORD:-lantern}"

QUIET=0
SKIP_EMAIL=0
for arg in "$@"; do
  case "$arg" in
    --quiet) QUIET=1 ;;
    --skip-email) SKIP_EMAIL=1 ;;
  esac
done

PASS=0
FAIL=0
FAIL_DETAILS=()

log() { [[ $QUIET -eq 0 ]] && echo "$@"; }
pass() { PASS=$((PASS+1)); log "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); FAIL_DETAILS+=("$1: $2"); log "  ✗ $1 — $2"; }

# ---- 1. control-plane health -------------------------------------------
log ""
log "[1/8] control-plane /healthz"
code=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/healthz" --max-time 5 2>/dev/null)
[[ "$code" == "200" ]] && pass "control-plane reachable" || fail "control-plane" "HTTP $code"

# ---- 2. auth ------------------------------------------------------------
log "[2/8] auth login"
TOKEN=$(curl -s -X POST "$API_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" --max-time 10 \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
[[ -n "$TOKEN" ]] && pass "got JWT (len=${#TOKEN})" || fail "auth" "no token returned"

# ---- 3. bridge health --------------------------------------------------
log "[3/8] bridge /health endpoints"
wa_code=$(curl -s -o /dev/null -w "%{http_code}" "$WA_URL/health" --max-time 3 2>/dev/null)
[[ "$wa_code" == "200" ]] && pass "whatsapp bridge :$WA_URL" || fail "wa-bridge" "HTTP $wa_code"
im_code=$(curl -s -o /dev/null -w "%{http_code}" "$IM_URL/health" --max-time 3 2>/dev/null)
[[ "$im_code" == "200" ]] && pass "imessage bridge :$IM_URL" || fail "im-bridge" "HTTP $im_code"

# ---- 4. iMessage chat.db read access -----------------------------------
log "[4/8] iMessage chat.db read access"
if [[ "$im_code" == "200" ]]; then
  diag=$(curl -s "$IM_URL/session/$TENANT/diagnostics" --max-time 5 2>/dev/null)
  state=$(echo "$diag" | python3 -c "import sys,json;print(json.load(sys.stdin).get('state','?'))" 2>/dev/null)
  case "$state" in
    ready) pass "imessage bridge ready" ;;
    permission_required) fail "im-perms" "Full Disk Access or Automation missing — see docs/personal/SETUP.md" ;;
    idle) pass "imessage bridge idle (will start on first inbound)" ;;
    *) fail "im-state" "state=$state" ;;
  esac
else
  fail "im-state" "bridge unreachable"
fi

# ---- 5. session API create + post --------------------------------------
log "[5/8] session API"
if [[ -n "$TOKEN" ]]; then
  SESSION=$(curl -s -X POST "$API_URL/v1/sessions" -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" -d '{"agentName":"imessage-assistant"}' --max-time 5 \
    | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
  [[ -n "$SESSION" ]] && pass "created session $SESSION" || fail "session-create" "no id returned"
fi

# ---- 6. nl-commands parser ---------------------------------------------
log "[6/8] nl-commands parser"
cd "$(dirname "$0")/.." 2>/dev/null
PARSE_OUT=$(cd services/imessage-bridge 2>/dev/null && npx tsx -e '
import { parseNLCommand } from "@lantern/bridge-core/nl-commands";
const tests = [
  ["pause", "mute"],
  ["status", "status"],
  ["help", "help"],
  ["pause for 2 hours", "mute"],
  ["wake up", "unmute"],
  ["resume everyone", "resume-all"],
  ["ping", "ping"],
  ["what'\''s paused", "list-paused"],
];
let ok = 0, bad = 0;
for (const [input, expected] of tests) {
  const got = parseNLCommand(input)?.action;
  if (got === expected) ok++; else { bad++; console.log(`  PARSE-FAIL: "${input}" -> ${got} (expected ${expected})`); }
}
console.log(`PARSER: ${ok} ok / ${bad} bad`);
process.exit(bad > 0 ? 1 : 0);
' 2>&1)
echo "$PARSE_OUT" | grep -q "0 bad" && pass "nl-commands parser (8 cases)" || fail "nl-parser" "$PARSE_OUT"

# ---- 7. end-to-end reply (noTools) -------------------------------------
log "[7/8] end-to-end LLM reply"
if [[ -n "$SESSION" && -n "$TOKEN" ]]; then
  curl -s -X POST "$API_URL/v1/sessions/$SESSION/messages" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"content":"say hi in exactly 3 words","systemHint":"Reply in exactly 3 lowercase words.","noTools":true}' \
    --max-time 5 > /dev/null
  # Poll for the assistant message
  REPLY=""
  for i in {1..20}; do
    sleep 1
    REPLY=$(curl -s "$API_URL/v1/sessions/$SESSION" -H "Authorization: Bearer $TOKEN" --max-time 3 \
      | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    msgs = d.get('messages', [])
    last = msgs[-1] if msgs else {}
    if last.get('role') == 'assistant':
        print(last.get('content','')[:100])
except: pass" 2>/dev/null)
    [[ -n "$REPLY" ]] && break
  done
  if [[ -n "$REPLY" ]]; then
    pass "got reply: \"$REPLY\""
  else
    fail "e2e-reply" "no assistant message after 20s — LLM provider or noTools fix may be broken"
  fi
fi

# ---- 8. email mirror ---------------------------------------------------
log "[8/8] email mirror (skip with --skip-email)"
if [[ $SKIP_EMAIL -eq 0 && -n "$TOKEN" ]]; then
  OWNER_EMAIL="${LANTERN_OWNER_EMAIL:-}"
  if [[ -z "$OWNER_EMAIL" ]]; then
    log "  (skipped — LANTERN_OWNER_EMAIL not set)"
  else
    code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
      "$API_URL/v1/connectors/gmail/execute?action=send_message" \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d "{\"to\":\"$OWNER_EMAIL\",\"subject\":\"Lantern regression $(date +%H%M)\",\"body\":\"Test from scripts/regression.sh\",\"label\":\"lantern\",\"skipInbox\":true}" --max-time 10)
    [[ "$code" == "200" ]] && pass "email sent" || fail "email" "HTTP $code"
  fi
else
  log "  (skipped)"
fi

# ---- summary ------------------------------------------------------------
echo ""
echo "──────────────────────────────────────────"
echo "  Regression: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  echo "  Failures:"
  for d in "${FAIL_DETAILS[@]}"; do echo "    • $d"; done
  exit 1
fi
echo "  All green."
exit 0
