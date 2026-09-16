# Dashboards and alerts

Datadog definitions for what `switch-core` reports (CHOO-2807). They are kept
here rather than clicked together in the UI so that a change to a metric and a
change to the panel reading it land in the same review.

Nothing here contains an account, an API key, a team handle or a URL. The
monitors carry `@REPLACE-WITH-NOTIFICATION-HANDLE` where a destination belongs;
fill it in when importing, not here.

## What the server has to be doing first

Reporting is off until a collector is named. See `OTLP_ENDPOINT` and
`DEPLOYMENT_ID` in `.env.example`, or `switchCore.observability` in the Helm
chart. With neither set these panels are empty and the monitors below will
report no data — which is a correct reading, not a broken dashboard.

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

## Two things to check on first import

**Histogram panels depend on how the collector maps them.** Request latency and
delivery lag are OTLP histograms. A collector exporting to Datadog in
`distributions` mode makes them distributions, which is what the `p95:` and
`p99:` queries here assume. In the default `histograms` mode they arrive as
separate `.count`, `.sum`, `.min` and `.max` series instead, and those panels
will be empty until either the collector's mode or the queries are changed.
Empty is the honest outcome; a panel is not silently switched to a different
statistic.

**The environment tag depends on `ENVIRONMENT` being set.** It is emitted as
OTLP's `deployment.environment`, which Datadog reads as `env`. A deployment
that has not set it appears with no environment, and the template variable on
the dashboard will have nothing to filter by.

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
