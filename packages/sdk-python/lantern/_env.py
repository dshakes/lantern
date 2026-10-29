"""Lantern→PAL env compat (ADR 0032): read ``PAL_X``, falling back to ``LANTERN_X``.

Read-only on purpose — a library must not rewrite its host process's env.
"""

from __future__ import annotations

import os
from collections.abc import Mapping


def get(suffix: str, default: str | None = None, env: Mapping[str, str] | None = None) -> str | None:
    """``PAL_<suffix>`` if set, else ``LANTERN_<suffix>``, else ``default``.

    An empty ``PAL_`` value counts as unset when ``LANTERN_`` is non-empty, so a
    stray ``PAL_X=`` cannot blank a credential (matches the Go/TS/Rust helpers).
    """
    source = os.environ if env is None else env
    pal = source.get(f"PAL_{suffix}")
    legacy = source.get(f"LANTERN_{suffix}")
    if pal is not None and (pal or not legacy):
        return pal
    return default if legacy is None else legacy
