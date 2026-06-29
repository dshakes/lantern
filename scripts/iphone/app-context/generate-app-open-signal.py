#!/usr/bin/env python3
"""Generate a per-app "app opened" Shortcut for the iPhone.

A single fixed POST of {kind:"app_open", app:"<App>"} to /v1/signals — NO input
variable (that plumbing is the fragile part), so it imports and runs reliably and
attaches cleanly to a "When <App> is opened" Personal Automation.

The bridge requires `app` (not `detail`) for kind=app_open, which the generic
_signal-template.shortcut can't express — hence this dedicated generator. Token
from env or the API plist; baked into the signed output (never committed).

Usage:
    python3 generate-app-open-signal.py YouTube
    python3 generate-app-open-signal.py "Instagram" "TikTok" "Spotify"
Output: ~/Desktop/Lantern-AppOpen-<App>.shortcut for each app.
"""

import os
import plistlib
import re
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

URL = os.environ.get(
    "LANTERN_SIGNAL_URL",
    "https://macbook-pro-2.tail0be192.ts.net/v1/signals",
)


def resolve_token() -> str:
    tok = os.environ.get("LANTERN_SIGNAL_TOKEN", "").strip()
    if tok:
        return tok
    plist = Path.home() / "Library/LaunchAgents/dev.lantern.api.plist"
    if plist.exists():
        out = subprocess.run(
            [
                "/usr/libexec/PlistBuddy",
                "-c",
                "Print :EnvironmentVariables:LANTERN_SIGNAL_TOKEN",
                str(plist),
            ],
            capture_output=True,
            text=True,
        )
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    sys.exit("ERROR: no LANTERN_SIGNAL_TOKEN (env or plist).")


def text_token(s: str) -> dict:
    return {"Value": {"string": s}, "WFSerializationType": "WFTextTokenString"}


def build_plist(app: str, token: str) -> dict:
    json_items = [
        {
            "WFItemType": 0,
            "WFKey": text_token("kind"),
            "WFValue": text_token("app_open"),
        },
        {"WFItemType": 0, "WFKey": text_token("app"), "WFValue": text_token(app)},
    ]
    post = {
        "WFWorkflowActionIdentifier": "is.workflow.actions.downloadurl",
        "WFWorkflowActionParameters": {
            "WFURL": URL,
            "WFHTTPMethod": "POST",
            "ShowHeaders": True,
            "WFHTTPHeaders": {
                "Value": {
                    "WFDictionaryFieldValueItems": [
                        {
                            "WFItemType": 0,
                            "WFKey": text_token("x-lantern-signal-token"),
                            "WFValue": text_token(token),
                        },
                    ]
                },
                "WFSerializationType": "WFDictionaryFieldValue",
            },
            "WFHTTPBodyType": "JSON",
            "WFJSONValues": {
                "Value": {"WFDictionaryFieldValueItems": json_items},
                "WFSerializationType": "WFDictionaryFieldValue",
            },
            "UUID": str(uuid.uuid4()).upper(),
        },
    }
    return {
        "WFWorkflowClientVersion": "2607.0.2",
        "WFWorkflowMinimumClientVersion": 900,
        "WFWorkflowMinimumClientVersionString": "900",
        "WFWorkflowIcon": {
            "WFWorkflowIconStartColor": 4274264319,
            "WFWorkflowIconGlyphNumber": 61440,
        },
        "WFWorkflowImportQuestions": [],
        "WFWorkflowTypes": ["NCWidget", "WatchKit"],
        "WFWorkflowInputContentItemClasses": ["WFStringContentItem"],
        "WFWorkflowActions": [post],
    }


def main() -> None:
    apps = sys.argv[1:] or ["YouTube"]
    token = resolve_token()
    out_dir = Path(os.environ.get("LANTERN_SHORTCUT_OUT", str(Path.home() / "Desktop")))
    out_dir.mkdir(parents=True, exist_ok=True)
    for app in apps:
        safe = re.sub(r"[^A-Za-z0-9]+", "-", app).strip("-") or "App"
        out = out_dir / f"Lantern-AppOpen-{safe}.shortcut"
        with tempfile.NamedTemporaryFile(suffix=".shortcut", delete=False) as tf:
            plistlib.dump(build_plist(app, token), tf)
            unsigned = tf.name
        try:
            subprocess.run(
                [
                    "shortcuts",
                    "sign",
                    "--mode",
                    "anyone",
                    "--input",
                    unsigned,
                    "--output",
                    str(out),
                ],
                check=True,
            )
        finally:
            os.unlink(unsigned)
        print(f"  ✓ Lantern-AppOpen-{safe}  (POST app_open:{app}) → {out}")
    print(
        "Trigger: Automation → 'When <App> is opened' → Run the matching Lantern-AppOpen-<App>."
    )


if __name__ == "__main__":
    main()
