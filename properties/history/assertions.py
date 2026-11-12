"""The assertion log of a run: what the server's `always`, `sometimes`,
`reachable` and `unreachable` calls recorded.

Switch's assertions use the Antithesis SDK's API. Outside Antithesis the SDK
writes one JSON line per call to the file `ANTITHESIS_SDK_LOCAL_OUTPUT` names
and does nothing when it is unset; the fast lane sets it for the server it
starts. This reads that file after the run and fails it on

* an `always` (or `always_or_unreachable`) that was ever false,
* an `unreachable` that was reached,
* a message named by `--require` that was never satisfied: a `sometimes` that
  was never true, or a `reachable` never reached, or one never called at all,
* a message named by `--called` that no call made, which says the code that
  makes it was not reached or is no longer there.

    uv run --project core python properties/history/assertions.py \
        build/e2e/ephemeral/assertions.jsonl --require "id one" --require "id two"

A log with no SDK header line is an error: the server never wrote to it. One
with a header and no records is not; `--called` is how a run says it expected
some.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

RECORD_KEYS = ("display_type", "message", "condition", "hit")
ALWAYS = {"Always", "AlwaysOrUnreachable"}
SATISFIED = {"Sometimes", "Reachable"}


def read(text: str) -> tuple[bool, list[dict[str, Any]]]:
    """Whether the SDK's header line is there (so the server wrote to the file
    at all) and the assertion records, in order. A line that is not JSON, or a
    record without the fields below, is an error naming the line."""
    header = False
    records = []
    for number, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"line {number} of the assertion log: {error}") from error
        header = header or "antithesis_sdk" in parsed
        record = parsed.get("antithesis_assert")
        if record is None:
            continue
        absent = [key for key in RECORD_KEYS if key not in record]
        if absent:
            raise ValueError(
                f"line {number} of the assertion log has no {', '.join(absent)}: "
                f"{line[:200]}"
            )
        records.append(record)
    return header, records


def problems(
    records: list[dict[str, Any]], required: list[str], called: list[str]
) -> list[str]:
    found: list[str] = []
    satisfied: set[str] = set()
    for record in records:
        kind, message = record["display_type"], record["message"]
        details = record.get("details")
        if kind in ALWAYS and not record["condition"]:
            found.append(f"always: {message} was false, with {details}")
        elif kind == "Unreachable" and record["hit"]:
            found.append(f"unreachable: {message} was reached, with {details}")
        elif kind in SATISFIED and record["condition"]:
            satisfied.add(message)
    found.extend(
        f"never satisfied: {message}"
        for message in required
        if message not in satisfied
    )
    seen = {record["message"] for record in records if record["hit"]}
    found.extend(
        f"never called: {message}" for message in called if message not in seen
    )
    return found


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("log", type=Path)
    parser.add_argument("--require", action="append", default=[])
    parser.add_argument("--called", action="append", default=[])
    args = parser.parse_args(argv)
    if not args.log.is_file():
        print(f"assertions: {args.log} does not exist", file=sys.stderr)
        return 2
    try:
        header, records = read(args.log.read_text(encoding="utf-8"))
    except ValueError as error:
        print(f"assertions: {error}", file=sys.stderr)
        return 2
    if not header:
        print(
            f"assertions: {args.log} is empty; did the server write to it?",
            file=sys.stderr,
        )
        return 2
    found = problems(records, args.require, args.called)
    for line in found:
        print(line)
    print(
        f"assertions: {len(records)} calls, {len({r['message'] for r in records})} "
        f"distinct, {len(args.require)} required, {len(args.called)} expected "
        f"called: {len(found)} problems"
    )
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
