#!/usr/bin/env bash
# End-to-end proof for "follow the conversation", against a fresh local stack.
#
#   just e2e-follow-ups            scenarios, report and screenshots
#   just e2e-follow-ups --video    the same, plus a captioned demo video (needs ffmpeg)
#   just e2e-follow-ups --keep     leave the stack and a playground room running afterwards
#
# It starts its own Postgres and Mattermost (Docker Compose project
# "switch-e2e") and its own switch-core on :8000, so stop your local stack
# first (`just down`, and any `just run`). Everything it writes goes to
# build/e2e/follow-the-conversation/. It exits non-zero if any scenario fails.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
HERE="$REPO/core/tests/e2e/follow_the_conversation"
OUT="${E2E_OUT:-$REPO/build/e2e/follow-the-conversation}"
export E2E_OUT="$OUT"
VIDEO=0
KEEP=0
for arg in "$@"; do
  case "$arg" in
    --video) VIDEO=1 ;;
    --keep) KEEP=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

cd "$REPO"
[ -f .env ] || { echo "No .env: run 'just init-env' first." >&2; exit 1; }
for port in 5432 8000 8065 8081; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is in use. Stop your local stack first ('just down', and any 'just run')." >&2
    exit 1
  fi
done
if [ "$VIDEO" = 1 ] && ! command -v ffmpeg >/dev/null; then
  echo "--video needs ffmpeg on PATH." >&2
  exit 1
fi

set -a; source .env; set +a
COMPOSE=(docker compose -p switch-e2e -f deploy/local/docker-compose.yml --project-directory .)
SERVER_PID=""
AGENTS_PID=""
stop_server() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null && wait "$SERVER_PID" 2>/dev/null; SERVER_PID=""; return 0; }
stop_agents() { [ -n "$AGENTS_PID" ] && kill "$AGENTS_PID" 2>/dev/null; AGENTS_PID=""; return 0; }
cleanup() {
  if [ "$KEEP" = 0 ]; then
    stop_agents; stop_server
    "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

start_server() {  # $1 = follow-up window in seconds
  FEATURE_FLAGS_ENABLED=follow_the_conversation \
  FOLLOW_THE_CONVERSATION_WINDOW_SECONDS="$1" \
  GATEWAY_COOKIE_SECURE=false \
    uv run --project core python -m switch_core.main >> "$OUT/switch-core.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 120); do curl -sf localhost:8000/health >/dev/null && return 0; sleep 1; done
  echo "switch-core did not come up; see $OUT/switch-core.log" >&2; exit 1
}
start_agents() {
  stop_agents
  uv run --project core python "$HERE/harness.py" agents > "$OUT/agents.log" 2>&1 &
  AGENTS_PID=$!
  sleep 8
}

rm -rf "$OUT"; mkdir -p "$OUT"
echo "Starting a fresh stack (Postgres, Mattermost)…"
"${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
"${COMPOSE[@]}" up -d --build >/dev/null
sleep 5
uv run --project core alembic -c core/alembic.ini upgrade head >/dev/null

start_server 20
for _ in $(seq 90); do
  "${COMPOSE[@]}" logs setup 2>&1 | grep -q "Setup complete" && break; sleep 2
done
echo "Setting up test agents and rooms…"
uv run --project core python "$HERE/harness.py" setup > "$OUT/rooms.json"
uv run --project core python "$HERE/harness.py" playground >> "$OUT/rooms.json"
start_agents

echo "Playing the scenarios…"
status=0
uv run --project core python "$HERE/harness.py" run || status=$?
uv run --project core python "$HERE/screenshots.py" >/dev/null || echo "screenshots failed (the report still stands)" >&2

if [ "$VIDEO" = 1 ]; then
  echo "Recording the demo video…"
  stop_agents; stop_server
  start_server 60
  start_agents
  FOLLOW_THE_CONVERSATION_WINDOW_SECONDS=60 uv run --project core python "$HERE/video.py"
fi

if [ "$KEEP" = 1 ]; then
  stop_agents; stop_server
  start_server 60
  start_agents
  echo "Left running: Mattermost http://localhost:8065 (user / MATTERMOST_USER_PASSWORD), follow-up window 60s."
fi
echo "Report: $OUT/report.md"
exit "$status"
