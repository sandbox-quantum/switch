#!/usr/bin/env bash
# Create or update this directory's monitors and dashboards in Datadog.
#
#   DD_API_KEY=... DD_APP_KEY=... \
#     NOTIFY=@slack-<workspace>-<ops-channel> \
#     NOTIFY_SECURITY=@slack-<workspace>-<security-channel> \
#     NOTIFY_SECURITY_PAGE=@pagerduty-<security-service> \
#     SERVICE=<service> ENV=<env> ./apply.sh
#
# Optional: DD_SITE (default datadoghq.com). ALLOW_DEFAULT_SERVICE=1 for the
# one deployment that keeps the default SERVICE_NAME `switch-core`.
# WORKOS_DIRECTORY=1 to include the monitors tagged requires:workos-directory.
# Those read the WorkOS mirror's gauges, which only a server running with
# ORGANIZATION_DIRECTORY=workos reports; anywhere else they would sit in "no
# data" and fire for ever.
#
# DRY_RUN=1 changes nothing in Datadog. It prints each monitor's payload, one
# JSON object per line on stdout, and where it is routed on stderr. It needs no
# Datadog keys; with them it also reads Datadog to say which monitors it would
# create and which it would update.
#
# Monitors are matched by name and dashboards by title, so running it again
# updates them in place instead of making copies.
#
# Routing: every monitor carries one `@REPLACE-WITH-NOTIFICATION-HANDLE`, and
# its `category:` tag says who it goes to. `category:ops` goes to NOTIFY.
# `category:security` goes to NOTIFY_SECURITY, and at priority 1 or 2 also to
# NOTIFY_SECURITY_PAGE. Each variable holds one or more handles separated by
# spaces. All three are required: Datadog does not validate handles, so a
# monitor left with a placeholder or an empty handle imports cleanly and
# notifies nobody. For the same reason the script checks monitors.json first
# (check_monitors.py) and refuses to send anything that still carries a
# placeholder once filled in.
#
# SERVICE scopes every monitor to one deployment, by its `service` tag
# (SERVICE_NAME), the one tag Core sets that Datadog keeps: the `env` tag on
# the metrics isn't set from ENVIRONMENT and can't separate deployments. ENV names
# and tags each copy, so several deployments can share one Datadog org
# without one's restart or test paging another's on-call, or overwriting
# another's monitors. The script refuses to run without both.
set -euo pipefail
set -f
cd "$(dirname "$0")"

die() {
  echo "apply.sh: $*" >&2
  exit 1
}

if [[ -z "${DRY_RUN:-}" ]]; then
  : "${DD_API_KEY:?set DD_API_KEY}"
  : "${DD_APP_KEY:?set DD_APP_KEY}"
fi
: "${NOTIFY:?set NOTIFY to the ops notification handle, e.g. @slack-workspace-channel}"
: "${NOTIFY_SECURITY:?set NOTIFY_SECURITY to the security notification handle, e.g. @slack-workspace-security-channel}"
: "${NOTIFY_SECURITY_PAGE:?set NOTIFY_SECURITY_PAGE to the security paging handle, e.g. @pagerduty-service}"
for var in NOTIFY NOTIFY_SECURITY NOTIFY_SECURITY_PAGE; do
  value=${!var}
  count=0
  for handle in $value; do
    count=$((count + 1))
    [[ "$handle" == @?* ]] || die "$var: every handle must start with @, got '$handle'"
    [[ "$handle" != *REPLACE-WITH* ]] || die "$var still holds a placeholder: '$handle'"
  done
  [[ $count -gt 0 ]] || die "$var holds no handle"
done
[[ "$NOTIFY_SECURITY" != "$NOTIFY" ]] ||
  echo "apply.sh: warning: NOTIFY_SECURITY is the same as NOTIFY, so security alerts go to the ops channel" >&2

: "${SERVICE:?set SERVICE to the service tag of this deployment (its SERVICE_NAME)}"
: "${ENV:?set ENV to a short name for this deployment, e.g. prod}"
# `switch-core` is the default SERVICE_NAME. Two deployments sharing it would
# share alerts, so it's refused unless ALLOW_DEFAULT_SERVICE=1 says this is
# the one deployment that keeps the default.
if [[ "$SERVICE" == "switch-core" && "${ALLOW_DEFAULT_SERVICE:-}" != "1" ]]; then
  die "SERVICE=switch-core is the default; give this deployment its own SERVICE_NAME, or set ALLOW_DEFAULT_SERVICE=1 if it is the one that keeps the default"
fi
for value in "$SERVICE" "$ENV"; do
  [[ "$value" =~ ^[a-z0-9][a-z0-9_.-]{0,63}$ ]] ||
    die "SERVICE and ENV must be lower-case letters, digits, '.', '_' or '-'"
done

python3 check_monitors.py monitors.json || die "monitors.json failed its checks; nothing was sent"

# Fill in every placeholder in jq rather than with shell substitution, so a
# handle is inserted as written whatever characters it holds.
rendered=$(jq -c \
  --arg ops "$NOTIFY" --arg security "$NOTIFY_SECURITY" --arg page "$NOTIFY_SECURITY_PAGE" \
  --arg service "$SERVICE" --arg env "$ENV" --arg workos "${WORKOS_DIRECTORY:-}" '
  .[]
  | select($workos != "" or ((.tags | index("requires:workos-directory")) | not))
  # The same handle named twice (a deployment that pages its channel) is sent once.
  | ((if (.tags | index("category:security")) then
        (if .priority <= 2 then "\($security) \($page)" else $security end)
      else $ops end)
     | split(" ") | map(select(. != ""))
     | reduce .[] as $h ([]; if index([$h]) then . else . + [$h] end)
     | join(" ")) as $handles
  | walk(if type == "string" then
           gsub("@REPLACE-WITH-NOTIFICATION-HANDLE"; $handles)
           | gsub("REPLACE-WITH-SERVICE"; $service)
           | gsub("REPLACE-WITH-ENV"; $env)
         else . end)
' monitors.json)

# The last line of defence: nothing that still names a placeholder is sent.
dashboard_file=signal-board.json
if grep -q 'REPLACE-WITH' <<<"$rendered"; then
  grep -o 'REPLACE-WITH[A-Z0-9-]*' <<<"$rendered" | sort -u >&2
  die "a placeholder would remain in the monitors sent to Datadog; nothing was sent"
fi
if grep -q 'REPLACE-WITH' "$dashboard_file"; then
  die "$dashboard_file carries a placeholder this script does not fill in; nothing was sent"
fi

API="https://api.${DD_SITE:-datadoghq.com}/api/v1"
offline=
if [[ -n "${DRY_RUN:-}" && ( -z "${DD_API_KEY:-}" || -z "${DD_APP_KEY:-}" ) ]]; then
  offline=1
  echo "dry run without Datadog keys: not reading Datadog, so it can't say which monitors exist" >&2
fi

dd() {
  local method=$1 path=$2 body=${3:-}
  if [[ -n "${DRY_RUN:-}" && "$method" != GET ]]; then
    echo "would $method $path" >&2
    echo '{}'
    return
  fi
  curl -sSf -X "$method" "$API$path" \
    -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" \
    -H "Content-Type: application/json" ${body:+--data "$body"} ||
    die "$method $path failed"
}

if [[ -n "$offline" ]]; then
  existing_monitors='[]'
else
  existing_monitors=$(dd GET "/monitor?monitor_tags=service:$SERVICE,env:$ENV")
fi
while read -r monitor; do
  name=$(jq -r .name <<<"$monitor")
  if [[ -n "${DRY_RUN:-}" ]]; then
    jq -r '"route: \(.name) [\(.tags[] | select(startswith("category:")) | ltrimstr("category:")) P\(.priority)] -> \(.message | split("\n") | last)"' <<<"$monitor" >&2
    echo "$monitor"
  fi
  id=$(jq -r --arg n "$name" '[.[] | select(.name == $n) | .id][0] // empty' <<<"$existing_monitors")
  if [[ -n "$id" ]]; then
    dd PUT "/monitor/$id" "$monitor" >/dev/null
    echo "updated monitor $id: $name" >&2
  elif [[ -n "$offline" ]]; then
    echo "would create or update monitor: $name" >&2
  else
    dd POST "/monitor" "$monitor" >/dev/null
    echo "created monitor: $name" >&2
  fi
done <<<"$rendered"

# The signal board is one shared board under a fixed title, written for the
# deployment that keeps the default service. Any other deployment leaves it
# alone, so loading a test deployment's alerts never overwrites it.
if [[ "$SERVICE" != "switch-core" ]]; then
  echo "skipped dashboard: the signal board belongs to the default service" >&2
  exit 0
fi
# Only the board this script was written for; the older dashboards were
# imported by hand and may have drifted from their files.
title=$(jq -r .title "$dashboard_file")
if [[ -n "$offline" ]]; then
  echo "would create or update dashboard: $title" >&2
  exit 0
fi
existing_dashboards=$(dd GET "/dashboard")
id=$(jq -r --arg t "$title" '[.dashboards[] | select(.title == $t) | .id][0] // empty' <<<"$existing_dashboards")
if [[ -n "$id" ]]; then
  dd PUT "/dashboard/$id" "@$dashboard_file" >/dev/null
  echo "updated dashboard $id: $title" >&2
else
  dd POST "/dashboard" "@$dashboard_file" >/dev/null
  echo "created dashboard: $title" >&2
fi
