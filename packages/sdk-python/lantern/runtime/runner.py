"""Agent runner — entry point executed inside the Firecracker sandbox.

The Lantern runtime invokes this as::

    lantern-runner --agent my-agent --input '{"key": "value"}'

Or via the ``LANTERN_AGENT_NAME`` / ``LANTERN_INPUT`` environment variables.

In dev mode you can also run directly::

    python -m lantern.runtime.runner --agent my-agent --input '{"name": "World"}'
"""

from __future__ import annotations

import argparse
import asyncio
import importlib
import json
import os
import sys
from pathlib import Path
from typing import Any

from lantern.agent import get_agent, list_agents
from lantern.runtime.context import build_dev_context, build_production_context
from lantern.runtime.runtime import RuntimeMode, detect_mode
from lantern.runtime.step_runtime import StepJournal, create_journal_step_runner, get_journal_path
from lantern.step import set_step_runtime


def _discover_agents(search_dir: str | None = None) -> None:
    """Import Python modules that might register agents via @agent or LanternAgent.

    Searches the current directory (or ``search_dir``) for ``*.py`` files
    and imports them so that decorators execute.
    """
    root = Path(search_dir) if search_dir else Path.cwd()

    # Add the directory to sys.path so imports work
    root_str = str(root)
    if root_str not in sys.path:
        sys.path.insert(0, root_str)

    for py_file in sorted(root.glob("**/*.py")):
        # Skip __pycache__, hidden dirs, test files
        parts = py_file.relative_to(root).parts
        if any(p.startswith(".") or p == "__pycache__" for p in parts):
            continue

        module_path = py_file.relative_to(root).with_suffix("")
        module_name = ".".join(module_path.parts)

        try:
            importlib.import_module(module_name)
        except Exception:
            # Skip modules that fail to import — they may have
            # dependencies not available in this environment.
            pass


async def run_agent(
    agent_name: str,
    input_data: dict[str, Any],
    *,
    search_dir: str | None = None,
) -> Any:
    """Run a registered agent by name.

    This is the main programmatic entry point. The CLI and the sandbox
    both call this.
    """
    # Discover agents in the filesystem
    _discover_agents(search_dir)

    registered = get_agent(agent_name)
    if registered is None:
        available = [a.config.name for a in list_agents()]
        raise RuntimeError(
            f"Agent {agent_name!r} not found. "
            f"Available agents: {available or '(none — did you forget to import your agent module?)'}"
        )

    mode = detect_mode()

    # Build context
    if mode == RuntimeMode.PRODUCTION:
        ctx = build_production_context(
            agent_name=registered.config.name,
            agent_version=registered.config.version,
        )
        # Install journal-aware step runner
        journal = StepJournal(get_journal_path())
        set_step_runtime(create_journal_step_runner(journal))
    else:
        ctx = build_dev_context(
            agent_name=registered.config.name,
            agent_version=registered.config.version,
        )

    ctx.log.info(f"Running agent {registered.config.name} v{registered.config.version} in {mode} mode")

    # Execute
    result = await registered.run(input_data, ctx)

    ctx.log.info(f"Agent completed successfully")
    return result


def main() -> None:
    """CLI entry point (``lantern-runner``)."""
    parser = argparse.ArgumentParser(
        description="Run a Lantern agent",
        prog="lantern-runner",
    )
    parser.add_argument(
        "--agent",
        default=os.environ.get("LANTERN_AGENT_NAME"),
        help="Agent name (or set LANTERN_AGENT_NAME)",
    )
    parser.add_argument(
        "--input",
        default=os.environ.get("LANTERN_INPUT", "{}"),
        help="JSON input (or set LANTERN_INPUT)",
    )
    parser.add_argument(
        "--dir",
        default=os.environ.get("LANTERN_AGENT_DIR"),
        help="Directory to search for agent modules",
    )

    args = parser.parse_args()

    if not args.agent:
        parser.error("--agent is required (or set LANTERN_AGENT_NAME)")

    try:
        input_data = json.loads(args.input)
    except json.JSONDecodeError as exc:
        parser.error(f"Invalid JSON input: {exc}")

    result = asyncio.run(run_agent(args.agent, input_data, search_dir=args.dir))

    # Output result as JSON to stdout
    print(json.dumps(result, default=str))


if __name__ == "__main__":
    main()
