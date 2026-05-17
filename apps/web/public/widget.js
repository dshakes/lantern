/* Lantern Webchat widget — embeddable on any website.
 *
 * Usage:
 *   <script src="https://your-lantern/widget.js"
 *           data-api-key="lk_..."
 *           data-agent="my-assistant"
 *           data-api-base="https://your-lantern"
 *           data-theme="dark"
 *           data-position="bottom-right"
 *           async defer></script>
 *
 * What it does:
 *   1. Injects a chat-bubble button in the corner of the page.
 *   2. Clicking opens a chat window.
 *   3. Each message creates / continues a Lantern session via the real
 *      /v1/sessions + /v1/sessions/{id}/messages endpoints, streaming
 *      replies over SSE through /v1/sessions/{id}/events.
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
  if (window.__lanternWidgetLoaded) return;
  window.__lanternWidgetLoaded = true;

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
  var brand = script.getAttribute("data-brand") || "Lantern";

  if (!apiKey || !agentName || !apiBase) {
    console.warn(
      "[lantern-widget] Missing required attributes. Need data-api-key, data-agent, data-api-base."
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
    "#lantern-widget-bubble{position:fixed;width:56px;height:56px;border-radius:50%;cursor:pointer;",
    "background:linear-gradient(135deg," + palette.accent + "," + palette.accentDark + ");",
    "box-shadow:0 8px 24px rgba(0,0,0,0.2);display:flex;align-items:center;justify-content:center;",
    "z-index:2147483646;border:none;transition:transform .15s ease;}",
    "#lantern-widget-bubble:hover{transform:scale(1.05);}",
    "#lantern-widget-bubble svg{width:24px;height:24px;color:#fff;}",
    "#lantern-widget-bubble." + position + "{",
    position === "bottom-left" ? "left:24px;bottom:24px;" : "right:24px;bottom:24px;",
    "}",

    "#lantern-widget-panel{position:fixed;width:380px;max-width:calc(100vw - 32px);height:560px;",
    "max-height:calc(100vh - 100px);background:" + palette.bg + ";color:" + palette.text + ";",
    "border:1px solid " + palette.border + ";border-radius:16px;overflow:hidden;",
    "box-shadow:0 24px 64px rgba(0,0,0,0.35);display:none;flex-direction:column;z-index:2147483647;",
    "font:14px/1.45 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;}",
    "#lantern-widget-panel.open{display:flex;}",
    "#lantern-widget-panel." + position + "{",
    position === "bottom-left" ? "left:24px;bottom:88px;" : "right:24px;bottom:88px;",
    "}",

    "#lantern-widget-header{display:flex;align-items:center;gap:8px;padding:12px 16px;",
    "border-bottom:1px solid " + palette.border + ";}",
    "#lantern-widget-header .brand{font-weight:600;flex:1;}",
    "#lantern-widget-header button{background:transparent;border:none;color:" + palette.textMuted + ";",
    "cursor:pointer;padding:4px;border-radius:6px;}",
    "#lantern-widget-header button:hover{background:" + palette.surface + ";color:" + palette.text + ";}",

    "#lantern-widget-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;}",
    "#lantern-widget-messages .msg{max-width:80%;padding:8px 12px;border-radius:14px;word-wrap:break-word;white-space:pre-wrap;}",
    "#lantern-widget-messages .msg.user{align-self:flex-end;background:" + palette.accent + ";color:#fff;border-bottom-right-radius:4px;}",
    "#lantern-widget-messages .msg.assistant{align-self:flex-start;background:" + palette.surface + ";color:" + palette.text + ";border-bottom-left-radius:4px;}",
    "#lantern-widget-messages .msg.assistant.streaming::after{content:'\\25CF';margin-left:4px;opacity:.6;animation:lanternPulse 1s infinite;}",
    "@keyframes lanternPulse{0%,100%{opacity:.3;}50%{opacity:1;}}",
    "#lantern-widget-messages .greeting{color:" + palette.textMuted + ";text-align:center;padding:24px 12px;font-size:13px;}",

    "#lantern-widget-input{display:flex;gap:8px;padding:12px;border-top:1px solid " + palette.border + ";",
    "background:" + palette.bg + ";}",
    "#lantern-widget-input textarea{flex:1;resize:none;background:" + palette.surface + ";",
    "border:1px solid " + palette.border + ";border-radius:10px;padding:8px 12px;color:" + palette.text + ";",
    "font:inherit;outline:none;height:38px;max-height:120px;line-height:1.45;}",
    "#lantern-widget-input textarea:focus{border-color:" + palette.accent + ";}",
    "#lantern-widget-input button{background:" + palette.accent + ";color:#fff;border:none;border-radius:10px;",
    "padding:0 14px;cursor:pointer;font-weight:500;}",
    "#lantern-widget-input button:disabled{opacity:.4;cursor:not-allowed;}",

    "#lantern-widget-footer{padding:8px 16px;font-size:11px;color:" + palette.textMuted + ";text-align:center;",
    "border-top:1px solid " + palette.border + ";}",
    "#lantern-widget-footer a{color:inherit;}",
  ].join("");

  var styleEl = document.createElement("style");
  styleEl.id = "lantern-widget-style";
  styleEl.appendChild(document.createTextNode(css));
  document.head.appendChild(styleEl);

  // ---- DOM construction -------------------------------------------------
  var bubble = document.createElement("button");
  bubble.id = "lantern-widget-bubble";
  bubble.className = position;
  bubble.setAttribute("aria-label", "Open chat");
  bubble.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

  var panel = document.createElement("div");
  panel.id = "lantern-widget-panel";
  panel.className = position;
  panel.innerHTML =
    '<div id="lantern-widget-header">' +
    '<div class="brand">' + escapeHtml(brand) + '</div>' +
    '<button aria-label="Close" id="lantern-widget-close">' +
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
    '</button></div>' +
    '<div id="lantern-widget-messages"><div class="greeting">' + escapeHtml(greeting) + '</div></div>' +
    '<div id="lantern-widget-input">' +
    '<textarea placeholder="Type a message…" rows="1" id="lantern-widget-textarea"></textarea>' +
    '<button id="lantern-widget-send">Send</button>' +
    '</div>' +
    '<div id="lantern-widget-footer">Powered by <a href="https://lantern.run" target="_blank" rel="noopener">Lantern</a></div>';

  document.body.appendChild(bubble);
  document.body.appendChild(panel);

  // ---- Behavior ---------------------------------------------------------
  var sessionId = null;
  var inflight = false;
  var messagesEl = panel.querySelector("#lantern-widget-messages");
  var textareaEl = panel.querySelector("#lantern-widget-textarea");
  var sendEl = panel.querySelector("#lantern-widget-send");

  bubble.addEventListener("click", function () {
    panel.classList.toggle("open");
    if (panel.classList.contains("open")) textareaEl.focus();
  });
  panel.querySelector("#lantern-widget-close").addEventListener("click", function () {
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
        return postMessage(id, text).then(function () {
          return streamReply(id, streamingEl);
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

  // Stream the agent reply via SSE on /v1/sessions/{id}/events. We resolve
  // when we see an agent.message event and then close the stream.
  function streamReply(id, el) {
    return new Promise(function (resolve, reject) {
      var url = apiBase + "/v1/sessions/" + encodeURIComponent(id) + "/events";
      // EventSource doesn't support Authorization headers, so we pass the
      // key as a query param. The control-plane accepts ?token=... on SSE
      // endpoints. (See sessions handler.)
      var es;
      try {
        es = new EventSource(url + "?token=" + encodeURIComponent(apiKey));
      } catch (err) {
        reject(err);
        return;
      }
      var timeout = setTimeout(function () {
        es.close();
        reject(new Error("timeout"));
      }, 60_000);
      es.onmessage = function (e) {
        try {
          var evt = JSON.parse(e.data);
          if (evt.type === "agent.message" && evt.data && evt.data.content) {
            clearTimeout(timeout);
            el.textContent = evt.data.content;
            es.close();
            resolve();
          }
        } catch (err) {
          /* ignore malformed */
        }
      };
      es.onerror = function () {
        clearTimeout(timeout);
        es.close();
        reject(new Error("stream error"));
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
