# iPhone App-Context Signals — Setup

Feed "what I'm using on my iPhone" into your Lantern bot. When you open an app
(Instagram, Slack, Maps…), arrive somewhere, or switch a Focus mode, your phone
quietly POSTs a one-line signal to your Mac. The bridge tails those signals,
summarizes them ("On iPhone (last 2h): Instagram, Slack, Maps — mostly
Instagram."), and injects the summary into **your own self-chat** assistant
context — so when you ask the bot "what have I been on" or "am I doomscrolling",
it actually knows.

**This is owner-only and local.** The signals live in a file on your Mac
(`~/.lantern/device-signals.jsonl`, owner-readable only). The bot never reveals
them to anyone but you. The only time a signal leaves your phone is the single
HTTPS POST that delivers it over the same Cloudflare tunnel that already serves
your dashboard.

---

## What you need (one-time)

1. **The tunnel host** — the same `https://…` URL you already use to open your
   Lantern dashboard from your phone. Example: `https://lantern.example.com`.
   Everything below posts to `<that host>/api/signals`.

2. **The signal token** — a shared secret. Pick any long random string (e.g.
   run `openssl rand -hex 24` in Terminal), then set it in **two** places so
   they match:

   - **Dashboard** (`apps/web` env, e.g. `.env.local`):
     ```
     LANTERN_SIGNAL_TOKEN=<your-token>
     ```
     This is server-side only — do NOT prefix it with `NEXT_PUBLIC_`. If this is
     unset, the endpoint rejects everything (fails closed).

   - **Bridge process** (the imessage-bridge env) — only needed if you also want
     a kill switch; the bridge just reads the local file, so the token isn't
     required for it to work. Set `LANTERN_IPHONE_SIGNALS=off` there to disable
     the feature entirely.

3. The **Shortcuts** app (built into iOS).

---

## Step 1 — Make one reusable "Post Signal" shortcut

You'll build this once, then call it from every app automation.

1. Open **Shortcuts** → **Shortcuts** tab → **+** (new shortcut).
2. Name it **Post Signal**.
3. Tap **Add Action** → search **Get Contents of URL** → add it.
4. Configure **Get Contents of URL**:
   - **URL**: `https://<your-tunnel-host>/api/signals`
   - Tap **Show More**.
   - **Method**: `POST`
   - **Headers** → **Add new header**:
     - Key: `x-lantern-signal-token`
     - Value: `<your-token>` (the same secret from above)
     - Add a second header — Key: `Content-Type`, Value: `application/json`
   - **Request Body**: `JSON`, with these fields:
     - `app` (Text) — leave this as a **Shortcut Input** placeholder, or set per
       automation (see Step 2). Easiest: add a **Text** field named `app` and
       fill it in each app automation.
     - `kind` (Text) — `app_open`

That's the engine. Each app automation will run this shortcut.

> Prefer it dead simple? Skip the reusable shortcut and put the **Get Contents
> of URL** action directly inside each app automation (Step 2), hard-coding the
> `app` name in the JSON body. More copy-paste, but no parameters to wire.

---

## Step 2 — One automation per app you care about

Repeat this for each app you want the bot to know about. It's **per-app** —
iOS doesn't give a single "any app opened" trigger.

1. **Shortcuts** → **Automation** tab → **+** → **Create Personal Automation**.
2. Scroll to **App** → **Choose** → pick the app (e.g. **Instagram**) → **Is
   Opened** → **Next**.
3. **Add Action** → **Get Contents of URL** (or **Run Shortcut → Post Signal**).
4. Set the POST exactly as in Step 1, with the body:
   ```json
   { "app": "Instagram", "kind": "app_open" }
   ```
   (Change `"Instagram"` to match the app.)
5. **Next**, then turn **OFF** "Ask Before Running" → confirm **Don't Ask**, so
   it fires silently. (On newer iOS this toggle is **Run Immediately**.)
6. **Done**.

**Recommended starter list** (pick what's actually telling for you):
Instagram, Slack, WhatsApp, Messages, Mail, Maps, Spotify, Safari/Chrome,
Calendar, Uber/Lyft, Amazon, YouTube, ChatGPT.

The body is the same shape every time — just change the `"app"` value.

---

## Step 3 (optional) — Location and Focus signals

Same `/api/signals` endpoint, different `kind`. These add a trailing note to the
summary ("…— at Home", "…— Work focus on").

**Arrive home / leave home**
1. **Create Personal Automation** → **Arrive** → choose **Home** → **Next**.
2. POST body:
   ```json
   { "app": "Home", "kind": "location", "detail": "Home" }
   ```
3. Run Immediately → Done. (Repeat with **Leave** / other places as you like.)

**Focus change** (Work / Personal / Sleep / Do Not Disturb)
1. **Create Personal Automation** → **Focus** → choose a mode → **Is Turned On**.
2. POST body:
   ```json
   { "app": "Work", "kind": "focus", "detail": "Work" }
   ```
3. Run Immediately → Done.

**Now-playing** (optional, niche): post `{ "kind": "now_playing", "app":
"Spotify", "detail": "<track>" }` from a "When Spotify opened" automation if you
want the bot to know what you're listening to.

---

## Step 4 — Verify it's flowing

After a few app opens, check the last signals from your Mac (replace the host
and token):

```bash
curl -s -H "x-lantern-signal-token: <your-token>" \
  "https://<your-tunnel-host>/api/signals?limit=10"
```

You should see a JSON `{ "signals": [ … ] }` array of your recent events. You
can also just open `~/.lantern/device-signals.jsonl` on the Mac — one JSON
object per line.

Then, in your self-chat, ask the bot something like "what have I been on my
phone today?" — within ~10 minutes of new signals (the bridge polls every 10
min) it'll have the summary in context.

---

## Body reference

`POST /api/signals` — header `x-lantern-signal-token: <token>`, JSON body:

| Field    | Required | Notes                                                        |
| -------- | -------- | ------------------------------------------------------------ |
| `app`    | yes      | App / place / focus-mode name, e.g. `"Instagram"`, `"Home"`. |
| `kind`   | no       | `app_open` (default) · `location` · `focus` · `now_playing` · `custom`. |
| `detail` | no       | Free text — focus mode name, place, track title, etc.        |
| `ts`     | no       | Unix epoch **ms**. Defaults to server receive time.          |

Returns `{ "ok": true }`. A missing/wrong token returns **401**. A missing `app`
returns **400**.

---

## Privacy recap

- Signals are stored **only** on your Mac in `~/.lantern/device-signals.jsonl`
  (mode `0600` — your user only). The file is auto-trimmed to the most recent
  few thousand lines.
- The summary is injected **only** into your own self-chat assistant context.
  The bot is instructed to never volunteer it and never reveal it to a contact.
- The token gates the endpoint; keep it secret. It's server-side only and never
  shipped to a browser.
- Turn the whole feature off any time by setting `LANTERN_IPHONE_SIGNALS=off` on
  the bridge, or by unsetting `LANTERN_SIGNAL_TOKEN` on the dashboard (which
  makes the endpoint reject every request).
