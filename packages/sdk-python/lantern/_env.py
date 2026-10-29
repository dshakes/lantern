"""Lantern→PAL env compat (ADR 0032): read ``PAL_X``, falling back to ``LANTERN_X``.

Read-only on purpose — a library must not rewrite its host process's env.
"""

from __future__ import annotations

import os
from collections.abc import Mapping


def get(suffix: str, default: str | None = None, env: Mapping[str, str] | None = None) -> str | None:
    """``PAL_<suffix>`` if set (even empty — PAL wins), else ``LANTERN_<suffix>``, else ``default``."""
    source = os.environ if env is None else env
    pal = source.get(f"PAL_{suffix}")
    if pal is not None:
        return pal
    return source.get(f"LANTERN_{suffix}", default)
