#!/usr/bin/env python3
"""Structured-file helpers for scripts/cutover/pal-cutover.sh.

Kept out of the shell script on purpose: plists and env files are the two
places where a sed one-liner silently corrupts a value (an `=` inside a value,
a key that is a prefix of another, XML escaping). Everything here parses the
format properly and preserves values byte-for-byte.

PRIVACY: nothing here prints a VALUE unless the caller asks for exactly one
(`plist-get`), and that is only ever captured into a shell variable, never
echoed. Summaries list key NAMES only.
"""
from __future__ import annotations

import json
import os
import plistlib
import shlex
import re
import sys
import tempfile
from urllib.parse import unquote, urlsplit

ENV_LINE = re.compile(r"^(?P<lead>\s*(?:export\s+)?)(?P<key>[A-Za-z_][A-Za-z0-9_]*)(?P<rest>=.*)$", re.S)


def _write_atomic(path: str, data: bytes, mode: int) -> None:
    d = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".cutover-")
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


# ---------------------------------------------------------------- env files
def env_keys(path: str) -> list[str]:
    keys = []
    with open(path, "rb") as f:
        for raw in f.read().decode("utf-8", "surrogateescape").splitlines():
            m = ENV_LINE.match(raw)
            if m:
                keys.append(m.group("key"))
    return keys


def env_rename(path: str, old: str, new: str, dry: bool) -> dict:
    """Rename OLD_X keys to NEW_X. Values, comments, blank lines and ordering
    are untouched. A file that already defines both OLD_X and NEW_X is a
    conflict only when the values differ (then nothing is written)."""
    with open(path, "rb") as f:
        text = f.read().decode("utf-8", "surrogateescape")
    lines = text.splitlines(keepends=True)
    defined: dict[str, str] = {}
    for raw in lines:
        m = ENV_LINE.match(raw.rstrip("\r\n"))
        if m:
            defined[m.group("key")] = m.group("rest")
    renamed, dropped, conflicts, value_refs, path_refs = [], [], [], [], []
    out = []
    for raw in lines:
        body = raw.rstrip("\r\n")
        eol = raw[len(body):]
        m = ENV_LINE.match(body)
        if not m or not m.group("key").startswith(old):
            out.append(raw)
            if m and ("$" + old) in m.group("rest"):
                value_refs.append(m.group("key"))
            continue
        key = m.group("key")
        nkey = new + key[len(old):]
        rest = m.group("rest")
        if ("$" + old) in rest or ("${" + old) in rest:
            value_refs.append(key)
        if "/.lantern" in rest:
            path_refs.append(key)
        if nkey in defined:
            if defined[nkey] == rest:
                dropped.append(key)  # exact duplicate of the new key: drop the old line
                continue
            conflicts.append(key)
            out.append(raw)
            continue
        out.append(m.group("lead") + nkey + rest + eol)
        renamed.append(key)
    summary = {
        "file": path,
        "renamed": renamed,
        "dropped_duplicates": dropped,
        "conflicts": conflicts,
        "values_referencing_old_prefix": value_refs,
        "values_with_old_state_path": path_refs,
    }
    if conflicts:
        summary["written"] = False
        return summary
    if not dry:
        _write_atomic(path, "".join(out).encode("utf-8", "surrogateescape"), 0o600)
    summary["written"] = not dry
    return summary


def _shell_value(rest: str) -> str:
    """The value a POSIX shell assigns for `KEY<rest>` (rest starts with '='):
    quotes removed, `# comment` after whitespace dropped, backslash escapes
    honoured. Variable expansion is NOT performed (the owner's files don't use
    it; preflight warns when a value references one)."""
    raw = rest[1:]
    if not raw.strip():
        return ""
    lex = shlex.shlex(raw, posix=True)
    lex.whitespace_split = True
    lex.commenters = "#"
    try:
        words = list(lex)
    except ValueError:  # unbalanced quote: fall back to the raw text
        return raw.strip()
    # `KEY=a b` assigns only `a` in a shell; keep the first word
    return words[0] if words else ""


def env_get(path: str, key: str) -> str:
    """Value of KEY as `set -a; . file` would see it (last assignment wins).
    Handles `export KEY=...`, leading whitespace, quotes and inline comments.
    Used only to feed a password or token into another process without
    printing it."""
    val = ""
    with open(path, "rb") as f:
        for raw in f.read().decode("utf-8", "surrogateescape").splitlines():
            m = ENV_LINE.match(raw)
            if m and m.group("key") == key:
                val = _shell_value(m.group("rest"))
    return val


def env_has(path: str, key: str) -> bool:
    return key in env_keys(path)


def rename_dir(old: str, new: str) -> str:
    """rename(2) old -> new WITHOUT ever nesting old inside new.

    `mv old new` moves old INTO new when new is an existing directory — that is
    how the state ended up at ~/.pal/.lantern on the live cutover. os.rename
    never does that: it replaces an EMPTY directory and fails (ENOTEMPTY /
    EEXIST / ENOTDIR) on anything else, so a target that appears between the
    preflight check and the move turns into a clean failure."""
    if os.path.islink(new):
        raise SystemExit(f"target {new} is a symlink")
    if os.path.isdir(new) and os.listdir(new):
        raise SystemExit(f"target {new} exists and is not empty: {sorted(os.listdir(new))[:10]}")
    os.rename(old, new)
    return "renamed"


# ---------------------------------------------------------------- plists
def _load(path: str) -> dict:
    with open(path, "rb") as f:
        return plistlib.load(f)


def _subst(value, maps):
    if isinstance(value, str):
        for a, b in maps:
            value = value.replace(a, b)
        return value
    if isinstance(value, list):
        return [_subst(v, maps) for v in value]
    if isinstance(value, dict):
        return {k: _subst(v, maps) for k, v in value.items()}
    return value


def plist_convert(args: dict) -> dict:
    """Build the new agent plist.

    With a template (the release commit's dev.pal.<svc>.plist, placeholders
    already substituted): the template is authoritative for structure and for
    every env key it defines; env keys present ONLY in the live plist (the
    owner's secrets/overrides: GOOGLE_CLIENT_SECRET, the signal token, the
    tunnel URL the watcher maintains, ...) are carried over with their key
    renamed and their value untouched — installing a bare template would
    silently drop them.

    Without a template (agents that exist only on this machine: tunnel,
    caffeinate, watchers): the live plist is converted in place — label,
    log/state paths, label references in arguments, env key prefix.
    """
    old = _load(args["old"])
    old_env = old.get("EnvironmentVariables", {}) or {}
    op, np_ = args["old_env"], args["new_env"]
    maps = [tuple(m.split("=", 1)) for m in args["maps"]]
    renamed_env = {}
    renamed_keys = []
    for k, v in old_env.items():
        nk = np_ + k[len(op):] if k.startswith(op) else k
        if nk != k:
            renamed_keys.append(k)
        renamed_env[nk] = v
    if args.get("template"):
        new = _load(args["template"])
        # a fallback template that still uses the old prefix gets renamed too
        tenv = {(np_ + k[len(op):] if k.startswith(op) else k): v
                for k, v in (new.get("EnvironmentVariables", {}) or {}).items()}
        wins = set((args.get("template_wins") or "").split())
        carried = sorted(k for k in renamed_env if k not in tenv)
        differ = [k for k in renamed_env if k in tenv and tenv[k] != renamed_env[k]]
        overridden = sorted(k for k in differ if k in wins)      # template value used
        kept_live = sorted(k for k in differ if k not in wins)   # deliberate local override kept
        for k in carried + kept_live:
            tenv[k] = renamed_env[k]
        if tenv:
            new["EnvironmentVariables"] = tenv
        source = "template"
    else:
        new = dict(old)
        for key in ("ProgramArguments", "Program", "WorkingDirectory", "StandardOutPath", "StandardErrorPath"):
            if key in new:
                new[key] = _subst(new[key], maps)
        if renamed_env:
            new["EnvironmentVariables"] = renamed_env
        carried, overridden, kept_live = sorted(renamed_env), [], []
        source = "converted-live"
    new["Label"] = args["label"]
    data = plistlib.dumps(new, fmt=plistlib.FMT_XML, sort_keys=True)
    if not args.get("dry"):
        _write_atomic(args["out"], data, 0o600)
    return {
        "label": args["label"],
        "source": source,
        "env_keys_renamed": sorted(renamed_keys),
        "env_keys_carried_from_live": carried,
        "env_keys_where_template_wins": overridden,
        "env_keys_live_override_kept": kept_live,
        "stdout": new.get("StandardOutPath", ""),
    }


def plist_get(path: str, key: str) -> str:
    d = _load(path)
    if key.startswith("env:"):
        return str((d.get("EnvironmentVariables") or {}).get(key[4:], ""))
    v = d.get(key, "")
    if isinstance(v, list):
        return "\n".join(map(str, v))
    return str(v)


def url_part(url: str, part: str) -> str:
    u = urlsplit(url)
    return {
        "user": unquote(u.username or ""),
        "password": unquote(u.password or ""),
        "host": u.hostname or "",
        "port": str(u.port or ""),
        "db": u.path.lstrip("/"),
    }[part]


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2
    cmd, rest = argv[0], argv[1:]
    if cmd == "env-keys":
        print("\n".join(env_keys(rest[0])))
    elif cmd == "env-rename":
        path, old, new = rest[:3]
        s = env_rename(path, old, new, dry="--dry" in rest)
        print(json.dumps(s))
        return 3 if s["conflicts"] else 0
    elif cmd == "env-get":
        sys.stdout.write(env_get(rest[0], rest[1]))
    elif cmd == "env-has":
        return 0 if env_has(rest[0], rest[1]) else 1
    elif cmd == "rename-dir":
        try:
            print(rename_dir(rest[0], rest[1]))
        except OSError as e:
            print(f"rename failed: {e.strerror} ({rest[1]})", file=sys.stderr)
            return 1
        except SystemExit as e:
            print(f"rename refused: {e}", file=sys.stderr)
            return 1
    elif cmd == "plist-get":
        sys.stdout.write(plist_get(rest[0], rest[1]))
    elif cmd == "plist-env-keys":
        print("\n".join(sorted((_load(rest[0]).get("EnvironmentVariables") or {}).keys())))
    elif cmd == "plist-convert":
        a = {"maps": [], "dry": False, "template": None}
        it = iter(rest)
        for flag in it:
            if flag == "--dry":
                a["dry"] = True
            elif flag == "--map":
                a["maps"].append(next(it))
            else:
                a[flag.lstrip("-").replace("-", "_")] = next(it)
        print(json.dumps(plist_convert(a)))
    elif cmd == "url-part":
        sys.stdout.write(url_part(rest[0], rest[1]))
    else:
        print(f"unknown command {cmd}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
