"""Smallest possible Lantern agent — echoes input + timestamp.

Reads JSON from stdin, writes one line to stdout, exits 0. The harness
binary (PID 1 in the VM) tails this process's stdout and forwards each
line to the runtime-manager as a structured log.
"""

import json
import os
import sys
import time


def main() -> int:
    # Standard Lantern envelope: tenant + run identifiers come from env,
    # set by the harness based on the AgentSpec the scheduler bound.
    run_id = os.environ.get("LANTERN_RUN_ID", "unknown")
    vm_id = os.environ.get("LANTERN_VM_ID", "unknown")

    raw = sys.stdin.read().strip()
    try:
        payload = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        print(
            json.dumps({"level": "error", "msg": "invalid json on stdin"}),
            file=sys.stderr,
        )
        return 2

    name = payload.get("name", "world")
    line = {
        "level": "info",
        "ts": time.time(),
        "msg": f"hello {name}",
        "run_id": run_id,
        "vm_id": vm_id,
    }
    # One line of JSON on stdout — the harness's log forwarder will
    # detect the JSON shape and ship attrs to runtime_audit_events.
    print(json.dumps(line), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
