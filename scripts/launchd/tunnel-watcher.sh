#!/bin/bash
# tunnel-watcher — keep Twilio webhooks + LANTERN_PUBLIC_BASE_URL in
# sync with the current Cloudflare Tunnel URL.
#
# The quick-tunnel mode of cloudflared (`tunnel --url http://...`)
# assigns a RANDOM *.trycloudflare.com hostname each time it starts.
# Twilio's phone-number webhooks point at a specific URL — if the
# tunnel URL changes, inbound SMS/voice break silently until we
# re-point them. This script polls the cloudflared stderr log every
# 15 seconds, detects the current URL, and re-points everything when
# it changes.
#
# Wired in as a LaunchAgent via dev.lantern.tunnel-watcher.plist.
# Logs to ~/Library/Logs/Lantern/tunnel-watcher.{out,err}.log.
#
# Exits non-zero on irrecoverable errors so launchd restarts it.

set -u

CFLOG=~/Library/Logs/Lantern/cloudflared.err.log
SECONDARY_LOG=~/Library/Logs/Lantern/cloudflared.log  # legacy nohup path
STATE_FILE=~/.lantern/tunnel-current-url
API_PLIST=~/Library/LaunchAgents/dev.lantern.api.plist
TWILIO_NUMBER_ENV="+15128819998"

mkdir -p "$(dirname "$STATE_FILE")"
mkdir -p ~/Library/Logs/Lantern

log() {
  echo "[$(date '+%Y-%m-%dT%H:%M:%S')] $*"
}

# Pull the current tunnel URL from either the launchd-rotated err log
# or the legacy nohup log.
detect_url() {
  local url=""
  for f in "$CFLOG" "$SECONDARY_LOG"; do
    [ -r "$f" ] || continue
    # Grab the LAST URL printed — most recent tunnel session wins.
    url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$f" 2>/dev/null | tail -1)
    [ -n "$url" ] && break
  done
  echo "$url"
}

# Fetch Twilio creds from the installed connector via the local API.
fetch_twilio_creds() {
  local jwt sid auth pn
  jwt=$(curl -s -m 5 -X POST http://127.0.0.1:8080/auth/login \
    -H 'content-type: application/json' \
    -d '{"email":"admin@lantern.dev","password":"lantern"}' \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
  [ -z "$jwt" ] && return 1
  local resp
  resp=$(curl -s -m 5 -H "Authorization: Bearer $jwt" http://127.0.0.1:8080/v1/connectors)
  echo "$resp" | python3 -c "
import sys, json
d = json.load(sys.stdin) or []
tw = next((c for c in d if c.get('connectorId')=='twilio'), None)
if tw:
  cfg = tw.get('config', {})
  print(f\"{cfg.get('accountSid','')}|{cfg.get('authToken','')}|{cfg.get('phoneNumber','')}\")
" 2>/dev/null
}

# Update the Twilio phone-number webhook URLs.
update_twilio() {
  local new_url="$1"
  local creds sid auth phone pn_sid sms_url voice_url
  creds=$(fetch_twilio_creds)
  [ -z "$creds" ] && { log "ERROR: couldn't fetch Twilio creds"; return 1; }
  sid=$(echo "$creds" | cut -d'|' -f1)
  auth=$(echo "$creds" | cut -d'|' -f2)
  phone=$(echo "$creds" | cut -d'|' -f3)
  [ -z "$sid" ] || [ -z "$auth" ] || [ -z "$phone" ] && {
    log "ERROR: incomplete Twilio creds"; return 1; }

  pn_sid=$(curl -s -u "$sid:$auth" \
    "https://api.twilio.com/2010-04-01/Accounts/$sid/IncomingPhoneNumbers.json?PhoneNumber=$phone" \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
nums = d.get('incoming_phone_numbers', [])
if nums: print(nums[0]['sid'])
" 2>/dev/null)
  [ -z "$pn_sid" ] && { log "ERROR: couldn't find phone number resource"; return 1; }

  sms_url="$new_url/v1/sms/twilio/webhook"
  voice_url="$new_url/v1/voice/twilio/webhook"
  curl -s -u "$sid:$auth" -X POST \
    "https://api.twilio.com/2010-04-01/Accounts/$sid/IncomingPhoneNumbers/$pn_sid.json" \
    --data-urlencode "SmsUrl=$sms_url" \
    --data-urlencode "SmsMethod=POST" \
    --data-urlencode "VoiceUrl=$voice_url" \
    --data-urlencode "VoiceMethod=POST" >/dev/null
  log "✅ Twilio webhooks repointed to $new_url"
}

# Update LANTERN_PUBLIC_BASE_URL in the API plist + reload the API
# so signature verification works against the new URL.
update_api_plist() {
  local new_url="$1"
  /usr/libexec/PlistBuddy -c \
    "Set :EnvironmentVariables:LANTERN_PUBLIC_BASE_URL $new_url" \
    "$API_PLIST" 2>/dev/null || \
    /usr/libexec/PlistBuddy -c \
      "Add :EnvironmentVariables:LANTERN_PUBLIC_BASE_URL string $new_url" \
      "$API_PLIST" 2>/dev/null
  # Reload the API so the new env var is picked up.
  local uid
  uid=$(id -u)
  launchctl unload "$API_PLIST" 2>/dev/null || true
  sleep 1
  launchctl load "$API_PLIST" 2>/dev/null || true
  launchctl kickstart "gui/$uid/dev.lantern.api" 2>/dev/null || true
  log "✅ API plist LANTERN_PUBLIC_BASE_URL set; control-plane reloaded"
}

last_url=""
[ -r "$STATE_FILE" ] && last_url=$(cat "$STATE_FILE")
log "watcher starting, last_url=${last_url:-<none>}"

while true; do
  current=$(detect_url)
  if [ -n "$current" ] && [ "$current" != "$last_url" ]; then
    # Wait a moment for DNS propagation before re-pointing Twilio.
    sleep 5
    log "tunnel URL changed: $last_url → $current"
    update_twilio "$current" && update_api_plist "$current"
    echo "$current" > "$STATE_FILE"
    last_url="$current"
  fi
  sleep 15
done
