/* PAL Webchat widget — embeddable on any website.
 *
 * Usage:
 *   <script src="https://your-pal/widget.js"
 *           data-api-key="lk_..."
 *           data-agent="my-assistant"
 *           data-api-base="https://your-pal"
 *           data-theme="dark"
 *           data-position="bottom-right"
 *           async defer></script>
 *
 * What it does:
 *   1. Injects a chat-bubble button in the corner of the page.
 *   2. Clicking opens a chat window.
 *   3. Each message creates / continues a PAL session via the real
 *      /v1/sessions + /v1/sessions/{id}/messages endpoints, streaming
 *      replies over SSE through /v1/sessions/{id}/events.
 *   4. Support-desk agents (label handoff=human) can hand the conversation to
 *      a person: the widget shows "Connecting you to a human…", stops waiting
 *      for the agent, and renders the operator's replies as they arrive. KB
 *      answers show the documents they were drawn from under the reply.
 *
 * Security: the API key is visible in the browser. Scope it tightly
 *   (sessions: create + read, messages: send) and rate-limit it on the
 *   server side. For high-trust applications, use a per-user signed
 *   token issued by your own backend instead.
 *
 * This file is plain ES2017 — no bundler, no React, no dependencies, so
 * it works as a one-tag include on any page.
 */

(function () {
  "use strict";

  // ---- Bail-out if already loaded ---------------------------------------
  if (window.__palWidgetLoaded) return;
  window.__palWidgetLoaded = true;

  // ---- Config from script-tag data attributes ---------------------------
  var script = document.currentScript;
  if (!script) {
    // Fallback for browsers that don't set currentScript (rare).
    var all = document.getElementsByTagName("script");
    script = all[all.length - 1];
  }
  var apiKey = script.getAttribute("data-api-key") || "";
  var agentName = script.getAttribute("data-agent") || "";
  var apiBase = (script.getAttribute("data-api-base") || "").replace(/\/$/, "");
  var theme = script.getAttribute("data-theme") || "dark";
  var position = script.getAttribute("data-position") || "bottom-right";
  var greeting = script.getAttribute("data-greeting") || "How can I help?";
  var brand = script.getAttribute("data-brand") || "PAL";

  if (!apiKey || !agentName || !apiBase) {
    console.warn(
      "[pal-widget] Missing required attributes. Need data-api-key, data-agent, data-api-base."
    );
    return;
  }

  // ---- Styling ----------------------------------------------------------
  var dark = theme !== "light";
  var palette = dark
    ? {
        bg: "#0a0a0a",
        surface: "#171717",
        surfaceHi: "#262626",
        border: "#262626",
        text: "#fafafa",
        textMuted: "#a1a1aa",
        accent: "#a78bfa",
        accentDark: "#7c3aed",
      }
    : {
        bg: "#ffffff",
        surface: "#f4f4f5",
        surfaceHi: "#e4e4e7",
        border: "#e4e4e7",
        text: "#0a0a0a",
        textMuted: "#52525b",
        accent: "#7c3aed",
        accentDark: "#5b21b6",
      };

  var css = [
    "#pal-widget-bubble{position:fixed;width:56px;height:56px;border-radius:50%;cursor:pointer;",
    "background:linear-gradient(135deg," + palette.accent + "," + palette.accentDark + ");",
    "box-shadow:0 8px 24px rgba(0,0,0,0.2);display:flex;align-items:center;justify-content:center;",
    "z-index:2147483646;border:none;transition:transform .15s ease;}",
    "#pal-widget-bubble:hover{transform:scale(1.05);}",
    "#pal-widget-bubble svg{width:24px;height:24px;color:#fff;}",
    "#pal-widget-bubble." + position + "{",
    position === "bottom-left" ? "left:24px;bottom:24px;" : "right:24px;bottom:24px;",
    "}",

    "#pal-widget-panel{position:fixed;width:380px;max-width:calc(100vw - 32px);height:560px;",
    "max-height:calc(100vh - 100px);background:" + palette.bg + ";color:" + palette.text + ";",
    "border:1px solid " + palette.border + ";border-radius:16px;overflow:hidden;",
    "box-shadow:0 24px 64px rgba(0,0,0,0.35);display:none;flex-direction:column;z-index:2147483647;",
    "font:14px/1.45 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;}",
    "#pal-widget-panel.open{display:flex;}",
    "#pal-widget-panel." + position + "{",
    position === "bottom-left" ? "left:24px;bottom:88px;" : "right:24px;bottom:88px;",
    "}",

    "#pal-widget-header{display:flex;align-items:center;gap:8px;padding:12px 16px;",
    "border-bottom:1px solid " + palette.border + ";}",
    "#pal-widget-header .brand{font-weight:600;flex:1;}",
    "#pal-widget-header button{background:transparent;border:none;color:" + palette.textMuted + ";",
    "cursor:pointer;padding:4px;border-radius:6px;}",
    "#pal-widget-header button:hover{background:" + palette.surface + ";color:" + palette.text + ";}",

    "#pal-widget-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;}",
    "#pal-widget-messages .msg{max-width:80%;padding:8px 12px;border-radius:14px;word-wrap:break-word;white-space:pre-wrap;}",
    "#pal-widget-messages .msg.user{align-self:flex-end;background:" + palette.accent + ";color:#fff;border-bottom-right-radius:4px;}",
    "#pal-widget-messages .msg.assistant{align-self:flex-start;background:" + palette.surface + ";color:" + palette.text + ";border-bottom-left-radius:4px;}",
    "#pal-widget-messages .msg.assistant.streaming::after{content:'\\25CF';margin-left:4px;opacity:.6;animation:palPulse 1s infinite;}",
    "@keyframes palPulse{0%,100%{opacity:.3;}50%{opacity:1;}}",
    "#pal-widget-messages .msg.operator{align-self:flex-start;background:" + palette.bg + ";color:" + palette.text + ";",
    "border:1px solid " + palette.accent + ";border-bottom-left-radius:4px;}",
    "#pal-widget-messages .msg .sources{margin-top:6px;font-size:11px;color:" + palette.textMuted + ";}",
    "#pal-widget-status{display:none;padding:6px 16px;font-size:12px;text-align:center;",
    "background:" + palette.surface + ";color:" + palette.textMuted + ";border-bottom:1px solid " + palette.border + ";}",
    "#pal-widget-status.show{display:block;}",
    "#pal-widget-messages .greeting{color:" + palette.textMuted + ";text-align:center;padding:24px 12px;font-size:13px;}",

    "#pal-widget-input{display:flex;gap:8px;padding:12px;border-top:1px solid " + palette.border + ";",
    "background:" + palette.bg + ";}",
    "#pal-widget-input textarea{flex:1;resize:none;background:" + palette.surface + ";",
    "border:1px solid " + palette.border + ";border-radius:10px;padding:8px 12px;color:" + palette.text + ";",
    "font:inherit;outline:none;height:38px;max-height:120px;line-height:1.45;}",
    "#pal-widget-input textarea:focus{border-color:" + palette.accent + ";}",
    "#pal-widget-input button{background:" + palette.accent + ";color:#fff;border:none;border-radius:10px;",
    "padding:0 14px;cursor:pointer;font-weight:500;}",
    "#pal-widget-input button:disabled{opacity:.4;cursor:not-allowed;}",

    "#pal-widget-footer{padding:8px 16px;font-size:11px;color:" + palette.textMuted + ";text-align:center;",
    "border-top:1px solid " + palette.border + ";}",
    "#pal-widget-footer a{color:inherit;}",
  ].join("");

  var styleEl = document.createElement("style");
  styleEl.id = "pal-widget-style";
  styleEl.appendChild(document.createTextNode(css));
  document.head.appendChild(styleEl);

  // ---- DOM construction -------------------------------------------------
  var bubble = document.createElement("button");
  bubble.id = "pal-widget-bubble";
  bubble.className = position;
  bubble.setAttribute("aria-label", "Open chat");
  bubble.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

  var panel = document.createElement("div");
  panel.id = "pal-widget-panel";
  panel.className = position;
  panel.innerHTML =
    '<div id="pal-widget-header">' +
    '<div class="brand">' + escapeHtml(brand) + '</div>' +
    '<button aria-label="Close" id="pal-widget-close">' +
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
    '</button></div>' +
    '<div id="pal-widget-status"></div>' +
    '<div id="pal-widget-messages"><div class="greeting">' + escapeHtml(greeting) + '</div></div>' +
    '<div id="pal-widget-input">' +
    '<textarea placeholder="Type a message…" rows="1" id="pal-widget-textarea"></textarea>' +
    '<button id="pal-widget-send">Send</button>' +
    '</div>' +
    '<div id="pal-widget-footer">Powered by <a href="https://dshakes.github.io/pal" target="_blank" rel="noopener">PAL</a></div>';

  document.body.appendChild(bubble);
  document.body.appendChild(panel);

  // ---- Behavior ---------------------------------------------------------
  var sessionId = null;
  var inflight = false;
  var stream = null; // one EventSource for the session's lifetime
  var turn = null; // the in-flight agent turn, if any
  var messagesEl = panel.querySelector("#pal-widget-messages");
  var statusEl = panel.querySelector("#pal-widget-status");
  var textareaEl = panel.querySelector("#pal-widget-textarea");
  var sendEl = panel.querySelector("#pal-widget-send");

  bubble.addEventListener("click", function () {
    panel.classList.toggle("open");
    if (panel.classList.contains("open")) textareaEl.focus();
  });
  panel.querySelector("#pal-widget-close").addEventListener("click", function () {
    panel.classList.remove("open");
  });

  textareaEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  textareaEl.addEventListener("input", function () {
    textareaEl.style.height = "auto";
    textareaEl.style.height = Math.min(120, textareaEl.scrollHeight) + "px";
  });
  sendEl.addEventListener("click", send);

  function appendMessage(role, text) {
    // Drop the greeting placeholder once the conversation starts.
    var greetingEl = messagesEl.querySelector(".greeting");
    if (greetingEl) greetingEl.remove();
    var el = document.createElement("div");
    el.className = "msg " + role;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function setStatus(text) {
    statusEl.textContent = text || "";
    statusEl.className = text ? "show" : "";
  }

  function send() {
    var text = textareaEl.value.trim();
    if (!text || inflight) return;
    appendMessage("user", text);
    textareaEl.value = "";
    textareaEl.style.height = "auto";
    inflight = true;
    sendEl.disabled = true;
    var streamingEl = appendMessage("assistant", "");
    streamingEl.classList.add("streaming");

    ensureSession()
      .then(function (id) {
        // The stream is open (and subscribed) before the message is posted, so
        // the reply cannot be published into the void.
        return openStream(id).then(function () {
          var t = newTurn(streamingEl);
          return postMessage(id, text).then(function (res) {
            if (res && res.status === "handoff") {
              // A human has the conversation: no agent reply is coming.
              abandonTurn(t);
              streamingEl.remove();
              return;
            }
            return t.promise;
          });
        });
      })
      .catch(function (err) {
        streamingEl.classList.remove("streaming");
        streamingEl.textContent = "Sorry — couldn't reach the agent. (" + (err && err.message ? err.message : "unknown") + ")";
      })
      .then(function () {
        inflight = false;
        sendEl.disabled = false;
        streamingEl.classList.remove("streaming");
        textareaEl.focus();
      });
  }

  function ensureSession() {
    if (sessionId) return Promise.resolve(sessionId);
    return fetch(apiBase + "/v1/sessions", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ agentName: agentName }),
    })
      .then(handleJson)
      .then(function (data) {
        sessionId = data.id;
        return sessionId;
      });
  }

  function postMessage(id, content) {
    return fetch(apiBase + "/v1/sessions/" + encodeURIComponent(id) + "/messages", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ content: content }),
    }).then(handleJson);
  }

  // ---- Turn bookkeeping --------------------------------------------------
  function newTurn(el) {
    var t = { el: el, acc: "" };
    t.promise = new Promise(function (resolve, reject) {
      t.resolve = resolve;
      t.reject = reject;
    });
    t.timer = setTimeout(function () {
      failTurn(new Error("timeout"));
    }, 60000);
    turn = t;
    return t;
  }
  function abandonTurn(t) {
    clearTimeout(t.timer);
    if (turn === t) turn = null;
  }
  function finishTurn(text, sources) {
    if (!turn) return;
    var t = turn;
    abandonTurn(t);
    t.el.textContent = typeof text === "string" ? text : t.acc;
    if (sources && sources.length) {
      var src = document.createElement("div");
      src.className = "sources";
      src.textContent = "Sources: " + sources.map(function (s) { return s.title || s.id; }).join(", ");
      t.el.appendChild(src);
    }
    t.resolve();
  }
  function failTurn(err) {
    if (!turn) return;
    var t = turn;
    abandonTurn(t);
    t.reject(err);
  }

  // Open the session event stream once. Handles the token-streaming protocol
  // (message_delta / message_completed / message_error named events), the legacy
  // agent.message event, and the human-handoff events (session.handoff /
  // operator.message / session.resolved). Unknown kinds are ignored so old and
  // new servers both work.
  function openStream(id) {
    if (stream) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      // EventSource doesn't support Authorization headers, so the key goes in
      // as a query param; the control-plane accepts ?token=... on SSE endpoints.
      var es;
      try {
        es = new EventSource(apiBase + "/v1/sessions/" + encodeURIComponent(id) + "/events?token=" + encodeURIComponent(apiKey));
      } catch (err) {
        reject(err);
        return;
      }
      stream = es;
      var ready = false;
      function parse(e) {
        try { return JSON.parse(e.data); } catch (err) { return null; }
      }

      es.addEventListener("message_delta", function (e) {
        var evt = parse(e);
        if (turn && evt && typeof evt.delta === "string") {
          turn.acc += evt.delta;
          turn.el.textContent = turn.acc;
        }
      });
      es.addEventListener("message_completed", function (e) {
        var evt = parse(e);
        if (evt) finishTurn(evt.text, evt.sources);
      });
      es.addEventListener("message_error", function (e) {
        var evt = parse(e);
        failTurn(new Error((evt && evt.error) || "stream error"));
      });
      es.onmessage = function (e) {
        var evt = parse(e);
        if (!evt) return;
        if (evt.type === "connected" && !ready) {
          ready = true;
          resolve();
        } else if (evt.type === "agent.message" && evt.data && evt.data.content) {
          finishTurn(evt.data.content);
        } else if (evt.type === "session.handoff") {
          setStatus((evt.data && evt.data.message) || "Connecting you to a human…");
        } else if (evt.type === "operator.message" && evt.data && evt.data.content) {
          setStatus("You're chatting with a human teammate.");
          appendMessage("operator", evt.data.content);
        } else if (evt.type === "session.resolved") {
          setStatus("");
        }
      };
      es.onerror = function () {
        // EventSource reconnects by itself; only fail what is waiting on us.
        if (!ready) {
          stream = null;
          es.close();
          reject(new Error("stream error"));
        } else {
          failTurn(new Error("stream error"));
        }
      };
    });
  }

  function jsonHeaders() {
    return {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    };
  }

  function handleJson(res) {
    if (!res.ok) {
      return res.text().then(function (body) {
        throw new Error("HTTP " + res.status + (body ? ": " + body.slice(0, 120) : ""));
      });
    }
    return res.status === 204 ? null : res.json();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();
