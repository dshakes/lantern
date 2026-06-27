#!/usr/bin/env python3
"""Generate the DYNAMIC 'Now Playing' Shortcut for the iPhone.

Unlike the fixed-detail status/geofence shortcuts, this one reads a value ON the
device (the current track) and plumbs it into the POST body as a variable. That
variable-into-JSON wiring (an ActionOutput attachment) is the fragile part that
broke the original reusable shortcut, so this generator builds it explicitly and
correctly:

    getnowplaying            (UUID = U, output "Now Playing")
    downloadurl POST { kind: "now_playing", detail: <ActionOutput U> }

`detail` is a STRING (the track title), so the variable binding is reliable —
this is the media half of "health & media". (Steps/health bind a NUMERIC value,
which is genuinely finicky from a variable; see RICH-SIGNALS.md for that recipe.)

Run it on an Automation trigger like "When I start playing media" (Music/Spotify),
or tap it. Token from env or the API plist; baked into the signed output (never
committed). Output: ~/Desktop/Lantern-NowPlaying.shortcut.
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


def var_token(out_uuid: str, name: str) -> dict:
    """A text token whose content is another action's output (a variable)."""
    return {
        "Value": {
            "string": "￼",  # object-replacement char, the attachment anchor
            "attachmentsByRange": {
                "{0, 1}": {
                    "Type": "ActionOutput",
                    "OutputUUID": out_uuid,
                    "OutputName": name,
                }
            },
        },
        "WFSerializationType": "WFTextTokenString",
    }


def main() -> None:
    token = resolve_token()
    u = str(uuid.uuid4()).upper()

    # "Get Current Song" — the real, current action id. The earlier
    # `getnowplaying` id is not a valid action, so it imported as a broken
    # (grayed-out) action and the shortcut never ran.
    get_now_playing = {
        "WFWorkflowActionIdentifier": "is.workflow.actions.getcurrentsong",
        "WFWorkflowActionParameters": {"UUID": u},
    }
    json_items = [
        {
            "WFItemType": 0,
            "WFKey": text_token("kind"),
            "WFValue": text_token("now_playing"),
        },
        {
            "WFItemType": 0,
            "WFKey": text_token("detail"),
            "WFValue": var_token(u, "Current Song"),
        },
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
                        }
                    ]
                },
                "WFSerializationType": "WFDictionaryFieldValue",
            },
            "WFHTTPBodyType": "JSON",
            "WFJSONValues": {
                "Value": {"WFDictionaryFieldValueItems": json_items},
                "WFSerializationType": "WFDictionaryFieldValue",
            },
        },
    }

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
        "WFWorkflowActions": [get_now_playing, post],
    }

    out_dir = Path(os.environ.get("LANTERN_SHORTCUT_OUT", str(Path.home() / "Desktop")))
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "Lantern-NowPlaying.shortcut"
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
    print("  ✓ Lantern-NowPlaying  (getcurrentsong → POST now_playing:<track>)")
    print(f"Signed → {out}")
    print(
        "Trigger: Automation → 'When I open/start playing' Music/Spotify → Run Lantern-NowPlaying."
    )


if __name__ == "__main__":
    main()
