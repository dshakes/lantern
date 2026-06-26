# Rich iPhone Signals — iOS Shortcuts Automation Recipes

Go beyond app-opens. Teach your Lantern bot **where you are, what Focus you're
in, what your phone is plugged into, your health for the day, and what you're
listening to** — so when you ask it "where am I", "how many steps today", "am I
still in Work focus", or "what am I listening to", it actually knows.

Every recipe below POSTs one JSON line to the **same** endpoint your app-open
automations already use. The bridge tails those lines, keeps the **latest** of
each category from the last ~2 hours, and composes one owner-only sentence like:

> On iPhone (last 2h): YouTube, LinkedIn — at Home, Work focus, charging, 6.2k
> steps, playing Hardcore History.

**This is owner-only and local.** Signals live in `~/.lantern/device-signals.jsonl`
(mode `0600`, your user only). The bot never reveals them to a contact — it only
grounds replies to **you** in your own self-chat.

> New here? Read `README.md` first — it walks through the one-time tunnel host +
> token setup and the reusable "Post Signal" shortcut. This file assumes you have
> that and just gives you the per-category recipes.

---

## The shared contract (what to POST)

`POST https://<your-tailscale-host>/v1/signals`

**Headers** (every request):

| Header                   | Value                |
| ------------------------ | -------------------- |
| `x-lantern-signal-token` | `<your-token>`       |
| `Content-Type`           | `application/json`   |

In Shortcuts, the **Get Contents of URL** action needs **Method = POST**, both
headers above, and a **Request Body = JSON** with the fields shown per recipe.
`ts` is optional — leave it out and the server stamps receive-time.

**Body shapes** (the bridge understands exactly these):

| `kind`        | Other fields                          | Example body                                                  |
| ------------- | ------------------------------------- | ------------------------------------------------------------- |
| `app_open`    | `app`                                 | `{ "kind": "app_open", "app": "YouTube" }`                    |
| `location`    | `detail`                              | `{ "kind": "location", "detail": "Home" }`                    |
| `focus`       | `detail`                              | `{ "kind": "focus", "detail": "Work" }`                       |
| `device`      | `detail`                              | `{ "kind": "device", "detail": "CarPlay" }`                   |
| `health`      | `metric` (+ `value`) **or** `detail`  | `{ "kind": "health", "metric": "steps", "value": 6200 }`      |
| `now_playing` | `detail`                              | `{ "kind": "now_playing", "detail": "Song - Artist" }`        |
| `wake`        | —                                     | `{ "kind": "wake" }`                                          |
| `sleep`       | —                                     | `{ "kind": "sleep" }`                                         |
| `screenshot`  | —                                     | `{ "kind": "screenshot" }`                                    |

How each renders in the summary:

- **location** → `at <place>` (latest wins)
- **focus** → `<mode> focus` (skipped when `detail` is `"off"`)
- **device** → `CarPlay` → **driving**; `charging` / `AirPods` / `Office WiFi` pass through (latest meaningful state)
- **health** → `metric:"steps"` → `6.2k steps`; `metric:"sleep"` → `slept 6.5h`; `metric:"workout"` or detail-only → `ran 3mi`
- **now_playing** → `playing <detail>`

---

## 1 — LOCATION (arrive / leave geofences)

iOS has native **Arrive** and **Leave** triggers tied to a place. One automation
per place per direction.

### Arrive Home

1. **Shortcuts** → **Automation** → **+** → **Create Personal Automation**.
2. **Arrive** → **Choose** → pick **Home** (or any address) → **Next**.
3. **Add Action** → **Get Contents of URL** (or **Run Shortcut → Post Signal**).
4. Method **POST**, both headers, **Request Body = JSON**:
   ```json
   { "kind": "location", "detail": "Home" }
   ```
5. **Next** → turn **OFF** "Ask Before Running" (newer iOS: **Run Immediately**) → **Done**.

### Arrive Office / Gym

Same as above; **Arrive → Choose** the address, change the body's `detail`:

```json
{ "kind": "location", "detail": "Office" }
```
```json
{ "kind": "location", "detail": "Gym" }
```

### Leave (optional)

To clear "at X" when you go, add a **Leave** automation for the same place. You
can POST your next place when you get there, or post a neutral location:

```json
{ "kind": "location", "detail": "out and about" }
```

### Bonus — attach live location to app-opens

In your **app-open** automations, before the POST add a **Get Current Location**
action, then a **Get [Name] from [Current Location]** (Shortcuts can extract the
place name), and feed that into a second POST:

```json
{ "kind": "location", "detail": "<the location name variable>" }
```

This way every app-open also refreshes "where you are" without dedicated
geofences.

---

## 2 — FOCUS & DEVICE STATE

### Focus turns On (Work / Personal / Sleep / …)

1. **Create Personal Automation** → **Focus** → choose the mode (e.g. **Work**)
   → **Is Turned On** → **Next**.
2. POST, **Request Body = JSON**:
   ```json
   { "kind": "focus", "detail": "Work" }
   ```
3. **Run Immediately** → **Done**. Repeat per Focus mode (Personal, Sleep, …).

> To clear it when a Focus turns **off**, add an **Is Turned Off** automation
> that posts `{ "kind": "focus", "detail": "off" }` — the bridge treats `"off"`
> as "no focus" and drops it from the summary.

### CarPlay connects → driving

1. **Create Personal Automation** → **CarPlay** → **Connects** → **Next**.
2. POST:
   ```json
   { "kind": "device", "detail": "CarPlay" }
   ```
   (The bridge renders this as **driving**.)
3. **Run Immediately** → **Done**.

### Connected to a Wi-Fi network (e.g. office)

1. **Create Personal Automation** → **Wi-Fi** → **Choose** your office network →
   **Next**.
2. POST:
   ```json
   { "kind": "device", "detail": "Office WiFi" }
   ```
3. **Run Immediately** → **Done**.

### Charger connects

1. **Create Personal Automation** → **Charger** → **Is Connected** → **Next**.
2. POST:
   ```json
   { "kind": "device", "detail": "charging" }
   ```
3. **Run Immediately** → **Done**.

### Bluetooth / AirPods connect

1. **Create Personal Automation** → **Bluetooth** → **Is Connected** → **Next**
   (or use the **AirPods** trigger if your iOS version exposes it).
2. POST:
   ```json
   { "kind": "device", "detail": "AirPods" }
   ```
3. **Run Immediately** → **Done**.

> Only the **latest meaningful** device state shows in the summary, so these
> don't pile up — connecting AirPods after CarPlay just updates the state.

---

## 3 — HEALTH (steps / sleep / workout)

Health needs a **Get Health Sample** action, so these run as a time-of-day
automation (or a tap-to-run shortcut), not an event trigger.

### Daily steps (e.g. 9 PM)

1. **Create Personal Automation** → **Time of Day** → **9:00 PM** → **Daily** →
   **Next**.
2. **Add Action** → **Find Health Samples** (a.k.a. **Get Health Sample**):
   - **Sample type**: **Steps**
   - **Filter**: today (set **Start Date = Start of Today**, or use the
     "Today" range), **Sort by** Date, **Limit** off — then add a
     **Calculate Statistics → Sum** over the samples to get one number.
3. Add **Get Contents of URL**, Method **POST**, headers, **Request Body = JSON**:
   ```json
   { "kind": "health", "metric": "steps", "value": <the summed steps variable> }
   ```
   Tap the `value` field and insert the **Statistics / sum** variable (a number,
   not text). `6200` renders as `6.2k steps`.
4. **Run Immediately** → **Done**.

### Sleep (e.g. 8 AM, last night)

1. **Time of Day** → **8:00 AM** → **Daily**.
2. **Find Health Samples** → **Sleep** (Sleep Analysis) → today / last night →
   **Calculate Statistics → Sum** of the asleep duration → convert to **hours**
   (divide minutes by 60, or use a duration component).
3. POST:
   ```json
   { "kind": "health", "metric": "sleep", "value": <hours, e.g. 6.5> }
   ```
   Renders as `slept 6.5h`.
4. **Run Immediately** → **Done**.

### Workout complete

Use the **Apple Watch / Fitness** "**When a workout ends**" automation if your
iOS exposes it, otherwise a tap-to-run shortcut after exercising.

1. Trigger: workout ends (or run manually).
2. Optionally **Find Health Samples → Workouts** to read the type + distance,
   and build a short `detail` like `"ran 3mi"`.
3. POST either form:
   ```json
   { "kind": "health", "metric": "workout", "detail": "ran 3mi" }
   ```
   or detail-only (the bridge accepts both):
   ```json
   { "kind": "health", "detail": "ran 3mi" }
   ```
   Renders as `ran 3mi`. A bare `{ "kind": "health", "metric": "workout" }`
   with no detail renders as `worked out`.

---

## 4 — MEDIA & RHYTHM

### Now playing

The simplest version posts from a tap-to-run shortcut or a "when [music app]
opens" automation.

1. **Add Action** → **Get Current Song** (Music) — gives you the title + artist.
2. Build a `detail` like `"<Title> - <Artist>"`.
3. POST:
   ```json
   { "kind": "now_playing", "detail": "Hardcore History - Dan Carlin" }
   ```
   Renders as `playing Hardcore History - Dan Carlin`.

> For Spotify/podcasts, add a "When Spotify is opened" automation and use
> whatever now-playing variable that app exposes, or hard-code a generic
> `detail` if you can't read the track.

### Wake (alarm stops / first unlock)

1. **Create Personal Automation** → **Alarm** → **Is Stopped** (your morning
   alarm), **or** **Sleep Focus → Is Turned Off**.
2. POST (no body fields needed):
   ```json
   { "kind": "wake" }
   ```
3. **Run Immediately** → **Done**.

### Sleep (sleep focus on / bedtime)

1. **Create Personal Automation** → **Sleep Focus** → **Is Turned On** (or
   **Time of Day** at your bedtime).
2. POST:
   ```json
   { "kind": "sleep" }
   ```
3. **Run Immediately** → **Done**.

### Screenshot

1. **Create Personal Automation** → **Screenshot** → **Is Taken** → **Next**.
2. POST:
   ```json
   { "kind": "screenshot" }
   ```
3. **Run Immediately** → **Done**.

---

## Putting it together

You don't need all of these. A high-signal starter set:

- **location**: Arrive Home, Arrive Office, Arrive Gym.
- **focus**: Work On/Off, Sleep On.
- **device**: CarPlay connects, Charger connects.
- **health**: 9 PM steps, 8 AM sleep.
- **now_playing**: when your music/podcast app opens.

With those wired, a normal evening produces something like:

> On iPhone (last 2h): YouTube, LinkedIn — at Home, Work focus, charging, 6.2k
> steps, playing Hardcore History.

…which the bot keeps **only in your own self-chat context**, ready for when you
ask.

---

## Verify it's flowing

After a few automations fire, from your Mac (replace host + token):

```bash
curl -s -H "x-lantern-signal-token: <your-token>" \
  "https://<your-tailscale-host>/v1/signals?limit=20"
```

You should see your recent `location` / `focus` / `device` / `health` /
`now_playing` lines. Or open `~/.lantern/device-signals.jsonl` directly — one
JSON object per line. Then ask the bot in self-chat: "where am I / how many steps
today / what am I listening to" — within ~10 minutes (the bridge polls every 10
min) it'll have the composite line in context.

## Privacy recap

- Signals are stored **only** on your Mac in `~/.lantern/device-signals.jsonl`
  (mode `0600`). Auto-trimmed to the most recent lines.
- The composite summary is injected **only** into your own self-chat context.
  The bot never volunteers it and never reveals it to a contact.
- The token gates the endpoint; keep it secret (server-side only, never shipped
  to a browser).
- Turn the feature off any time: `LANTERN_IPHONE_SIGNALS=off` on the bridge, or
  unset `LANTERN_SIGNAL_TOKEN` on the receiver (which makes it reject every
  request).
