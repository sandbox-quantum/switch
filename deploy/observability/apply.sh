#!/usr/bin/env bash
# Create or update this directory's monitors and dashboards in Datadog.
#
#   DD_API_KEY=... DD_APP_KEY=... NOTIFY=@slack-<workspace>-<channel> \
#     SERVICE=<service> ENV=<env> ./apply.sh
#
# Optional: DD_SITE (default datadoghq.com), DRY_RUN=1 to print what would change.
# ALLOW_DEFAULT_SERVICE=1 for the one deployment that keeps the default
# SERVICE_NAME `switch-core`.
#
# Monitors are matched by name and dashboards by title, so running it again
# updates them in place instead of making copies. NOTIFY replaces the
# notification placeholder in every monitor; the script refuses to run without
# it, because a monitor left with the placeholder imports cleanly and notifies
# nobody.
#
# SERVICE scopes every monitor to one deployment, by its `service` tag
# (SERVICE_NAME), the one tag Core sets that Datadog keeps: the `env` tag on
# the metrics isn't set from ENVIRONMENT and can't separate deployments. ENV names
# and tags each copy, so several deployments can share one Datadog org
# without one's restart or test paging another's on-call, or overwriting
# another's monitors. The script refuses to run without both.
set -euo pipefail
cd "$(dirname "$0")"

: "${DD_API_KEY:?set DD_API_KEY}"
: "${DD_APP_KEY:?set DD_APP_KEY}"
: "${NOTIFY:?set NOTIFY to the notification handle, e.g. @slack-workspace-channel}"
case "$NOTIFY" in @*) ;; *) echo "NOTIFY must start with @" >&2; exit 1 ;; esac
: "${SERVICE:?set SERVICE to the service tag of this deployment (its SERVICE_NAME)}"
: "${ENV:?set ENV to a short name for this deployment, e.g. prod}"
# `switch-core` is the default SERVICE_NAME. Two deployments sharing it would
# share alerts, so it's refused unless ALLOW_DEFAULT_SERVICE=1 says this is
# the one deployment that keeps the default.
if [[ "$SERVICE" == "switch-core" && "${ALLOW_DEFAULT_SERVICE:-}" != "1" ]]; then
  echo "SERVICE=switch-core is the default; give this deployment its own SERVICE_NAME, or set ALLOW_DEFAULT_SERVICE=1 if it is the one that keeps the default" >&2
  exit 1
fi
for value in "$SERVICE" "$ENV"; do
  [[ "$value" =~ ^[a-z0-9][a-z0-9_.-]{0,63}$ ]] || {
    echo "SERVICE and ENV must be lower-case letters, digits, '.', '_' or '-'" >&2
    exit 1
  }
done
API="https://api.${DD_SITE:-datadoghq.com}/api/v1"

dd() {
  local method=$1 path=$2 body=${3:-}
  if [[ -n "${DRY_RUN:-}" && "$method" != GET ]]; then
    echo "would $method $path" >&2
    echo '{}'
    return
  fi
  curl -sf -X "$method" "$API$path" \
    -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" \
    -H "Content-Type: application/json" ${body:+--data "$body"}
}

existing_monitors=$(dd GET "/monitor?monitor_tags=service:$SERVICE,env:$ENV")
jq -c '.[]' monitors.json | while read -r monitor; do
  monitor=${monitor//@REPLACE-WITH-NOTIFICATION-HANDLE/$NOTIFY}
  monitor=${monitor//REPLACE-WITH-SERVICE/$SERVICE}
  monitor=${monitor//REPLACE-WITH-ENV/$ENV}
  name=$(jq -r .name <<<"$monitor")
  id=$(jq -r --arg n "$name" '[.[] | select(.name == $n) | .id][0] // empty' <<<"$existing_monitors")
  if [[ -n "$id" ]]; then
    dd PUT "/monitor/$id" "$monitor" >/dev/null
    echo "updated monitor $id: $name"
  else
    dd POST "/monitor" "$monitor" >/dev/null
    echo "created monitor: $name"
  fi
done

# The signal board is one shared board under a fixed title, written for the
# deployment that keeps the default service. Any other deployment leaves it
# alone, so loading a test deployment's alerts never overwrites it.
if [[ "$SERVICE" != "switch-core" ]]; then
  echo "skipped dashboard: the signal board belongs to the default service"
  exit 0
fi
existing_dashboards=$(dd GET "/dashboard")
# Only the board this script was written for; the older dashboards were
# imported by hand and may have drifted from their files.
file=signal-board.json
title=$(jq -r .title "$file")
id=$(jq -r --arg t "$title" '[.dashboards[] | select(.title == $t) | .id][0] // empty' <<<"$existing_dashboards")
if [[ -n "$id" ]]; then
  dd PUT "/dashboard/$id" "@$file" >/dev/null
  echo "updated dashboard $id: $title"
else
  dd POST "/dashboard" "@$file" >/dev/null
  echo "created dashboard: $title"
fi
