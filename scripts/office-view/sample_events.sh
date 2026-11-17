#!/usr/bin/env bash
# sample_events.sh — drive a short scripted scene into a running office, as a
# smoke test of the office-view event mapping (no Switch needed).
#
#   scripts/office-view/office.sh start
#   scripts/office-view/sample_events.sh            # the scene, ~40 s
#   scripts/office-view/sample_events.sh --end      # ...then both agents clock out
#
# The scene: two named agents (Ada, Bob) get desks; the boss prompts Ada, who
# works and sends a worker in and out; the boss prompts Bob, whose hand goes up
# for an approval and comes down when it is settled; both reply in the chat (session_turn_end text), and a plain
# chat line goes in through POST /chat.
#
# Environment: OFFICE_PORT (3334), OFFICE_HOME (~/.cache/switch-office-view/home),
# PAUSE (seconds between beats, default 3).

set -euo pipefail

OFFICE_PORT="${OFFICE_PORT:-3334}"
OFFICE_HOME="${OFFICE_HOME:-$HOME/.cache/switch-office-view/home}"
TOKEN_FILE="$OFFICE_HOME/.agent-office/auth-token"
BASE_URL="http://127.0.0.1:$OFFICE_PORT"
PAUSE="${PAUSE:-3}"
END=0
[[ "${1:-}" == "--end" ]] && END=1

[[ -s "$TOKEN_FILE" ]] || { echo "sample_events.sh: no token at $TOKEN_FILE (run office.sh start)" >&2; exit 1; }
TOKEN="$(cat "$TOKEN_FILE")"

# A run-unique suffix, so a second run gets fresh sessions and workers
RUN="$(date +%s)"
ADA="sess-ada-$RUN"
BOB="sess-bob-$RUN"
WORKER="sub-ada-$RUN"

beat() { echo "$(date +%T) $*"; }
pause() { sleep "${1:-$PAUSE}"; }

event() {
  local out
  out="$(curl -sS --max-time 5 -X POST "$BASE_URL/event" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$1" -w ' %{http_code}')"
  [[ "$out" == *" 200" ]] || { echo "sample_events.sh: POST /event failed: $out" >&2; echo "  body: $1" >&2; exit 1; }
}

chat() {
  local out
  out="$(curl -sS --max-time 5 -X POST "$BASE_URL/chat" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg s "$1" --arg t "$2" '{sender:$s, text:$t}')" -w ' %{http_code}')"
  [[ "$out" == *" 200" ]] || { echo "sample_events.sh: POST /chat failed: $out" >&2; exit 1; }
}

beat "two agents get desks: Ada, Bob"
event "{\"type\":\"session_started\",\"sessionId\":\"$ADA\",\"project\":\"Ada\",\"source\":\"startup\"}"
event "{\"type\":\"session_started\",\"sessionId\":\"$BOB\",\"project\":\"Bob\",\"source\":\"startup\"}"
pause

beat "the boss prompts Ada; Ada types"
event "{\"type\":\"session_prompt\",\"sessionId\":\"$ADA\",\"text\":\"Can you find out why the billing tests fail on main?\"}"
pause 1
event "{\"type\":\"agent_working\",\"sessionId\":\"$ADA\",\"status\":\"running uv run pytest tests/billing\",\"tool\":\"Bash\"}"
pause

beat "Ada sends a worker in"
event "{\"type\":\"agent_spawned\",\"sessionId\":\"$ADA\",\"agent\":{\"id\":\"$WORKER\",\"name\":\"Explore\",\"role\":\"general-purpose\",\"task\":\"find the failing billing tests\"}}"
pause 2
event "{\"type\":\"agent_working\",\"sessionId\":\"$ADA\",\"agentId\":\"$WORKER\",\"status\":\"reading tests/billing/test_invoice.py\",\"tool\":\"Read\"}"
pause

beat "the boss prompts Bob; Bob types"
event "{\"type\":\"session_prompt\",\"sessionId\":\"$BOB\",\"text\":\"Please publish the docs preview.\"}"
pause 1
event "{\"type\":\"agent_working\",\"sessionId\":\"$BOB\",\"status\":\"building the docs\",\"tool\":\"Bash\"}"
pause

beat "Bob waits on an approval: hand up"
event "{\"type\":\"session_needs_you\",\"sessionId\":\"$BOB\",\"kind\":\"permission\",\"toolName\":\"Bash\",\"summary\":\"publish the docs preview\"}"
pause 6

beat "the approval is settled: hand down"
event "{\"type\":\"session_tool_done\",\"sessionId\":\"$BOB\",\"toolName\":\"Bash\"}"
pause

beat "Ada's worker walks out; Ada's tests pass"
event "{\"type\":\"agent_completed\",\"sessionId\":\"$ADA\",\"agentId\":\"$WORKER\",\"result\":\"two tests use a stale fixture\"}"
event "{\"type\":\"session_tool_done\",\"sessionId\":\"$ADA\",\"toolName\":\"Bash\"}"
event "{\"type\":\"signal\",\"sessionId\":\"$ADA\",\"signals\":[{\"kind\":\"test_ok\",\"target\":\"billing\"}]}"
pause

# Replies ride on session_turn_end's text: the chat shows them as "Claude · Ada"
# (the session's project). A POST /chat line would not carry the name: the page
# shows a plain line's sender as "Claude" or a random working worker.
beat "Ada replies; Bob replies"
event "{\"type\":\"session_turn_end\",\"sessionId\":\"$ADA\",\"text\":\"Found it: two billing tests used a stale fixture. Fixed, and the suite passes.\"}"
pause 2
event "{\"type\":\"session_turn_end\",\"sessionId\":\"$BOB\",\"text\":\"The docs preview is published.\"}"
pause

beat "a plain chat line (POST /chat)"
chat "Switch" "Both asks are done."
pause

if (( END )); then
  beat "both agents clock out"
  event "{\"type\":\"session_ended\",\"sessionId\":\"$ADA\",\"reason\":\"other\"}"
  event "{\"type\":\"session_ended\",\"sessionId\":\"$BOB\",\"reason\":\"other\"}"
  pause
fi

beat "scene done"
