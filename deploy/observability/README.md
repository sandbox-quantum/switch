# Dashboards and alerts

Datadog definitions for what `switch-core` reports. They are kept here rather
than clicked together in the UI so that a change to a metric and a change to
the panel reading it land in the same review.

Nothing here contains an account, an API key, a team handle or a URL. The
monitors carry `@REPLACE-WITH-NOTIFICATION-HANDLE` where a destination belongs;
fill it in when importing, not here.

**Do not skip that.** Datadog does not validate notification handles: a monitor
carrying the placeholder imports cleanly, shows as healthy in the UI, triggers
normally — and notifies nobody. There is no error to notice. Replace every one
of them before you import, and test one deliberately.

## What the server has to be doing first

Reporting is off until a collector is named. See `OTLP_ENDPOINT` and
`DEPLOYMENT_ID` in `.env.example`, or `switchCore.observability` in the Helm
chart. With neither set these panels are empty, and only the first monitor —
the no-data canary — has anything to say. That is a correct reading, not a
broken dashboard.

Every metric this server can emit is declared in
`core/switch_core/observability/catalogue.py`, with the attributes each may
carry. That file is the reference; this directory is one view of it.

## Importing

```bash
# Dashboard
curl -X POST "https://api.<your-datadog-site>/api/v1/dashboard" \
  -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" \
  -H "Content-Type: application/json" \
  --data @dashboard.json

# Monitors, one at a time — the API takes a single monitor per call
jq -c '.[]' monitors.json | while read -r monitor; do
  curl -X POST "https://api.<your-datadog-site>/api/v1/monitor" \
    -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" \
    -H "Content-Type: application/json" --data "$monitor"
done
```

## Check these before you trust the dashboard

**Histogram panels need two things, not one.** Request latency, delivery lag,
database query duration and platform call duration are OTLP histograms, and the
`p95:`/`p99:` queries here assume the collector exports them to Datadog as
*distributions*. Check the collector's
histogram mode — in the older `histograms` mode they arrive as separate
`.count`, `.sum`, `.min` and `.max` series and these panels stay empty.

Then check the second thing, which is easy to miss because it is on Datadog's
side rather than the collector's: **percentile aggregations are off by default
on a distribution metric and are billed separately.** Enable them per metric in
Metrics Summary, and add the tag each panel groups by to that metric's
configured tag set — `route` for requests, `operation` for database queries,
`platform` for bridge calls — or `p95: … by {…}` returns nothing on a fresh
account. Empty is the honest outcome either way; a panel is never silently
switched to a different statistic.

The two latency **monitors** depend on the same thing, and fail more quietly
than a panel does: an alert over a percentile that is not enabled evaluates
against no series and sits healthy for ever. Check them after enabling
percentiles, not before.

**`env` is a filter, not a grouping.** The dashboard's `$env` variable defaults
to `*` and works whether or not anything sets it. The monitors deliberately do
*not* group by `env`: the tag only exists when `ENVIRONMENT` is configured
(it becomes OTLP's `deployment.environment`, which Datadog reads as `env`), and
a monitor grouped by a tag no data carries returns no series and sits silently
healthy for ever. If several deployments report into one Datadog org, set
`ENVIRONMENT` on each and add `env:<name>` to the monitor scopes by hand.

**`service` is the one tag everything depends on.** Every monitor filters on
`service:switch-core`. If a deployment changes `SERVICE_NAME`, every one of
them goes silent at once.

## The odd-looking first monitor

`[Switch] switch-core has stopped reporting` queries event-loop lag with a
threshold of `< 0`, which no real reading can satisfy. That is deliberate and
is Datadog's idiom for a no-data monitor: the threshold never fires, and
`notify_no_data` does the work. Event-loop lag is the metric used because it is
emitted every interval unconditionally — a request counter would read zero on a
quiet night and a heartbeat that can legitimately be absent is not a heartbeat.

## What is deliberately not alerted on

**Latency.** Switch holds long-poll connections open on purpose, so a slow
request is its normal mode and a duration threshold would page on healthy
traffic. The dashboard shows it; nothing wakes anyone for it.

**Bridge event volume.** It follows whatever the humans in the channels are
doing. A quiet Sunday is not an incident, and an alert that fires every
weekend is one nobody reads by the time something real happens.

**Readiness itself, from inside.** If the pod is not ready, Kubernetes already
knows and the deployment is already out of service. What is alerted on is the
dependency that caused it, which is the part that says what to go and fix.

**File descriptors.** `switch.runtime.open_fds` is on the dashboard and has no
monitor, which is a judgement rather than an oversight: a leak is a slope, not
a level, and the process cannot see the limit it is climbing towards. An
absolute threshold picked from here would be a guess. Watch the panel; an agent
reporting the container's limit would make this alertable properly.

**Garbage collection.** `switch.runtime.gc_collections` is emitted and
deliberately unpanelled — it is a curiosity for a service like this one, not a
signal. It is there for the day someone is chasing a memory question and wants
it.
