"use client";

import { useEffect, useRef } from "react";

// Cloudflare Turnstile widget (ADR 0027). Renders only when
// NEXT_PUBLIC_TURNSTILE_SITE_KEY is set; the control plane verifies the token
// server-side with PAL_TURNSTILE_SECRET.
export const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  remove: (id: string) => void;
};

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export function Turnstile({ onToken }: { onToken: (token: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || !ref.current) return;
    let widgetId: string | undefined;
    const render = () => {
      const ts = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
      if (!ts || !ref.current) return;
      widgetId = ts.render(ref.current, {
        sitekey: TURNSTILE_SITE_KEY,
        theme: "auto",
        callback: onToken,
        "expired-callback": () => onToken(""),
      });
    };
    let script = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
    if ((window as unknown as { turnstile?: TurnstileApi }).turnstile) {
      render();
    } else {
      if (!script) {
        script = document.createElement("script");
        script.src = SCRIPT_SRC;
        script.async = true;
        document.head.appendChild(script);
      }
      script.addEventListener("load", render, { once: true });
    }
    return () => {
      script?.removeEventListener("load", render);
      const ts = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
      if (widgetId && ts) ts.remove(widgetId);
    };
  }, [onToken]);

  if (!TURNSTILE_SITE_KEY) return null;
  return <div ref={ref} className="flex justify-center" />;
}
