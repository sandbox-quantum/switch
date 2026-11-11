#!/usr/bin/env bash
# Create or update this directory's monitors and dashboards in Datadog.
#
#   DD_API_KEY=... DD_APP_KEY=... NOTIFY=@slack-<workspace>-<channel> ./apply.sh
#
# Optional: DD_SITE (default datadoghq.com), DRY_RUN=1 to print what would change,
# WORKOS_DIRECTORY=1 to include the monitors tagged requires:workos-directory.
# Those read the WorkOS mirror's gauges, which only a server running with
# ORGANIZATION_DIRECTORY=workos reports; anywhere else they would sit in "no
# data" and fire for ever.
#
# Monitors are matched by name and dashboards by title, so running it again
# updates them in place instead of making copies. NOTIFY replaces the
# notification placeholder in every monitor; the script refuses to run without
# it, because a monitor left with the placeholder imports cleanly and notifies
# nobody.
set -euo pipefail
cd "$(dirname "$0")"

: "${DD_API_KEY:?set DD_API_KEY}"
: "${DD_APP_KEY:?set DD_APP_KEY}"
: "${NOTIFY:?set NOTIFY to the notification handle, e.g. @slack-workspace-channel}"
case "$NOTIFY" in @*) ;; *) echo "NOTIFY must start with @" >&2; exit 1 ;; esac
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

existing_monitors=$(dd GET "/monitor?monitor_tags=service:switch-core")
if [[ -n "${WORKOS_DIRECTORY:-}" ]]; then
  selected='.[]'
else
  selected='.[] | select((.tags | index("requires:workos-directory")) | not)'
fi
jq -c "$selected" monitors.json | while read -r monitor; do
  monitor=${monitor//@REPLACE-WITH-NOTIFICATION-HANDLE/$NOTIFY}
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
