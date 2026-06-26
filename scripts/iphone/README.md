# Lantern Automations Widget — iPhone Setup

A Scriptable home-screen widget that shows your life-event automations feed
(bills, deliveries, appointments, fraud alerts, OTPs, travel, receipts,
promos) in real time from the Lantern control-plane API.

Supports **small**, **medium**, and **large** widget families. Urgent events
(fraud alerts, high-urgency) are tinted red. Tapping the widget opens the
Automations dashboard in Safari.

---

## Prerequisites

- iPhone with iOS 14 or later
- **Scriptable** — free on the App Store:
  https://apps.apple.com/app/scriptable/id1405459188
- Lantern control-plane running and reachable from your iPhone

---

## Step 1 — Get the API base URL

You need a URL your iPhone can reach.

**Option A — same Wi-Fi (simplest)**
Use the LAN IP of the Mac running the control-plane:
```
http://10.0.0.185:8080
```
Replace `10.0.0.185` with your Mac's actual local IP (`System Preferences →
Network` or `ifconfig en0`). This only works when both devices are on the
same network.

**Option B — tunnel (works from anywhere)**
If you run `lantern dev` or a reverse tunnel (ngrok, Cloudflare Tunnel, etc.),
use the tunnel's public HTTPS URL:
```
https://macbook-pro-2.tail0be192.ts.net
```
The tunnel must forward to port `8080` (the control-plane REST port).

---

## Step 2 — Create an API key

1. Open the Lantern dashboard in a browser (`http://<LAN-IP>:3001` or your
   tunnel URL on port 3001).
2. Go to **Settings → API Keys**.
3. Click **Create API Key**, give it a name like `iPhone widget`, and choose
   scope **read** (the widget only reads data).
4. Copy the key — it starts with `hlx_live_`. You will not see it again after
   closing the dialog.

---

## Step 3 — Add the script to Scriptable

1. Open **Scriptable** on your iPhone.
2. Tap **+** (top right) to create a new script.
3. Paste the entire contents of `lantern-automations-widget.js` into the editor.
4. At the top of the script, edit the two config lines:

```js
const API_BASE = "http://10.0.0.185:8080";  // ← your URL from Step 1
const API_KEY  = "hlx_live_PASTE_YOUR_KEY"; // ← your key from Step 2
```

5. Tap the **play button** (▶) to run the script once and confirm it shows
   your events (or the "can't reach" error message if the URL is wrong).
6. Tap anywhere outside the editor to name the script — e.g. `Lantern`.

---

## Step 4 — Add the widget to your home screen

1. Long-press an empty area of your home screen to enter jiggle mode.
2. Tap **+** (top left) → search for **Scriptable**.
3. Choose a widget size (Small / Medium / Large) — Medium is recommended.
4. Tap **Add Widget**, then long-press the new widget → **Edit Widget**.
5. Under **Script**, choose `Lantern` (the script you just added).
6. Leave **When Interacting** as **Open App** (the widget URL overrides this
   and opens Safari to the Automations dashboard).
7. Tap outside to finish.

---

## Refresh cadence

Scriptable widgets are refreshed by iOS on a best-effort schedule — typically
every 15–30 minutes in the background. The script requests a refresh hint of
15 minutes (`widget.refreshAfterDate`). iOS may throttle this to 30–60 min
to save battery; this is normal and not configurable from a widget script.

To see data right now, tap the widget to open the dashboard, or open
Scriptable and run the script manually.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "⚠︎ Set API_BASE and API_KEY" | You haven't replaced the placeholder values in the config block. |
| "⚠︎ Can't reach Lantern" | iPhone can't reach the URL. Check Wi-Fi / tunnel. Try the URL in Safari on the phone first. |
| Widget shows but events are empty | The control-plane is up but has no life events yet. The bridge needs to POST some classified events. |
| "unauthorized" errors in Scriptable logs | API key is wrong, or was revoked. Regenerate in the dashboard. |
| Widget never refreshes | iOS power-saving is throttling it. Open Scriptable and run the script manually to force an update. |
