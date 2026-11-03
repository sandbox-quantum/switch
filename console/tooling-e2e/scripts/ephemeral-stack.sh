#!/usr/bin/env bash
# Run the harness against a fresh, throwaway Switch stack built from this
# checkout: new Postgres and Mattermost volumes, migrations, switch-core on the
# host, then the chosen lane, then teardown.
#
#   just e2e-fast                 the fast lane (no provider, no Console)
#   just e2e-provider             the provider lane, on a headless agent controller
#   just e2e-browser              the browser lane: the gateway UI in headless Chromium
#   just e2e-agentic              the agentic lane: scenario files, a driver and a judge model
#   just e2e-fast --keep          leave the stack running afterwards
#   just e2e-fast -- <vitest args> pass arguments through to vitest
#
# The provider lane also builds console/packages and starts an agent controller
# on the host, which runs the agent's sessions with a real provider CLI. The CLI
# must be installed and signed in for the user running this, or its key given in
# the file SWITCH_E2E_PROVIDER_ENV_FILE names (passed to the controller as
# --env-file). SWITCH_E2E_AGENT_TYPE picks the provider (default opencode).
#
# Secrets are generated per run into a temporary env file. The repository's
# own .env is never read or written, so this cannot rotate a developer's live
# secrets or pick up a stale value from them.
#
# The browser lane also builds the gateway UI from gateway/ and serves it with
# `vite preview` on :4173, whose proxy sends its /gateway requests to :8000 as
# nginx does in a deployment, and installs Playwright's Chromium.
#
# Ports 4173, 5432, 8000, 8065 and 8081 must be free: stop a local stack first.
# Logs and the JUnit report go to build/e2e/ephemeral/ (or $E2E_OUT); the env
# file, the controller's state and the agent's working directory go to a
# temporary directory, so the output holds nothing secret by construction.
# On exit the output is scanned for every secret the run used, and
# .secret-scan-passed is written there only if none turned up: CI uploads the
# output only when that file exists.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HARNESS="$REPO/console/tooling-e2e"
OUT="${E2E_OUT:-$REPO/build/e2e/ephemeral}"
LANE="${SWITCH_E2E_LANE:-fast}"
# The agentic lane runs on the provider lane's setup: a real session on an
# agent controller.
NEEDS_CONTROLLER=0
FOLLOW_WINDOW_SECONDS=20
case "$LANE" in provider|agentic) NEEDS_CONTROLLER=1 ;; esac
KEEP=0
VITEST_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1 ;;
    --) shift; VITEST_ARGS=("$@"); break ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

for tool in docker uv openssl curl jq lsof; do
  command -v "$tool" >/dev/null || { echo "$tool is required but not on PATH." >&2; exit 1; }
done
for port in 4173 5432 8000 8065 8081; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is in use. Stop your local stack first ('just down', and any 'just run')." >&2
    exit 1
  fi
done

rm -rf "$OUT"; mkdir -p "$OUT"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/switch-e2e.XXXXXX")"
chmod 700 "$WORK"
ENV_FILE="$WORK/stack.env"
# Every secret the run uses, one per line, for the scan of $OUT on exit.
SECRETS="$WORK/secrets"
: >"$SECRETS"

cd "$REPO"
COMPOSE=(docker compose -p switch-e2e-ephemeral -f deploy/local/docker-compose.yml
         --env-file "$ENV_FILE" --project-directory .)
SERVER_PID=""
CONTROLLER_PID=""
UI_PID=""
cleanup() {
  local status=$?
  # Every step runs whatever the one before it did: a process that exits
  # non-zero on SIGTERM must not skip the teardown, the scan or the removal
  # of $WORK.
  set +e
  if [ "$KEEP" = 0 ]; then
    [ -n "$UI_PID" ] && kill "$UI_PID" 2>/dev/null && wait "$UI_PID" 2>/dev/null
    [ -n "$CONTROLLER_PID" ] && kill "$CONTROLLER_PID" 2>/dev/null && wait "$CONTROLLER_PID" 2>/dev/null
    [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null && wait "$SERVER_PID" 2>/dev/null
    "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
  else
    echo "Left running: switch-core :8000 (pid $SERVER_PID), Mattermost :8065${CONTROLLER_PID:+, agent controller (pid $CONTROLLER_PID)}${UI_PID:+, gateway UI :4173 (pid $UI_PID)}."
    echo "Secrets and state for this stack: $WORK. Tear down with:"
    echo "  kill $SERVER_PID $CONTROLLER_PID $UI_PID; ${COMPOSE[*]} down -v; rm -rf $WORK"
  fi
  if "$HARNESS/scripts/scan-artifacts.sh" "$OUT" <"$SECRETS"; then
    : >"$OUT/.secret-scan-passed"
  else
    status=1
  fi
  [ "$KEEP" = 0 ] && rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT

cp "$REPO/.env.example" "$ENV_FILE"
"$REPO/deploy/local/generate-env-secrets.sh" "$ENV_FILE" e2e
if [ "$NEEDS_CONTROLLER" = 1 ]; then
  # Agent management, and the key controllers' access tokens are signed with.
  sed -i.bak -e "s|^FEATURE_FLAGS_ENABLED=.*|FEATURE_FLAGS_ENABLED=agent_management|" \
             -e "s|^CONTROLLER_TOKEN_SECRET=.*|CONTROLLER_TOKEN_SECRET=$(openssl rand -hex 32)|" "$ENV_FILE"
  rm -f "$ENV_FILE.bak"
else
  # Follow-ups, with a window short enough for a scenario to wait out. Not on
  # the controller lanes: there an untagged answer to a request card, or an
  # agentic scenario's unaddressed setup message, would become a follow-up.
  sed -i.bak -e "s|^FEATURE_FLAGS_ENABLED=.*|FEATURE_FLAGS_ENABLED=follow_the_conversation|" "$ENV_FILE"
  rm -f "$ENV_FILE.bak"
  printf 'FOLLOW_THE_CONVERSATION_WINDOW_SECONDS=%s\n' "$FOLLOW_WINDOW_SECONDS" >>"$ENV_FILE"
fi
chmod 600 "$ENV_FILE"
set -a; source "$ENV_FILE"; set +a

# A secret's value, and each part of it, since SECRET_KEYS is `label:key,…`.
# One layer of surrounding quotes is dropped, as the env file's reader drops it:
# the logs hold the bare value.
remember_secrets() {
  local value
  for value in "$@"; do
    case "$value" in
      \"*\") value="${value#\"}"; value="${value%\"}" ;;
      \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac
    printf '%s\n' "$value" >>"$SECRETS"
    tr ',:' '\n\n' <<<"$value" >>"$SECRETS"
  done
}
while IFS='=' read -r key value; do
  case "$key" in *SECRET*|*PASSWORD*|*TOKEN*|*_KEY|*_KEYS) remember_secrets "$value" ;; esac
done < <(grep -E '^[A-Z0-9_]+=' "$ENV_FILE")
if [ -n "${SWITCH_E2E_PROVIDER_ENV_FILE:-}" ] && [ -r "$SWITCH_E2E_PROVIDER_ENV_FILE" ]; then
  while IFS='=' read -r _ value; do remember_secrets "$value"; done \
    < <(grep -E '^[A-Za-z0-9_]+=' "$SWITCH_E2E_PROVIDER_ENV_FILE")
fi


echo "Starting a fresh stack (Postgres, Mattermost)…"
"${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
"${COMPOSE[@]}" up -d --build >"$OUT/compose-up.log" 2>&1 \
  || { echo "docker compose up failed; see $OUT/compose-up.log" >&2; exit 1; }

for _ in $(seq 60); do
  "${COMPOSE[@]}" exec -T postgres pg_isready -q >/dev/null 2>&1 && break; sleep 1
done
uv run --project core alembic -c core/alembic.ini upgrade head >"$OUT/migrate.log" 2>&1 \
  || { echo "migrations failed; see $OUT/migrate.log" >&2; exit 1; }

echo "Starting switch-core from this checkout…"
# JSON, so the harness can read back what the server logged during each
# scenario (SWITCH_E2E_SERVER_LOG): one record per line, timed to the
# millisecond. `jq -r '"\(.timestamp) \(.status) \(.message)"'` reads it.
GATEWAY_COOKIE_SECURE=false LOG_FORMAT=json uv run --project core python -m switch_core.main \
  >"$OUT/switch-core.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 120); do curl -sf localhost:8000/health >/dev/null && break; sleep 1; done
curl -sf localhost:8000/health >/dev/null \
  || { echo "switch-core did not come up; see $OUT/switch-core.log" >&2; exit 1; }

echo "Waiting for the Mattermost bridge to be registered…"
for _ in $(seq 150); do
  "${COMPOSE[@]}" logs setup 2>&1 | grep -q "Setup complete" && break; sleep 2
done
"${COMPOSE[@]}" logs setup 2>&1 | grep -q "Setup complete" \
  || { "${COMPOSE[@]}" logs setup >"$OUT/setup.log" 2>&1
       echo "Mattermost setup never completed; see $OUT/setup.log" >&2; exit 1; }

# The harness posts as the Mattermost human the setup container created. A
# session token from logging in authenticates exactly as a personal access
# token does, and dies with the stack.
MATTERMOST_TOKEN="$(curl -sf -D - -o /dev/null -H 'Content-Type: application/json' \
  -d "$(jq -n --arg u "$MATTERMOST_USER" --arg p "$MATTERMOST_USER_PASSWORD" '{login_id: $u, password: $p}')" \
  http://localhost:8065/api/v4/users/login | tr -d '\r' | awk -F': ' 'tolower($1)=="token" {print $2}')"
[ -n "$MATTERMOST_TOKEN" ] || { echo "could not log in to Mattermost as $MATTERMOST_USER" >&2; exit 1; }
remember_secrets "$MATTERMOST_TOKEN"

PROVIDER_ENV=()
if [ "$NEEDS_CONTROLLER" = 1 ]; then
  echo "Building the agent controller…"
  (cd "$REPO/console" && pnpm -r --filter './packages/**' run build) >"$OUT/console-build.log" 2>&1 \
    || { echo "console package build failed; see $OUT/console-build.log" >&2; exit 1; }

  JAR="$WORK/gateway.cookies"
  curl -sf -c "$JAR" -o /dev/null -H 'Content-Type: application/json' \
    -d "$(jq -n --arg e "$GATEWAY_ADMIN_EMAIL" --arg p "$GATEWAY_ADMIN_PASSWORD" '{email: $e, password: $p}')" \
    http://localhost:8000/gateway/auth/login \
    || { echo "could not sign in to the gateway as $GATEWAY_ADMIN_EMAIL" >&2; exit 1; }
  CONTROLLER="$(curl -sf -b "$JAR" -H 'Content-Type: application/json' \
    -d "$(jq -n --arg os "$(uname -s | tr '[:upper:]' '[:lower:]')" --arg arch "$(uname -m)" \
             --arg osv "$(uname -r)" \
             '{name: "e2e-controller", kind: "console", version: "e2e",
               platform: {os: $os, arch: $arch, os_version: $osv}}')" \
    http://localhost:8000/gateway/management/controllers)" \
    || { echo "could not create an agent controller (is agent_management on?)" >&2; exit 1; }
  rm -f "$JAR"
  CONTROLLER_ID="$(jq -r .controller_id <<<"$CONTROLLER")"
  remember_secrets "$(jq -r .credential <<<"$CONTROLLER")"

  echo "Starting the agent controller…"
  CONTROLLER_ARGS=(run --data-dir "$WORK/controller" --controller-id "$CONTROLLER_ID"
                   --server http://localhost:8000 --credential-stdin)
  if [ -n "${SWITCH_E2E_PROVIDER_ENV_FILE:-}" ]; then
    CONTROLLER_ARGS+=(--env-file "$SWITCH_E2E_PROVIDER_ENV_FILE")
  fi
  # The credential goes in on stdin and is never written to disk.
  jq -r .credential <<<"$CONTROLLER" | SWITCH_CONTROLLER_LOG_LEVEL=info \
    node "$REPO/console/packages/agent-controller/dist/cli.mjs" "${CONTROLLER_ARGS[@]}" \
    >"$OUT/controller.log" 2>&1 &
  CONTROLLER_PID=$!
  unset CONTROLLER

  # A controller that exits at once (bad credential, missing build, unreadable
  # --env-file) would otherwise surface two minutes later as a placement timeout.
  for _ in $(seq 60); do
    kill -0 "$CONTROLLER_PID" 2>/dev/null || break
    grep -q "Connected to Switch" "$OUT/controller.log" && break
    sleep 1
  done
  if ! kill -0 "$CONTROLLER_PID" 2>/dev/null || ! grep -q "Connected to Switch" "$OUT/controller.log"; then
    echo "The agent controller did not connect to Switch; its log ($OUT/controller.log):" >&2
    tail -n 40 "$OUT/controller.log" >&2
    exit 1
  fi

  mkdir -p "$WORK/agent-dir"
  PROVIDER_ENV=(SWITCH_E2E_CONTROLLER_ID="$CONTROLLER_ID" SWITCH_E2E_AGENT_DIR="$WORK/agent-dir")
fi

BROWSER_ENV=()
if [ "$LANE" = browser ]; then
  echo "Building the gateway UI…"
  (cd "$REPO/gateway" && npm ci --no-audit --no-fund && npm run build) >"$OUT/gateway-build.log" 2>&1 \
    || { echo "gateway UI build failed; see $OUT/gateway-build.log" >&2; exit 1; }
  (cd "$HARNESS" && pnpm exec playwright install chromium) >"$OUT/playwright-install.log" 2>&1 \
    || { echo "installing Playwright's Chromium failed; see $OUT/playwright-install.log" >&2; exit 1; }
  (cd "$REPO/gateway" && exec node_modules/.bin/vite preview --host 127.0.0.1 --port 4173 --strictPort) \
    >"$OUT/gateway-ui.log" 2>&1 &
  UI_PID=$!
  for _ in $(seq 30); do curl -sf localhost:4173/ >/dev/null && break; sleep 1; done
  curl -sf localhost:4173/ >/dev/null \
    || { echo "the gateway UI did not come up; see $OUT/gateway-ui.log" >&2; exit 1; }
  BROWSER_ENV=(SWITCH_GATEWAY_UI_URL=http://127.0.0.1:4173)
fi

echo "Running the $LANE lane…"
status=0
(
  cd "$HARNESS"
  if [ ${#PROVIDER_ENV[@]} -gt 0 ]; then export "${PROVIDER_ENV[@]}"; fi
  if [ ${#BROWSER_ENV[@]} -gt 0 ]; then export "${BROWSER_ENV[@]}"; fi
  # The credentials the harness is issued, for the scan on exit.
  export SWITCH_E2E_SECRETS_FILE="$SECRETS"
  # What the server logs, so a scenario during which it logs an error fails.
  export SWITCH_E2E_SERVER_LOG="$OUT/switch-core.log"
  # Screenshots of failed pages, and agentic transcripts and verdicts.
  export SWITCH_E2E_OUTPUT_DIR="$OUT"
  # The follow-up window the server was started with, for the scenario that waits it out.
  [ "$NEEDS_CONTROLLER" = 0 ] && export SWITCH_E2E_FOLLOW_WINDOW_SECONDS="$FOLLOW_WINDOW_SECONDS"
  SWITCH_E2E_LANE="$LANE" \
  SWITCH_E2E_ENVIRONMENT=ephemeral \
  SWITCH_E2E_STRICT=1 \
  SWITCH_API_URL=http://localhost:8000 \
  SWITCH_GATEWAY_ADMIN_EMAIL="$GATEWAY_ADMIN_EMAIL" \
  SWITCH_GATEWAY_ADMIN_PASSWORD="$GATEWAY_ADMIN_PASSWORD" \
  SWITCH_AGENT_REGISTRATION_TOKEN="$AGENT_REGISTRATION_TOKEN" \
  MATTERMOST_URL=http://localhost:8065 \
  MATTERMOST_TOKEN="$MATTERMOST_TOKEN" \
  MATTERMOST_TEAM="$MATTERMOST_TEAM_NAME" \
    pnpm exec vitest run --reporter=verbose --reporter=junit \
      --outputFile.junit="$OUT/junit.xml" ${VITEST_ARGS[@]+"${VITEST_ARGS[@]}"}
) || status=$?

if [ "$status" != 0 ]; then
  echo "The $LANE lane failed. switch-core log: $OUT/switch-core.log" >&2
  [ "$NEEDS_CONTROLLER" = 1 ] && echo "Agent controller log: $OUT/controller.log" >&2
  [ "$LANE" = browser ] && echo "Screenshots of failed pages: $OUT/screenshots" >&2
fi
exit "$status"
