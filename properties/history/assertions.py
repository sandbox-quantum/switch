"""The assertion log of a run: what the server's `always`, `sometimes`,
`reachable` and `unreachable` calls recorded.

Switch's assertions use the Antithesis SDK's API. Outside Antithesis the SDK
writes one JSON line per call to the file `ANTITHESIS_SDK_LOCAL_OUTPUT` names
and does nothing when it is unset; the fast lane sets it for the server it
starts. This reads that file after the run and fails it on

* an `always` (or `always_or_unreachable`) that was ever false,
* an `unreachable` that was reached,
* an id named by `--require` that was never satisfied: a `sometimes` that was
  never true, or a `reachable` never reached, or one never called at all,
  because the SDK logs only calls that happen.

    uv run --project core python properties/history/assertions.py \
        build/e2e/ephemeral/assertions.jsonl --require "id one" --require "id two"

An empty or missing log is an error: it means the server never wrote to it.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ALWAYS = {"Always", "AlwaysOrUnreachable"}
SATISFIED = {"Sometimes", "Reachable"}


def read(text: str) -> list[dict[str, Any]]:
    """The assertion records in a log, in order; the SDK's own header line and
    anything that is not a record are skipped, but a line that is not JSON is
    an error."""
    records = []
    for number, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"line {number} of the assertion log: {error}") from error
        record = parsed.get("antithesis_assert")
        if record is not None:
            records.append(record)
    return records


def problems(records: list[dict[str, Any]], required: list[str]) -> list[str]:
    found: list[str] = []
    satisfied: set[str] = set()
    for record in records:
        kind, message = record["display_type"], record["message"]
        if kind in ALWAYS and not record["condition"]:
            found.append(f"always: {message} was false, with {record['details']}")
        elif kind == "Unreachable" and record["hit"]:
            found.append(
                f"unreachable: {message} was reached, with {record['details']}"
            )
        elif kind in SATISFIED and record["condition"]:
            satisfied.add(message)
    found.extend(
        f"never satisfied: {message}"
        for message in required
        if message not in satisfied
    )
    return found


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("log", type=Path)
    parser.add_argument("--require", action="append", default=[])
    args = parser.parse_args(argv)
    if not args.log.is_file():
        print(f"assertions: {args.log} does not exist", file=sys.stderr)
        return 2
    records = read(args.log.read_text(encoding="utf-8"))
    if not records:
        print(
            f"assertions: {args.log} holds no assertion; was it set?", file=sys.stderr
        )
        return 2
    found = problems(records, args.require)
    for line in found:
        print(line)
    print(
        f"assertions: {len(records)} calls, {len({r['message'] for r in records})} "
        f"distinct, {len(args.require)} required: {len(found)} problems"
    )
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
