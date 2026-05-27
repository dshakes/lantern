"""Web-scraper demo — proves the egress allowlist + secret vending.

Reads `{"url": "..."}` from stdin. Fetches the URL through the harness's
HTTP CONNECT proxy at 127.0.0.1:3128. Returns title + meta description.

If the URL doesn't match an `egress_rules` pattern from the AgentSpec,
the harness proxy returns 403 and writes an audit event. The workload
sees a clean error response and exits with code 3 ("egress denied").

User-Agent is vended at boot via /run/lantern/secrets/USER_AGENT. The
raw value never appears in the OCI image or in env.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import requests
from bs4 import BeautifulSoup


SECRETS_DIR = Path("/run/lantern/secrets")
PROXY = "http://127.0.0.1:3128"


def read_secret(name: str, default: str = "") -> str:
    """Read a vended secret from the harness tmpfs. Falls back to env for local dev."""
    p = SECRETS_DIR / name
    if p.exists():
        return p.read_text().strip()
    return os.environ.get(name, default)


def main() -> int:
    payload = json.loads(sys.stdin.read() or "{}")
    url = payload.get("url")
    if not url:
        print(json.dumps({"error": "url required"}), file=sys.stderr)
        return 2

    user_agent = read_secret("USER_AGENT", "lantern-demo/0.1 (+https://lantern.dev)")

    try:
        resp = requests.get(
            url,
            headers={"User-Agent": user_agent},
            proxies={"http": PROXY, "https": PROXY},
            timeout=15,
        )
    except requests.exceptions.ProxyError as e:
        # The harness denies non-allowlisted hosts at the CONNECT step.
        print(json.dumps({"error": "egress denied", "detail": str(e)}), file=sys.stderr)
        return 3
    except requests.exceptions.RequestException as e:
        print(json.dumps({"error": "fetch failed", "detail": str(e)}), file=sys.stderr)
        return 4

    if resp.status_code != 200:
        print(json.dumps({"error": f"upstream {resp.status_code}"}), file=sys.stderr)
        return 5

    soup = BeautifulSoup(resp.text, "html.parser")
    title_tag = soup.find("title")
    meta = soup.find("meta", attrs={"name": "description"})

    out = {
        "url": url,
        "title": title_tag.get_text(strip=True) if title_tag else None,
        "description": meta.get("content") if meta else None,
        "bytes": len(resp.content),
    }
    print(json.dumps(out), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
