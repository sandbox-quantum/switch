#!/usr/bin/env bash
# Start one switch-core replica of a two-replica stack, from this checkout:
# for `ephemeral-stack.sh --replicas 2`, and for the harness starting a replica
# again after a fault (`src/clients/replicas.ts`).
#
#   replica.sh <n>        n is 1 or 2
#
# Replica n serves :800n, with collaboration callbacks on :809n, and goes by
# the process id `replica-n-<suffix>` (POD_NAME), so the rows a process writes
# (its lease, the work it owns) say which replica wrote them. Its log is
# appended to switch-core-n.log, so one file holds every life of the replica.
#
# Runs the virtual environment's Python directly rather than through `uv run`,
# so the pid written to <n>.pid is the server's own and a signal sent to it
# reaches the server, not a wrapper.
#
# Needs the stack's environment, exported (the env file `ephemeral-stack.sh`
# generates), and:
#   SWITCH_E2E_REPLICAS_DIR    where <n>.pid is written
#   SWITCH_E2E_REPLICA_LOGS    where the logs and the shared assertion log go
set -euo pipefail

n="${1:?usage: replica.sh <n>}"
case "$n" in 1|2) ;; *) echo "replica.sh: no replica $n (1 or 2)" >&2; exit 2 ;; esac
: "${SWITCH_E2E_REPLICAS_DIR:?replica.sh: SWITCH_E2E_REPLICAS_DIR is not set}"
: "${SWITCH_E2E_REPLICA_LOGS:?replica.sh: SWITCH_E2E_REPLICA_LOGS is not set}"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PYTHON="$REPO/core/.venv/bin/python"
[ -x "$PYTHON" ] || { echo "replica.sh: no virtual environment at $REPO/core/.venv (uv sync --project core)" >&2; exit 1; }

port=$((8000 + n))
log="$SWITCH_E2E_REPLICA_LOGS/switch-core-$n.log"
pidfile="$SWITCH_E2E_REPLICAS_DIR/$n.pid"

if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
  echo "replica.sh: replica $n is already running (pid $(cat "$pidfile"))" >&2
  exit 1
fi

cd "$REPO"
ANTITHESIS_SDK_LOCAL_OUTPUT="$SWITCH_E2E_REPLICA_LOGS/assertions.jsonl" \
POD_NAME="replica-$n" \
SERVER_PORT="$port" COLLABORATION_CALLBACK_PORT=$((8090 + n)) \
GATEWAY_COOKIE_SECURE=false LOG_FORMAT=json \
  nohup "$PYTHON" -m switch_core.main >>"$log" 2>&1 </dev/null &
echo $! >"$pidfile"

for _ in $(seq 120); do
  curl -sf "localhost:$port/health" >/dev/null && exit 0
  kill -0 "$(cat "$pidfile")" 2>/dev/null \
    || { echo "replica.sh: replica $n exited while starting; see $log" >&2; exit 1; }
  sleep 1
done
echo "replica.sh: replica $n did not come up on :$port; see $log" >&2
exit 1
