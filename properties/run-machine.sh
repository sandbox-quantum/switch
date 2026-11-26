#!/usr/bin/env bash
# Runs the Hypothesis state machines (core/tests/switch_core/properties) with the
# server's assertions logged, then checks the log: no false `always`, and every
# `sometimes` the machines are there to reach was reached.
#
#   properties/run-machine.sh [ci|nightly] [test file...] [pytest arguments...]
#
# The profile defaults to ci and sets HYPOTHESIS_PROFILE. With no test file, every
# machine runs; with some (paths from the repository root), only those. The tests
# run side by side (`-n auto`), and under nightly each machine's search is split
# into shards (core/tests/switch_core/properties/shards.py) so they do too.
#
# The `sometimes` required below are the delivery machine's, so they are required
# only when it runs. The SDK appends each record in one write, so the workers share
# the log. It reads ANTITHESIS_SDK_LOCAL_OUTPUT when it is first imported, so it is
# set for the whole pytest process rather than inside a test.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

profile="${1:-ci}"
shift || true
delivery=core/tests/switch_core/properties/test_delivery_machine.py
targets=()
rest=()
for arg in "$@"; do
  if [[ "$arg" != -* && -e "$arg" ]]; then
    targets+=("$arg")
  else
    rest+=("$arg")
  fi
done
delivery_requires=(--require "reached: a reader resumes from below a drop mark"
  --require "reached: an event is not stored for an agent that left the room or already has it")
requires=()
if [[ ${#targets[@]} -eq 0 ]]; then
  targets=(core/tests/switch_core/properties)
  requires=("${delivery_requires[@]}")
else
  for target in "${targets[@]}"; do
    [[ "$target" == "$delivery" ]] && requires=("${delivery_requires[@]}")
  done
fi

log="$PWD/build/properties/assertions.jsonl"
mkdir -p "$(dirname "$log")"
rm -f "$log"

HYPOTHESIS_PROFILE="$profile" ANTITHESIS_SDK_LOCAL_OUTPUT="$log" \
  uv run --project core pytest -c core/pyproject.toml "${targets[@]}" \
  -p no:cacheprovider -n auto ${rest[@]+"${rest[@]}"}

uv run --project core python properties/history/assertions.py "$log" ${requires[@]+"${requires[@]}"}
