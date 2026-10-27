"""Run every scenario against a decision service and print how it did.

    uv run python eval/eval.py [--url http://localhost:8230] [--file eval/scenarios_hard.json]
        [--threshold 0.6] [--backend anthropic]

DECISION_SERVICE_TOKEN and ANTHROPIC_API_KEY are read from the environment when set.
"""

import argparse
import json
import os
import statistics
import sys
from pathlib import Path

import httpx


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8230")
    ap.add_argument("--threshold", type=float, default=None)
    ap.add_argument("--file", default=str(Path(__file__).with_name("scenarios.json")))
    ap.add_argument(
        "--backend",
        default=None,
        help="sent as X-Decision-Backend (default, anthropic, bedrock)",
    )
    ap.add_argument("--model", default=None, help="sent as X-Decision-Model")
    args = ap.parse_args()
    data = json.load(open(args.file))
    headers = {}
    if token := os.environ.get("DECISION_SERVICE_TOKEN"):
        headers["Authorization"] = f"Bearer {token}"
    if args.backend:
        headers["X-Decision-Backend"] = args.backend
        if args.backend == "anthropic" and os.environ.get("ANTHROPIC_API_KEY"):
            headers["X-Decision-Anthropic-Key"] = os.environ["ANTHROPIC_API_KEY"]
    if args.model:
        headers["X-Decision-Model"] = args.model
    rows, latencies = [], []
    correct = routed = routed_right = 0
    for s in data["scenarios"]:
        body = {
            "room": data["room"],
            "agents": data["agents"],
            "message": s["message"],
            "recent": s.get("recent", []),
            "thread": s.get("thread", []),
        }
        if args.threshold is not None:
            body["confidence_threshold"] = args.threshold
        r = httpx.post(f"{args.url}/decide", json=body, headers=headers, timeout=120)
        r.raise_for_status()
        out = r.json()
        ok = out["agent"] in s["expect"]
        correct += ok
        if out["agent"] is not None:
            routed += 1
            routed_right += ok
        latencies.append(out["latency_ms"])
        rows.append(
            (
                s["id"],
                "/".join(str(e) for e in s["expect"]),
                str(out["agent"]),
                out["model_choice"],
                f"{out['confidence']:.2f}",
                out["latency_ms"],
                "PASS" if ok else "FAIL",
                out["reason"][:90],
            )
        )
    w = [max(len(str(r[i])) for r in rows) for i in range(7)]
    for r in rows:
        print("  ".join(str(c).ljust(w[i]) for i, c in enumerate(r[:7])) + "  " + r[7])
    n = len(rows)
    print(
        f"\ncorrect {correct}/{n}  routed {routed}  precision of routed {routed_right}/{routed if routed else 1}"
        f"  median latency {statistics.median(latencies)} ms  max {max(latencies)} ms"
    )
    return 0 if correct == n else 1


if __name__ == "__main__":
    sys.exit(main())
