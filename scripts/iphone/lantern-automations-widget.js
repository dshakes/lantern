// ─────────────────────────────────────────────────────────────────────────────
// Lantern · Automations Widget  (Scriptable for iOS)
// ─────────────────────────────────────────────────────────────────────────────
// Paste this file into Scriptable, set API_BASE and API_KEY below, then add
// a Scriptable widget to your home screen and choose this script.
//
// Live API:
//   GET {API_BASE}/v1/life-events?limit=8
//   Authorization: Bearer hlx_live_<your-key>
//
// Response: JSON array of life-event objects (newest first):
//   [ { id, kind, channel, status, urgency, summary, fields,
//       idempotencyKey, actionTaken, sourcePreview, createdAt, updatedAt }, … ]
// ─────────────────────────────────────────────────────────────────────────────

// ┌─────────────────────────────────────────────────────────────────────────┐
// │  CONFIG — edit these two lines, nothing else                            │
// └─────────────────────────────────────────────────────────────────────────┘
const API_BASE = "https://macbook-pro-2.tail0be192.ts.net"; // e.g. https://abc.ngrok.io or http://10.0.0.185:8080
const API_KEY  = "hlx_live_PASTE_YOUR_KEY_HERE";       // created in dashboard → Settings → API Keys

// ─────────────────────────────────────────────────────────────────────────────
// Widget family → row counts
// ─────────────────────────────────────────────────────────────────────────────
const FAMILY_ROWS = { small: 3, medium: 5, large: 9 };

// How many items to fetch (slightly more than max displayed so we have slack
// after status filtering, but stay well under the 200-item server cap).
const FETCH_LIMIT = 12;

// Dashboard URL opened on widget tap.
const DASHBOARD_URL = API_BASE.replace(":8080", ":3001") + "/surfaces";

// ─────────────────────────────────────────────────────────────────────────────
// Kind → SF Symbol name + display label
// ─────────────────────────────────────────────────────────────────────────────
const KIND_META = {
  bill:        { sf: "doc.text.fill",          label: "Bill" },
  delivery:    { sf: "shippingbox.fill",        label: "Delivery" },
  appointment: { sf: "calendar",               label: "Appointment" },
  fraud_alert: { sf: "exclamationmark.shield.fill", label: "Fraud" },
  otp:         { sf: "lock.shield.fill",        label: "OTP" },
  travel:      { sf: "airplane",               label: "Travel" },
  receipt:     { sf: "receipt.fill",           label: "Receipt" },
  promo:       { sf: "tag.fill",               label: "Promo" },
};

// Urgency values that should be tinted warning-amber.
const URGENT_KINDS = new Set(["fraud_alert"]);
const URGENT_URGENCY = new Set(["high", "critical"]);

// ─────────────────────────────────────────────────────────────────────────────
// Palette — works on both light and dark home screens
// ─────────────────────────────────────────────────────────────────────────────
const COLOR = {
  bg:        new Color("#0f0f0f", 1),
  bgAlt:     new Color("#1a1a1a", 1),
  accent:    new Color("#f59e0b", 1),   // amber — Lantern brand
  urgent:    new Color("#ef4444", 1),   // red for fraud / high-urgency
  textPri:   new Color("#f5f5f5", 1),
  textSec:   new Color("#a3a3a3", 1),
  textDim:   new Color("#6b7280", 1),
  border:    new Color("#2d2d2d", 1),
  pill: {
    suggested: new Color("#1e3a5f", 1),
    done:      new Color("#1a3320", 1),
    undone:    new Color("#3b2200", 1),
    dismissed: new Color("#1e1e1e", 1),
  },
  pillText: {
    suggested: new Color("#60a5fa", 1),
    done:      new Color("#4ade80", 1),
    undone:    new Color("#fb923c", 1),
    dismissed: new Color("#6b7280", 1),
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function isUrgent(event) {
  return URGENT_KINDS.has(event.kind) || URGENT_URGENCY.has(event.urgency);
}

function kindMeta(kind) {
  return KIND_META[kind] || { sf: "bolt.fill", label: kind };
}

/** Truncate a string to maxLen characters. */
function trunc(s, maxLen) {
  if (!s) return "";
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + "…";
}

/** Format ISO timestamp to "h:mm AM/PM" or "Mon h:mm AM/PM". */
function fmtTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const df = new DateFormatter();
  // Same calendar day → just time; otherwise short day + time.
  const sameDay = d.toDateString() === now.toDateString();
  df.dateFormat = sameDay ? "h:mm a" : "EEE h:mm a";
  return df.string(d);
}

/** Current time as "h:mm a". */
function nowFormatted() {
  const df = new DateFormatter();
  df.dateFormat = "h:mm a";
  return df.string(new Date());
}

// ─────────────────────────────────────────────────────────────────────────────
// Network
// ─────────────────────────────────────────────────────────────────────────────

async function fetchEvents(limit) {
  const url = `${API_BASE}/v1/life-events?limit=${limit}`;
  const req = new Request(url);
  req.headers = { Authorization: `Bearer ${API_KEY}` };
  req.timeoutInterval = 8; // seconds

  // The server returns a bare JSON array [ {...}, … ]
  const json = await req.loadJSON();

  // Defensive: some callers wrap in { items: [...] } — handle both shapes.
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.items)) return json.items;
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Widget builder
// ─────────────────────────────────────────────────────────────────────────────

function buildErrorWidget(msg) {
  const w = new ListWidget();
  w.backgroundColor = COLOR.bg;
  w.url = DASHBOARD_URL;

  const title = w.addText("Lantern");
  title.font = Font.boldSystemFont(13);
  title.textColor = COLOR.accent;

  w.addSpacer(6);

  const err = w.addText("⚠︎  " + msg);
  err.font = Font.systemFont(12);
  err.textColor = COLOR.urgent;
  err.lineLimit = 3;

  w.addSpacer();

  const foot = w.addText("Tap to open dashboard");
  foot.font = Font.systemFont(10);
  foot.textColor = COLOR.textDim;

  return w;
}

/**
 * Add one event row to the widget stack.
 * @param {ListWidget} w
 * @param {object} event
 * @param {boolean} isSmall - compact layout for small widget
 */
function addEventRow(w, event, isSmall) {
  const urgent = isUrgent(event);
  const meta   = kindMeta(event.kind);

  const row = w.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();
  row.spacing = 6;

  // Icon
  try {
    const sfName = urgent ? "exclamationmark.triangle.fill" : meta.sf;
    const sfImg  = SFSymbol.named(sfName);
    sfImg.applyMediumWeight();
    const icon = row.addImage(sfImg.image);
    icon.imageSize   = new Size(14, 14);
    icon.tintColor   = urgent ? COLOR.urgent : COLOR.accent;
    icon.resizable   = false;
  } catch (_) {
    // SFSymbol unavailable on older iOS — fall back to text glyph
    const glyph = row.addText(urgent ? "⚠" : "•");
    glyph.font      = Font.boldSystemFont(12);
    glyph.textColor = urgent ? COLOR.urgent : COLOR.accent;
  }

  // Summary text
  const maxChars = isSmall ? 32 : 52;
  const line = row.addText(trunc(event.summary, maxChars));
  line.font      = Font.systemFont(isSmall ? 11 : 12);
  line.textColor = urgent ? COLOR.urgent : COLOR.textPri;
  line.lineLimit = 1;

  row.addSpacer(); // push timestamp right

  // Timestamp (skip on small to save space)
  if (!isSmall) {
    const ts = row.addText(fmtTime(event.createdAt));
    ts.font      = Font.systemFont(10);
    ts.textColor = COLOR.textDim;
  }

  // Thin separator below each row (add BEFORE the next spacer call)
  w.addSpacer(1);
}

async function buildWidget(events) {
  const family   = config.widgetFamily || "medium";
  const maxRows  = FAMILY_ROWS[family] || FAMILY_ROWS.medium;
  const isSmall  = family === "small";
  const isLarge  = family === "large";

  const w = new ListWidget();
  w.backgroundColor = COLOR.bg;
  w.url = DASHBOARD_URL;
  // Refreshes every 15 min (Scriptable honours this as a hint).
  w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);

  // ── Header ──────────────────────────────────────────────────────────────
  const header = w.addStack();
  header.layoutHorizontally();
  header.centerAlignContent();

  const titleText = header.addText("Lantern");
  titleText.font      = Font.boldSystemFont(isSmall ? 12 : 14);
  titleText.textColor = COLOR.accent;

  if (!isSmall) {
    const subText = header.addText("  ·  automations");
    subText.font      = Font.systemFont(12);
    subText.textColor = COLOR.textSec;
  }

  header.addSpacer();

  if (isLarge) {
    const countText = header.addText(`${events.length} events`);
    countText.font      = Font.systemFont(10);
    countText.textColor = COLOR.textDim;
  }

  w.addSpacer(isSmall ? 4 : 6);

  // ── Event rows ───────────────────────────────────────────────────────────
  const shown = events.slice(0, maxRows);

  if (shown.length === 0) {
    w.addSpacer();
    const empty = w.addText("No recent automations");
    empty.font      = Font.systemFont(12);
    empty.textColor = COLOR.textDim;
    empty.centerAlignText();
    w.addSpacer();
  } else {
    for (const ev of shown) {
      addEventRow(w, ev, isSmall);
      w.addSpacer(isSmall ? 2 : 3);
    }
  }

  w.addSpacer();

  // ── Footer ───────────────────────────────────────────────────────────────
  const footer = w.addStack();
  footer.layoutHorizontally();

  const updated = footer.addText(`Updated ${nowFormatted()}`);
  updated.font      = Font.systemFont(9);
  updated.textColor = COLOR.textDim;

  footer.addSpacer();

  if (!isSmall && events.length > maxRows) {
    const more = footer.addText(`+${events.length - maxRows} more`);
    more.font      = Font.systemFont(9);
    more.textColor = COLOR.textSec;
  }

  return w;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function run() {
  // Guard: misconfigured API_KEY / API_BASE surfaced before a network error.
  if (API_KEY === "hlx_live_PASTE_YOUR_KEY_HERE" || API_BASE.includes("YOUR-TUNNEL")) {
    const w = buildErrorWidget("Set API_BASE and API_KEY in the script config block.");
    Script.setWidget(w);
    if (!config.runsInWidget) w.presentMedium();
    return;
  }

  let widget;
  try {
    const events = await fetchEvents(FETCH_LIMIT);
    widget = await buildWidget(events);
  } catch (err) {
    widget = buildErrorWidget("Can't reach Lantern — check API_BASE and connection.");
  }

  Script.setWidget(widget);

  // When run interactively (not from home screen) preview at the matching size.
  if (!config.runsInWidget) {
    const family = config.widgetFamily || "medium";
    if (family === "small")       await widget.presentSmall();
    else if (family === "large")  await widget.presentLarge();
    else                          await widget.presentMedium();
  }
}

await run();
Script.complete();
