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


def check(module: str, invariants: list[str]) -> tuple[int, str]:
    with tempfile.TemporaryDirectory() as out:
        run = subprocess.run(
            [
                "quint",
                "verify",
                "--backend=tlc",
                f"--main={module}",
                "--init=init",
                "--step=step",
                f"--invariant={','.join(invariants)}",
                str(SPECS / "configs.qnt"),
            ],
            capture_output=True,
            text=True,
            cwd=out,
        )
    return run.returncode, run.stdout + run.stderr


def verify(modules: list[str]) -> int:
    failures = 0
    for module in modules:
        code, output = check(module, INVARIANTS)
        if code == 0 and "[ok]" in output:
            print(f"ok     {module}: {', '.join(INVARIANTS)}")
            continue
        failures += 1
        print(f"FAILED {module}", file=sys.stderr)
        print(output[-4000:], file=sys.stderr)
    return failures


def mutants() -> int:
    failures = 0
    for module, invariant in MUTANTS:
        code, output = check(module, [invariant])
        if "found a counterexample" in output:
            print(f"ok     {module} violates {invariant}")
            continue
        failures += 1
        print(
            f"FAILED {module}: {invariant} was not violated "
            "(the invariant cannot see this bug)",
            file=sys.stderr,
        )
        print(output[-4000:], file=sys.stderr)
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
