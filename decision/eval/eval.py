"""Run scenario sets against a decision service and print how it did.

    uv run python eval/eval.py [--url http://localhost:8230] [--file eval/scenarios_hard.json]
        [--all] [--threshold 0.6] [--backend anthropic] [--model NAME]

`--all` runs the standard sets (hard, extra60, names, followups) and ends with
one summary table. Each set reports right, wrong (the wrong agent, or an agent
when nobody should answer) and missed (nobody when an agent should answer),
and the precision of deliveries.

DECISION_SERVICE_TOKEN and ANTHROPIC_API_KEY are read from the environment when set.
"""

import argparse
import json
import os
import statistics
import sys
from dataclasses import dataclass, field
from pathlib import Path

import httpx

HERE = Path(__file__).parent
STANDARD = [
    "scenarios_hard.json",
    "scenarios_extra60.json",
    "scenarios_names.json",
    "scenarios_followups.json",
]


@dataclass
class Tally:
    right: int = 0
    wrong: int = 0
    missed: int = 0
    delivered: int = 0
    delivered_right: int = 0
    latencies: list[int] = field(default_factory=list)

    def add(self, picked: str | None, expect: list[str | None]) -> str:
        ok = picked in expect
        if picked is not None:
            self.delivered += 1
            self.delivered_right += ok
        if ok:
            self.right += 1
            return "PASS"
        if picked is None:
            self.missed += 1
            return "MISSED"
        self.wrong += 1
        return "WRONG"

    @property
    def total(self) -> int:
        return self.right + self.wrong + self.missed

    def precision(self) -> str:
        if not self.delivered:
            return "-"
        return f"{self.delivered_right}/{self.delivered} = {self.delivered_right / self.delivered:.2f}"


def request_body(data: dict, scenario: dict, threshold: float | None) -> dict:
    body = {
        "room": scenario.get("room", data["room"]),
        "agents": scenario.get("agents", data["agents"]),
        "message": scenario["message"],
        "recent": scenario.get("background", []) + scenario.get("recent", []),
        "thread": scenario.get("thread", []),
    }
    if threshold is not None:
        body["confidence_threshold"] = threshold
    return body


def run_file(
    client: httpx.Client, url: str, path: Path, threshold: float | None, quiet: bool
) -> Tally:
    data = json.loads(path.read_text())
    tally = Tally()
    rows = []
    for s in data["scenarios"]:
        r = client.post(f"{url}/decide", json=request_body(data, s, threshold))
        r.raise_for_status()
        out = r.json()
        outcome = tally.add(out["agent"], s["expect"])
        tally.latencies.append(out["latency_ms"])
        rows.append(
            (
                s["id"],
                "/".join(str(e) for e in s["expect"]),
                str(out["agent"]),
                out["model_choice"],
                f"{out['confidence']:.2f}",
                out["latency_ms"],
                outcome,
                (out.get("reason") or "")[:90],
            )
        )
    if not quiet:
        w = [max(len(str(r[i])) for r in rows) for i in range(7)]
        for r in rows:
            print(
                "  ".join(str(c).ljust(w[i]) for i, c in enumerate(r[:7])) + "  " + r[7]
            )
    print(
        f"\n{path.name}: right {tally.right}/{tally.total}  wrong {tally.wrong}  missed {tally.missed}"
        f"  precision of deliveries {tally.precision()}"
        f"  median latency {statistics.median(tally.latencies)} ms  max {max(tally.latencies)} ms\n"
    )
    return tally


def summary(results: dict[str, Tally]) -> str:
    lines = ["| set | right | wrong | missed | precision |", "|---|---|---|---|---|"]
    for name, t in results.items():
        lines.append(
            f"| {name} | {t.right}/{t.total} | {t.wrong} | {t.missed} | {t.precision()} |"
        )
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8230")
    ap.add_argument("--threshold", type=float, default=None)
    ap.add_argument("--file", default=str(HERE / "scenarios.json"))
    ap.add_argument(
        "--all",
        action="store_true",
        help="run the standard sets and print a summary table",
    )
    ap.add_argument(
        "--backend",
        default=None,
        help="sent as X-Decision-Backend (default, anthropic, bedrock)",
    )
    ap.add_argument("--model", default=None, help="sent as X-Decision-Model")
    args = ap.parse_args()
    headers = {}
    if token := os.environ.get("DECISION_SERVICE_TOKEN"):
        headers["Authorization"] = f"Bearer {token}"
    if args.backend:
        headers["X-Decision-Backend"] = args.backend
        if args.backend == "anthropic" and os.environ.get("ANTHROPIC_API_KEY"):
            headers["X-Decision-Anthropic-Key"] = os.environ["ANTHROPIC_API_KEY"]
    if args.model:
        headers["X-Decision-Model"] = args.model
    files = [HERE / f for f in STANDARD] if args.all else [Path(args.file)]
    results = {}
    with httpx.Client(headers=headers, timeout=120) as client:
        for path in files:
            results[path.name] = run_file(
                client, args.url, path, args.threshold, quiet=args.all
            )
    if args.all:
        print(summary(results))
    return 0 if all(t.right == t.total for t in results.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
