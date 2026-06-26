#!/usr/bin/env python3
"""Generate ONE 'Lantern Status' menu Shortcut for the iPhone Action Button.

Instead of five separate status shortcuts, this builds a single shortcut with a
"Choose from Menu" block — Busy / Available / DND / Driving / Desk — each branch
POSTing the matching {kind, detail} signal to /v1/signals. Assign it to the
Action Button (or a home-screen tap) for true one-tap status, the kiosk-style UX.

The control-flow shape Shortcuts expects:
    choosefrommenu(mode=0, WFMenuItems=[...titles], GroupingIdentifier=GID)
    choosefrommenu(mode=1, WFMenuItemTitle="Busy", GID)  ->  downloadurl(POST)
    ... one (case, POST) pair per item ...
    choosefrommenu(mode=2, GID)                            # end menu
All menu actions share ONE GroupingIdentifier (a UUID).

Token: $LANTERN_SIGNAL_TOKEN, else read from the control-plane LaunchAgent plist.
Output: ~/Desktop/Lantern-Status.shortcut (signed --mode anyone; token baked in,
so it is NEVER committed).
"""

import os
import plistlib
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

URL = os.environ.get(
    "LANTERN_SIGNAL_URL",
    "https://macbook-pro-2.tail0be192.ts.net/v1/signals",
)
# (menu title, kind, detail) — title is what you tap; kind/detail is the signal.
ITEMS = [
    ("Busy", "focus", "Busy"),
    ("Available", "focus", "Available"),
    ("Do Not Disturb", "focus", "DND"),
    ("Driving", "device", "driving"),
    ("At Desk", "focus", "Desk"),
]


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


def dict_field(pairs: list[tuple[str, str]]) -> dict:
    """A WFDictionaryFieldValue with simple string key/value items."""
    items = [
        {"WFItemType": 0, "WFKey": text_token(k), "WFValue": text_token(v)}
        for k, v in pairs
    ]
    return {
        "Value": {"WFDictionaryFieldValueItems": items},
        "WFSerializationType": "WFDictionaryFieldValue",
    }


def post_action(token: str, kind: str, detail: str) -> dict:
    return {
        "WFWorkflowActionIdentifier": "is.workflow.actions.downloadurl",
        "WFWorkflowActionParameters": {
            "WFURL": URL,
            "WFHTTPMethod": "POST",
            "ShowHeaders": True,
            "WFHTTPHeaders": dict_field([("x-lantern-signal-token", token)]),
            "WFHTTPBodyType": "JSON",
            "WFJSONValues": dict_field([("kind", kind), ("detail", detail)]),
        },
    }


def menu(mode: int, gid: str, **extra) -> dict:
    params = {"WFControlFlowMode": mode, "GroupingIdentifier": gid}
    params.update(extra)
    return {
        "WFWorkflowActionIdentifier": "is.workflow.actions.choosefrommenu",
        "WFWorkflowActionParameters": params,
    }


def main() -> None:
    token = resolve_token()
    gid = str(uuid.uuid4()).upper()
    actions = [
        menu(0, gid, WFMenuPrompt="Set status", WFMenuItems=[t for t, _, _ in ITEMS])
    ]
    for title, kind, detail in ITEMS:
        actions.append(menu(1, gid, WFMenuItemTitle=title))
        actions.append(post_action(token, kind, detail))
    actions.append(menu(2, gid))

    plist = {
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
        "WFWorkflowActions": actions,
    }

    out_dir = Path(os.environ.get("LANTERN_SHORTCUT_OUT", str(Path.home() / "Desktop")))
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "Lantern-Status.shortcut"
    with tempfile.NamedTemporaryFile(suffix=".shortcut", delete=False) as tf:
        plistlib.dump(plist, tf)
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
    print(f"  ✓ Lantern-Status  (menu: {', '.join(t for t, _, _ in ITEMS)})")
    print(f"Signed → {out}")
    print(
        "Assign it to the Action Button: Settings → Action Button → Shortcut → Lantern-Status."
    )


if __name__ == "__main__":
    main()
