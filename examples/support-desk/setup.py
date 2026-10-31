#!/usr/bin/env python3
"""Deploy the support-desk example to a running PAL control-plane (stdlib only).

    PAL_API_URL=http://localhost:8080 python3 setup.py

Creates the agent from spec.json, uploads the documents listed in
knowledge.json (idempotent: the ids are fixed, so re-running replaces them) and
prints the widget snippet. Credentials default to the dev tenant; override with
PAL_EMAIL / PAL_PASSWORD.
"""

import json
import os
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.environ.get("PAL_API_URL", "http://localhost:8080").rstrip("/")


def call(method, path, body=None, token=None, ok=(200, 201, 204)):
    req = urllib.request.Request(BASE + path, method=method)
    if body is not None:
        req.data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            status, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read()
    if status not in ok:
        sys.exit(
            "%s %s -> HTTP %d: %s"
            % (method, path, status, raw[:300].decode(errors="replace"))
        )
    return status, (json.loads(raw) if raw else None)


def load(name):
    with open(os.path.join(HERE, name)) as f:
        return json.load(f)


def main():
    _, login = call(
        "POST",
        "/auth/login",
        {
            "email": os.environ.get("PAL_EMAIL", "admin@pal.local"),
            "password": os.environ.get("PAL_PASSWORD", "pal"),
        },
    )
    token = login["token"]

    spec = load("spec.json")
    status, _ = call("POST", "/v1/agents", spec, token, ok=(200, 201, 409))
    print(
        "agent %s: %s"
        % (spec["name"], "already exists" if status == 409 else "created")
    )

    for doc in load("knowledge.json"):
        with open(os.path.join(HERE, doc["file"])) as f:
            content = f.read()
        _, out = call(
            "POST",
            "/v1/agents/%s/documents" % spec["name"],
            {"id": doc["id"], "title": doc["title"], "content": content},
            token,
        )
        print(
            "uploaded %-26s %d chunk(s), %d embedded"
            % (doc["title"], out["chunkCount"], out["embeddedChunks"])
        )

    print(
        "\nNext: create an API key with scope runs:execute (Settings -> API keys), then paste on any page:\n"
    )
    print(
        '<script src="%s/widget.js" data-api-key="lk_..." data-agent="%s" data-api-base="%s" async defer></script>'
        % (
            os.environ.get("PAL_DASHBOARD_URL", "http://localhost:3001"),
            spec["name"],
            BASE,
        )
    )


if __name__ == "__main__":
    main()
