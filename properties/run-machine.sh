#!/usr/bin/env bash
# Runs the Hypothesis state machines (core/tests/switch_core/properties) with the
# server's assertions logged, then checks the log: no false `always`, and every
# `sometimes` the machines are there to reach was reached.
#
#   properties/run-machine.sh [ci|nightly]     default ci; sets HYPOTHESIS_PROFILE
#
# The SDK reads ANTITHESIS_SDK_LOCAL_OUTPUT when it is first imported, so it is set
# for the whole pytest process rather than inside a test. Extra arguments go to pytest.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

profile="${1:-ci}"
shift || true
log="$PWD/build/properties/assertions.jsonl"
mkdir -p "$(dirname "$log")"
rm -f "$log"

HYPOTHESIS_PROFILE="$profile" ANTITHESIS_SDK_LOCAL_OUTPUT="$log" \
  uv run --project core pytest -c core/pyproject.toml core/tests/switch_core/properties \
  -p no:cacheprovider "$@"

uv run --project core python properties/history/assertions.py "$log" \
  --require "reached: a reader resumes from below a drop mark" \
  --require "reached: an event is not stored for an agent that left the room or already has it"
