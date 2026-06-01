#!/usr/bin/env bash
# A2P 10DLC approval watcher.
#
# Polls Twilio for the US A2P campaign status of the owner's messaging
# service. When it flips to APPROVED/VERIFIED, pings the owner's WhatsApp
# self-chat (via the bridge) ONCE — a sentinel file prevents re-notifying.
# Twilio creds are read from the connector DB so no token is hardcoded.
#
# Driven by launchd StartInterval (one check per invocation).
set -euo pipefail

SENTINEL="$HOME/.lantern/a2p-approved"
[ -f "$SENTINEL" ] && exit 0   # already notified

DBURL="postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable"
creds=$(PGPASSWORD=lantern psql "$DBURL" -tA -c \
  "SELECT config FROM connector_installs WHERE connector_id='twilio' LIMIT 1" 2>/dev/null || true)
[ -z "$creds" ] && exit 0
export TW_CONFIG="$creds"

python3 - <<'PY'
import os, json, base64, urllib.request

cfg = json.loads(os.environ["TW_CONFIG"])
sid, tok = cfg.get("accountSid", ""), cfg.get("authToken", "")
if not sid or not tok:
    raise SystemExit
auth = "Basic " + base64.b64encode(f"{sid}:{tok}".encode()).decode()

def get(url):
    return json.load(urllib.request.urlopen(
        urllib.request.Request(url, headers={"Authorization": auth}), timeout=20))

approved = False
try:
    for s in get("https://messaging.twilio.com/v1/Services?PageSize=20").get("services", []):
        try:
            c = get(f"https://messaging.twilio.com/v1/Services/{s['sid']}/Compliance/Usa2p")
            if (c.get("campaign_status") or "").upper() in ("APPROVED", "VERIFIED"):
                approved = True
                break
        except Exception:
            pass
except Exception:
    raise SystemExit

if not approved:
    print("a2p: not yet approved")
    raise SystemExit

# Auto-switch: flip the brief channel to SMS via the runtime override file
# the control-plane reads at send time — no restart needed.
lantern = os.path.expanduser("~/.lantern")
os.makedirs(lantern, exist_ok=True)
switched = False
try:
    with open(os.path.join(lantern, "brief-channel"), "w") as f:
        f.write("sms")
    switched = True
except Exception as e:
    print("a2p: channel flip failed:", e)

if switched:
    msg = ("✅ Twilio A2P 10DLC approved — I switched your briefs to TEXT. "
           "From now on your daily brief comes by SMS (+15128819998 → your phone).")
else:
    msg = ("✅ Twilio A2P 10DLC approved — your number can send SMS now. "
           "Say \"switch briefs to text\" to flip it.")
try:
    urllib.request.urlopen(urllib.request.Request(
        "http://localhost:3100/session/00000000-0000-0000-0000-000000000001/send-self",
        data=json.dumps({"message": msg}).encode(),
        headers={"Content-Type": "application/json"}, method="POST"), timeout=15)
    print("a2p: APPROVED — switched to SMS + pinged WhatsApp")
except Exception as e:
    print("a2p: APPROVED, channel switched, but WhatsApp ping failed:", e)

open(os.path.join(lantern, "a2p-approved"), "w").close()
PY
