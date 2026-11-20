#!/usr/bin/env bash
# office.sh — run the pinned W17ant/Claude-Office server, isolated, for the
# office-view demo.
#
#   office.sh start     fetch + build the pin if missing, start the server in
#                       the background, apply the quiet settings, check the
#                       version, print the URL and the token path
#   office.sh stop      stop the server this script started
#   office.sh reset     clear desks and chat history (office stopped) for a
#                       fresh recording
#   office.sh status    say whether it is running, and where
#   office.sh url       the office URL (add --token for the link that carries
#                       the office token in its fragment, which the page needs
#                       to show prompt text and to be trusted)
#
# Only `node server/index.js` is ever run. This script never runs the office's
# install-hooks / install-status-line, never starts its chat watchers, and
# never touches ~/.claude or ~/.agent-office: the server runs with HOME and
# AGENT_OFFICE_HOME inside the demo dir, and its Claude Code registry, task and
# team dirs point at empty dirs there too (otherwise the operator's own running
# Claude Code sessions would show up as desks).
#
# Environment (all optional):
#   OFFICE_PORT   loopback port, default 3334 (passed as AGENT_OFFICE_PORT)
#   OFFICE_HOME   demo dir, default ~/.cache/switch-office-view/home
#   OFFICE_CACHE  where the checkout lives, default ~/.cache/switch-office-view
#   OFFICE_SRC    the checkout to run, default $OFFICE_CACHE/Claude-Office@<pin>

set -euo pipefail
# The log holds the office link, token included: keep everything we write private
umask 077

# The one supported release. The adapter's event mapping was checked against it.
OFFICE_PIN="v1.3.0"
OFFICE_PIN_COMMIT="d49b0706807e84ff62702b02fcaf8587dae8a080"
OFFICE_VERSION="${OFFICE_PIN#v}"
OFFICE_REPO="https://github.com/W17ant/Claude-Office"

OFFICE_PORT="${OFFICE_PORT:-3334}"
OFFICE_CACHE="${OFFICE_CACHE:-$HOME/.cache/switch-office-view}"
OFFICE_HOME="${OFFICE_HOME:-$OFFICE_CACHE/home}"
OFFICE_SRC="${OFFICE_SRC:-$OFFICE_CACHE/Claude-Office@$OFFICE_PIN}"

RUNTIME_DIR="$OFFICE_HOME/.agent-office"   # AGENT_OFFICE_HOME: token, chat.db, settings
TOKEN_FILE="$RUNTIME_DIR/auth-token"
PID_FILE="$OFFICE_HOME/office.pid"
LOG_FILE="$OFFICE_HOME/office.log"
BASE_URL="http://127.0.0.1:$OFFICE_PORT"

die() { echo "office.sh: $*" >&2; exit 1; }
say() { echo "office.sh: $*"; }

[[ "$OFFICE_PORT" =~ ^[0-9]{1,5}$ ]] && (( OFFICE_PORT >= 1 && OFFICE_PORT <= 65535 )) \
  || die "OFFICE_PORT=$OFFICE_PORT is not a port (1-65535)"

running_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  # Only our server: a recycled pid running something else does not count
  ps -o command= -p "$pid" 2>/dev/null | grep -q "server/index.js" || return 1
  echo "$pid"
}

port_listener() {
  lsof -nP -iTCP:"$OFFICE_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true
}

fetch_pin() {
  if [[ -d "$OFFICE_SRC/.git" ]]; then
    return 0
  fi
  command -v git >/dev/null || die "git is needed to fetch $OFFICE_REPO"
  mkdir -p "$(dirname "$OFFICE_SRC")"
  say "fetching $OFFICE_REPO at $OFFICE_PIN into $OFFICE_SRC"
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$OFFICE_PIN" "$OFFICE_REPO" "$OFFICE_SRC"
  local head
  head="$(git -C "$OFFICE_SRC" rev-parse HEAD)"
  if [[ "$head" != "$OFFICE_PIN_COMMIT" ]]; then
    die "tag $OFFICE_PIN now points at $head, not $OFFICE_PIN_COMMIT; refusing to run a moved tag (remove $OFFICE_SRC to retry)"
  fi
}

build_if_needed() {
  command -v node >/dev/null || die "node (>= 22) is needed"
  command -v npm >/dev/null || die "npm is needed"
  if [[ ! -d "$OFFICE_SRC/node_modules/express" ]]; then
    say "installing the office's dependencies (once; no Electron download)"
    # The Electron binary is only for the desktop app, which we do not use
    (cd "$OFFICE_SRC" && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund --loglevel=error) \
      >>"$LOG_FILE" 2>&1 || die "npm ci failed; see $LOG_FILE"
  fi
  # better-sqlite3 ships prebuilt binaries; build it only if they do not load here
  if ! (cd "$OFFICE_SRC" && node -e "new (require('better-sqlite3'))(':memory:')") >/dev/null 2>&1; then
    say "building better-sqlite3 for this node"
    (cd "$OFFICE_SRC" && npm rebuild better-sqlite3) >>"$LOG_FILE" 2>&1 || die "better-sqlite3 build failed; see $LOG_FILE"
  fi
  if [[ ! -f "$OFFICE_SRC/dist/index.html" ]]; then
    say "building the office UI into dist/ (once)"
    (cd "$OFFICE_SRC" && npm run build) >>"$LOG_FILE" 2>&1 || die "npm run build failed; see $LOG_FILE"
  fi
}

# The server's health proof: HMAC-SHA256(token, "office-health:<challenge>").
# Only the process holding our token can answer it, so a squatter on the port
# never gets mistaken for our office.
health_ok() {
  [[ -s "$TOKEN_FILE" ]] || return 1
  local challenge want got
  challenge="$(openssl rand -hex 16)"
  want="$(printf 'office-health:%s' "$challenge" | openssl dgst -sha256 -hmac "$(cat "$TOKEN_FILE")" -r | cut -d' ' -f1)"
  got="$(curl -fsS --max-time 2 "$BASE_URL/health?challenge=$challenge" 2>/dev/null | jq -r '.proof // empty' 2>/dev/null || true)"
  [[ -n "$got" && "$got" == "$want" ]]
}

auth() { echo "Authorization: Bearer $(cat "$TOKEN_FILE")"; }

apply_quiet_settings() {
  # Server-side settings (POST /settings takes the office token):
  #   logPrompts=summary     the boss's shout and turn text, first 200 chars
  #   answerPermissions=false no Allow button that could answer anything
  #   notifyPermissions=false no OS notifications for permission waits
  curl -fsS --max-time 5 -X POST "$BASE_URL/settings" -H "$(auth)" -H 'Content-Type: application/json' \
    -d '{"logPrompts":"summary","answerPermissions":false,"notifyPermissions":false}' >/dev/null \
    || die "could not apply the quiet settings (POST /settings)"
  # The office's own AI chat monitor stays paused (it is never started anyway)
  curl -fsS --max-time 5 -X POST "$BASE_URL/chat/cron-state" -H 'Content-Type: application/json' \
    -d '{"paused":true}' >/dev/null || die "could not pause the chat monitor (POST /chat/cron-state)"
}

check_version() {
  local got
  got="$(curl -fsS --max-time 5 "$BASE_URL/config" | jq -r '.version // empty')" || true
  if [[ "$got" != "$OFFICE_VERSION" ]]; then
    die "the office on $BASE_URL is version ${got:-unknown}, but office-view supports only $OFFICE_VERSION (pin $OFFICE_PIN)"
  fi
}

cmd_start() {
  for tool in curl jq openssl lsof; do command -v "$tool" >/dev/null || die "$tool is needed"; done
  mkdir -p "$OFFICE_HOME"
  chmod 700 "$OFFICE_HOME"
  touch "$LOG_FILE" && chmod 600 "$LOG_FILE"
  if pid="$(running_pid)"; then
    say "already running (pid $pid)"
  else
    rm -f "$PID_FILE"
    local holder
    holder="$(port_listener)"
    [[ -z "$holder" ]] || die "port $OFFICE_PORT is already in use (pid $holder); stop it or set OFFICE_PORT"
    fetch_pin
    build_if_needed
    # Empty Claude Code dirs: the server's session registry, task board and
    # teams read from these instead of ~/.claude
    mkdir -p "$OFFICE_HOME/claude/sessions" "$OFFICE_HOME/claude/tasks" "$OFFICE_HOME/claude/teams"
    # A notify script that does nothing: no desktop banners during the demo
    printf '#!/usr/bin/env bash\nexit 0\n' >"$OFFICE_HOME/notify-noop.sh"
    say "starting the office on $BASE_URL (home $OFFICE_HOME)"
    # A clean environment: nothing from the caller's shell (AGENT_OFFICE_LAN,
    # AGENT_OFFICE_ALLOWED_HOSTS, ...) can widen the bind or the hosts
    (
      cd "$OFFICE_HOME"
      exec env -i \
        PATH="$PATH" \
        HOME="$OFFICE_HOME" \
        TMPDIR="${TMPDIR:-/tmp}" \
        AGENT_OFFICE_HOME="$RUNTIME_DIR" \
        AGENT_OFFICE_PORT="$OFFICE_PORT" \
        AGENT_OFFICE_HOST=127.0.0.1 \
        AGENT_OFFICE_REGISTRY_DIR="$OFFICE_HOME/claude/sessions" \
        AGENT_OFFICE_TASKS_DIR="$OFFICE_HOME/claude/tasks" \
        AGENT_OFFICE_TEAMS_DIR="$OFFICE_HOME/claude/teams" \
        CLAUDE_CONFIG_DIR="$OFFICE_HOME/claude" \
        AGENT_OFFICE_NOTIFY_SCRIPT="$OFFICE_HOME/notify-noop.sh" \
        nohup node "$OFFICE_SRC/server/index.js" >>"$LOG_FILE" 2>&1 </dev/null
    ) &
    echo $! >"$PID_FILE"
    local i
    for i in $(seq 1 60); do
      health_ok && break
      if ! running_pid >/dev/null; then
        tail -20 "$LOG_FILE" >&2
        die "the server exited during start; see $LOG_FILE"
      fi
      sleep 0.25
    done
    health_ok || { cmd_stop >/dev/null; die "the server did not answer $BASE_URL/health within 15s; see $LOG_FILE"; }
  fi
  # Against whatever answers now, so a restart or a reused server is checked too
  if ! check_version_msg="$(check_version 2>&1)"; then
    cmd_stop >/dev/null || true
    echo "$check_version_msg" >&2
    echo "office.sh: stopped it; run the pinned checkout ($OFFICE_CACHE/Claude-Office@$OFFICE_PIN)" >&2
    exit 1
  fi
  apply_quiet_settings
  say "office $OFFICE_VERSION running (pid $(running_pid))"
  echo "  URL:        $BASE_URL/"
  echo "  Token file: $TOKEN_FILE"
  echo "  Open with:  \$(scripts/office-view/office.sh url --token)   (the page needs the token fragment)"
  echo "  Log:        $LOG_FILE"
}

cmd_stop() {
  local pid
  if pid="$(running_pid)"; then
    kill "$pid" 2>/dev/null || true
    local i
    for i in $(seq 1 40); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
    say "stopped (pid $pid)"
  else
    say "not running"
  fi
  rm -f "$PID_FILE"
}

cmd_reset() {
  # A clean office for a new recording: no desks, no chat history. The token
  # and the quiet settings stay.
  if running_pid >/dev/null; then die "stop the office first (office.sh stop)"; fi
  rm -f "$RUNTIME_DIR"/chat.db "$RUNTIME_DIR"/chat.db-shm "$RUNTIME_DIR"/chat.db-wal \
        "$RUNTIME_DIR"/agents.json "$RUNTIME_DIR"/last-chat "$RUNTIME_DIR"/chat-poll-state
  say "cleared desks and chat history in $RUNTIME_DIR"
}

cmd_status() {
  local pid
  if pid="$(running_pid)"; then
    if health_ok; then
      local version
      version="$(curl -fsS --max-time 2 "$BASE_URL/config" | jq -r '.version // "unknown"')"
      say "running (pid $pid, version $version) at $BASE_URL/ with home $OFFICE_HOME"
    else
      say "process $pid is up but $BASE_URL/health does not answer with our token"
      return 1
    fi
  else
    say "not running"
    return 3
  fi
}

cmd_url() {
  if [[ "${1:-}" == "--token" ]]; then
    [[ -s "$TOKEN_FILE" ]] || die "no token yet at $TOKEN_FILE (run office.sh start)"
    echo "$BASE_URL/#token=$(cat "$TOKEN_FILE")"
  else
    echo "$BASE_URL/"
  fi
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  reset) cmd_reset ;;
  url) shift; cmd_url "$@" ;;
  *) echo "usage: office.sh start|stop|reset|status|url [--token]" >&2; exit 2 ;;
esac
