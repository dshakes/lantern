// Public URLs the dashboard shows or copies for use OUTSIDE the browser (curl
// examples, agent cards, the webchat embed). They are derived from this
// deployment, never a hardcoded public domain: a copied URL carries the
// caller's API key, so it must point at the operator's own control plane.
//
//   NEXT_PUBLIC_API_URL      when set (the API's public URL)
//   http://localhost:8080    when the dashboard itself runs on localhost
//   window.location.origin   otherwise (the dashboard proxies /v1 to the API)
export function publicApiBase(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL;
  if (configured) return configured.replace(/\/+$/, "");
  if (typeof window === "undefined") return "";
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1") return "http://localhost:8080";
  return window.location.origin;
}

// The webchat widget is served same-origin by the dashboard at /widget.js.
export function widgetScriptUrl(): string {
  return typeof window === "undefined" ? "/widget.js" : `${window.location.origin}/widget.js`;
}
