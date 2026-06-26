# Remote access to the personal harness (Tailscale Serve)

Stable, **private** access to the Lantern harness from your phone — the control-plane
API **and** the dashboard, on one HTTPS host, over your Tailscale network. Nothing is
exposed to the public internet, and the URL never changes (survives reboots).

This replaced an ephemeral `cloudflared` quick-tunnel (random URL each restart, and it
exposed the API publicly). If that's still around, disable it:

```bash
launchctl bootout gui/$(id -u)/dev.lantern.tunnel
launchctl bootout gui/$(id -u)/dev.lantern.tunnel-watcher
launchctl disable gui/$(id -u)/dev.lantern.tunnel
```

## How it routes

One tailnet HTTPS host fronts both services, **same-origin** (so no CORS, and the
dashboard's HttpOnly JWT cookie works):

```
https://<your-mac>.<tailnet>.ts.net
 ├─ /              → dashboard   (127.0.0.1:3001)
 ├─ /v1/*          → API         (127.0.0.1:8080/v1)      ← iPhone signals, widget, dashboard data
 ├─ /auth/*        → API         (127.0.0.1:8080/auth)    ← login
 └─ /.well-known/* → API         (receipts discovery)
```

The `--set-path` flag **strips** its prefix, so the target URL must repeat the path
(`/v1` → `http://127.0.0.1:8080/v1`) to round-trip correctly. Getting this wrong yields
`404`s on every `/v1/*` call.

## Prerequisites (one-time)

1. **Tailscale on the Mac.** The Mac App Store build works for **Serve** (tailnet-only,
   what we use here) but its CLI **cannot do Funnel** (public). For Funnel, use the
   standalone build from tailscale.com. Sign in.
2. **Tailscale on the iPhone**, signed into the **same tailnet** — that's what lets the
   phone reach the Mac privately.
3. **Enable Serve** for the tailnet once (first `serve` command prints the enable link,
   e.g. `https://login.tailscale.com/f/serve?node=...`).

## Set it up

Run the helper (idempotent):

```bash
scripts/iphone/tailscale-serve.sh
```

It runs `tailscale serve reset` then the four path-preserving mounts and prints the
final config. Re-run it any time the routing looks wrong.

## Required env

| Var | Where | Why |
|-----|-------|-----|
| `LANTERN_SIGNAL_TOKEN` | **API** (`dev.lantern.api.plist`) **and** dashboard | Gates `POST /v1/signals`; the iOS Shortcut sends it as `x-lantern-signal-token`. Pick any long random string. |
| `NEXT_PUBLIC_API_URL` | **dashboard** (`dev.lantern.dashboard.plist`) | Set to `https://<your-mac>.<tailnet>.ts.net` so the dashboard's *client-side* API calls resolve to the tailnet host instead of `localhost:8080` (which a phone can't reach). |

Set plist env via `PlistBuddy` then reload with `launchctl bootout … && bootstrap …`
(a plain `kickstart -k` does **not** reload env). Keep the token **out of git**.

## On the iPhone

- **Dashboard / Automations page:** open `https://<your-mac>.<tailnet>.ts.net/automations`
  in Safari → log in → **Share → Add to Home Screen**.
- **App-context Shortcuts:** POST to `https://<your-mac>.<tailnet>.ts.net/v1/signals`
  with header `x-lantern-signal-token`. See `scripts/iphone/app-context/README.md`.
- **Home-screen widget:** set `API_BASE = https://<your-mac>.<tailnet>.ts.net`. See
  `scripts/iphone/README.md`.

## Want a public URL instead?

Use Tailscale **Funnel** (needs the standalone Mac build + Funnel enabled): replace the
`serve` mounts with `funnel` ones. It's publicly reachable (token still gates `/v1/signals`),
but the private Serve route above is preferred for personal data.
