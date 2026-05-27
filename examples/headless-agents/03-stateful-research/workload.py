"""Stateful research demo — survives node failure via snapshot/restore.

Reads `{"topic": "...", "max_steps": 5}` from stdin. Maintains a
`./workspace/state.json` file with the running research plan + notes.
On SIGUSR1 (snapshot signal from harness), flushes state to disk and
acks. The harness then asks Firecracker to snapshot the VM; if the node
fails, the scheduler picks a new node and the workload resumes from
the same state.json.

Key contract with harness:
  * `LANTERN_RESTORE_HINT` env is set when the VM was restored from a
    snapshot — workload uses it to know it should pick up where it
    left off instead of starting fresh.
  * SIGUSR1 handler flushes + ACKs by writing "ready" to
    `/run/lantern/snapshot.ready`. Harness then triggers Firecracker.
"""

from __future__ import annotations

import json
import os
import signal
import sys
import time
from pathlib import Path

WORKSPACE = Path("./workspace")
STATE = WORKSPACE / "state.json"
SNAPSHOT_READY = Path("/run/lantern/snapshot.ready")

_paused = False


def load_state() -> dict:
    if STATE.exists():
        return json.loads(STATE.read_text())
    return {"topic": None, "step": 0, "notes": [], "started_at": time.time()}


def save_state(state: dict) -> None:
    WORKSPACE.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, indent=2))


def handle_snapshot(_signum: int, _frame) -> None:
    """Harness wants to snapshot — flush, ack, then pause until resumed."""
    global _paused
    state = load_state()
    save_state(state)
    SNAPSHOT_READY.parent.mkdir(parents=True, exist_ok=True)
    SNAPSHOT_READY.write_text("ready")
    print(json.dumps({"level": "info", "msg": "snapshot ack — paused"}), flush=True)
    _paused = True


def research_step(state: dict, topic: str) -> dict:
    """Stub for one research iteration — real version would call the LLM + fetch arxiv."""
    state["step"] += 1
    state["notes"].append(f"step {state['step']} thought about {topic}")
    return state


def main() -> int:
    signal.signal(signal.SIGUSR1, handle_snapshot)

    restore_hint = os.environ.get("LANTERN_RESTORE_HINT", "")
    state = load_state()

    if restore_hint:
        print(
            json.dumps(
                {
                    "level": "info",
                    "msg": "restored from snapshot",
                    "step": state["step"],
                }
            ),
            flush=True,
        )
    else:
        payload = json.loads(sys.stdin.read() or "{}")
        state["topic"] = payload.get("topic", "Firecracker microVMs")
        max_steps = int(payload.get("max_steps", 5))
        state["max_steps"] = max_steps
        save_state(state)

    while state["step"] < state.get("max_steps", 5):
        # Block while harness has us paused for snapshot.
        while _paused:
            time.sleep(0.1)
        state = research_step(state, state["topic"])
        save_state(state)
        print(
            json.dumps(
                {"level": "info", "step": state["step"], "msg": state["notes"][-1]}
            ),
            flush=True,
        )
        time.sleep(2)  # simulate real work; gives the snapshot signal a window to land

    print(
        json.dumps({"level": "info", "msg": "done", "final_notes": state["notes"]}),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
