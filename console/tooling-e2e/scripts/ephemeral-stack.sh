#!/usr/bin/env bash
# Run the harness against a fresh, throwaway Switch stack built from this
# checkout: new Postgres and Mattermost volumes, migrations, switch-core on the
# host, then the chosen lane, then teardown.
#
#   just e2e-fast                 the fast lane (no provider, no Console)
#   just e2e-fast --keep          leave the stack running afterwards
#   just e2e-fast -- <vitest args> pass arguments through to vitest
#
# Secrets are generated per run into a temporary env file. The repository's
# own .env is never read or written, so this cannot rotate a developer's live
# secrets or pick up a stale value from them.
#
# Ports 5432, 8000, 8065 and 8081 must be free: stop a local stack first.
# Everything the run writes goes to build/e2e/ephemeral/ (or $E2E_OUT).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HARNESS="$REPO/console/tooling-e2e"
OUT="${E2E_OUT:-$REPO/build/e2e/ephemeral}"
LANE="${SWITCH_E2E_LANE:-fast}"
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
for port in 5432 8000 8065 8081; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is in use. Stop your local stack first ('just down', and any 'just run')." >&2
    exit 1
  fi
done

rm -rf "$OUT"; mkdir -p "$OUT"
ENV_FILE="$OUT/stack.env"
cp "$REPO/.env.example" "$ENV_FILE"
"$REPO/deploy/local/generate-env-secrets.sh" "$ENV_FILE" e2e
chmod 600 "$ENV_FILE"
set -a; source "$ENV_FILE"; set +a

cd "$REPO"
COMPOSE=(docker compose -p switch-e2e-ephemeral -f deploy/local/docker-compose.yml
         --env-file "$ENV_FILE" --project-directory .)
SERVER_PID=""
cleanup() {
  local status=$?
  if [ "$KEEP" = 0 ]; then
    [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null && wait "$SERVER_PID" 2>/dev/null
    "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
    rm -f "$ENV_FILE"
  else
    echo "Left running: switch-core :8000 (pid $SERVER_PID), Mattermost :8065."
    echo "Secrets for this stack: $ENV_FILE. Tear down with:"
    echo "  kill $SERVER_PID; ${COMPOSE[*]} down -v"
  fi
  exit "$status"
}
trap cleanup EXIT

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
GATEWAY_COOKIE_SECURE=false uv run --project core python -m switch_core.main \
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

echo "Running the $LANE lane…"
status=0
(
  cd "$HARNESS"
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
fi
exit "$status"
