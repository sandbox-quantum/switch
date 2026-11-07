#!/usr/bin/env python3
"""Run the Quint models: check the invariants, and see each fail on its bug.

    python3 properties/specs/run.py verify            # every check must pass
    python3 properties/specs/run.py verify --deep     # and the larger bounds
    python3 properties/specs/run.py mutants           # every mutant must be caught
    python3 properties/specs/run.py                   # verify and mutants

`verify` has TLC search every state `delivery.qnt` can reach in the bounds
`configs.qnt` gives a module, and checks each invariant in all of them. It is
exhaustive in those bounds and says nothing about more rooms, agents, rows or
writers. `mutants` does the same on a module with one behaviour that is not in
the code switched on, and expects the named invariant to be violated: an
invariant that holds on a system with that bug could not have caught it. Both
need `quint` and Java.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

SPECS = Path(__file__).resolve().parent

INVARIANTS = [
    "RoomSeqDense",
    "DecidedAtWrite",
    "OwnSeqContiguous",
    "AddressedExactlyOnce",
    "NoEventsAfterLeave",
    "NoSilentLoss",
]

# Modules in configs.qnt whose every invariant must hold, and the ones that
# take minutes.
CHECKS = ["bus", "retention", "recipients"]
DEEP_CHECKS = ["recipients_deep"]

# (module in configs.qnt, the invariant it must violate)
MUTANTS = [
    ("mutant_room_seq_from_counter", "RoomSeqDense"),
    ("mutant_late_delivery", "DecidedAtWrite"),
    ("mutant_number_from_highest_retained", "OwnSeqContiguous"),
    ("mutant_no_source_dedupe", "AddressedExactlyOnce"),
    ("mutant_forget_without_lock", "NoEventsAfterLeave"),
    ("mutant_store_skips_membership_recheck", "NoEventsAfterLeave"),
    ("mutant_expire_without_drop_mark", "NoSilentLoss"),
    ("mutant_own_seq_released_early", "NoSilentLoss"),
    ("mutant_created_at_transaction_start", "NoSilentLoss"),
]


def check(module: str, invariants: list[str]) -> tuple[str, str]:
    """What `quint verify` concluded for a module, from the JSON it writes with
    `--out` rather than from what it prints: `ok`, `violation`, or `error` when
    it concluded nothing (a type error, a crash of TLC or Java, a changed
    format), with whatever it said."""
    with tempfile.TemporaryDirectory() as work:
        report = Path(work) / "report.json"
        run = subprocess.run(
            [
                "quint",
                "verify",
                "--backend=tlc",
                f"--main={module}",
                "--init=init",
                "--step=step",
                f"--invariant={','.join(invariants)}",
                f"--out={report}",
                str(SPECS / "configs.qnt"),
            ],
            capture_output=True,
            text=True,
            cwd=work,
        )
        said = run.stdout + run.stderr
        try:
            result = json.loads(report.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            return "error", f"no report: {error}\n{said}"
    status = result.get("status")
    if result.get("stage") != "verifying":
        return (
            "error",
            f"stopped at {result.get('stage')}: {result.get('errors')}\n{said}",
        )
    if status == "ok" and run.returncode == 0:
        return "ok", said
    if status == "violation" and run.returncode != 0:
        return "violation", said
    return "error", f"status {status!r}, exit {run.returncode}\n{said}"


def verify(modules: list[str]) -> int:
    failures = 0
    for module in modules:
        status, said = check(module, INVARIANTS)
        if status == "ok":
            print(f"ok     {module}: {', '.join(INVARIANTS)}")
            continue
        failures += 1
        print(f"FAILED {module}: {status}", file=sys.stderr)
        print(said[-4000:], file=sys.stderr)
    return failures


def mutants() -> int:
    failures = 0
    for module, invariant in MUTANTS:
        status, said = check(module, [invariant])
        if status == "violation":
            print(f"ok     {module} violates {invariant}")
            continue
        failures += 1
        reason = (
            f"{invariant} held, so it cannot see this bug"
            if status == "ok"
            else "the check did not run to a conclusion"
        )
        print(f"FAILED {module}: {reason}", file=sys.stderr)
        print(said[-4000:], file=sys.stderr)
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "mode", nargs="?", choices=["verify", "mutants", "all"], default="all"
    )
    parser.add_argument("--deep", action="store_true", help="also the larger bounds")
    args = parser.parse_args()
    failures = 0
    if args.mode in ("verify", "all"):
        failures += verify(CHECKS + (DEEP_CHECKS if args.deep else []))
    if args.mode in ("mutants", "all"):
        failures += mutants()
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
