"""ML inference demo — embeds input texts via sentence-transformers/MiniLM.

Proves:
  * GPU scheduling: requires `limits.gpu="1"` from the spec; scheduler
    routes to a node with available GPU capacity.
  * OTel traces: emits one span per inference batch through the unix
    socket the harness exposes at /run/lantern/otlp.sock.
  * Cost reporting: writes accumulated cost (in USD) to
    /run/lantern/cost.txt after each batch; harness reads + reports
    via Heartbeat.

Real Lantern image would have torch + onnxruntime-gpu + the model
weights baked in. For the demo we structure the code so the
inference loop is obvious; the encode() call is a stub that returns
a fixed-dim vector.
"""

from __future__ import annotations

import json
import socket
import sys
import time
from pathlib import Path

OTLP_SOCK = "/run/lantern/otlp.sock"
COST_FILE = Path("/run/lantern/cost.txt")
COST_PER_TOKEN_USD = 0.0000002  # 2e-7, ~ T4 cents/hr / typical throughput


def emit_span(name: str, attrs: dict) -> None:
    """Best-effort send of a minimal OTel-style JSON span to the harness socket.

    Real impl would use the opentelemetry-sdk. The harness translates
    these into proper OTLP spans and forwards to the control-plane.
    """
    payload = json.dumps({"span": name, "attrs": attrs, "ts": time.time()}).encode()
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        s.sendto(payload, OTLP_SOCK)
        s.close()
    except (FileNotFoundError, ConnectionRefusedError):
        # Harness not present (local dev); ignore.
        pass


def report_cost(total_usd: float) -> None:
    """Write running cost — harness polls this and reports via Heartbeat."""
    try:
        COST_FILE.parent.mkdir(parents=True, exist_ok=True)
        COST_FILE.write_text(f"{total_usd:.6f}\n")
    except OSError:
        pass


def encode(text: str) -> list[float]:
    """Stub for the real sentence-transformers call.

    In the real image:
        from sentence_transformers import SentenceTransformer
        model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2", device="cuda")
        return model.encode(text).tolist()
    """
    # Deterministic mock so the demo output is stable.
    h = abs(hash(text))
    return [((h >> i) & 0xFF) / 255.0 for i in range(0, 384, 1)][:384]


def main() -> int:
    t0 = time.time()
    emit_span("model.load", {"model": "all-MiniLM-L6-v2", "device": "cuda"})

    payload = json.loads(sys.stdin.read() or '{"texts": ["hello world"]}')
    texts = payload.get("texts", [])
    if not isinstance(texts, list) or not texts:
        print(json.dumps({"error": "texts must be a non-empty array"}), file=sys.stderr)
        return 2

    total_tokens = 0
    total_usd = 0.0
    embeddings = []

    for i, t in enumerate(texts):
        with_span_start = time.time()
        emb = encode(t)
        elapsed_ms = (time.time() - with_span_start) * 1000
        tokens_estimate = max(1, len(t) // 4)
        total_tokens += tokens_estimate
        total_usd += tokens_estimate * COST_PER_TOKEN_USD
        report_cost(total_usd)
        emit_span(
            "inference.encode",
            {
                "batch": i,
                "text_len": len(t),
                "tokens": tokens_estimate,
                "elapsed_ms": round(elapsed_ms, 2),
            },
        )
        embeddings.append({"text": t, "dim": len(emb), "sample": emb[:4]})

    result = {
        "count": len(embeddings),
        "total_tokens": total_tokens,
        "total_cost_usd": round(total_usd, 6),
        "wall_ms": round((time.time() - t0) * 1000, 2),
        "embeddings": embeddings,
    }
    print(json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
