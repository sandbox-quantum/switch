# Observability

What `switch-core` reports about itself, where it goes, and how to turn it on.

Structured logging came first and is older than the rest of this
(`logging_config.py`, `logging_context.py`). Metrics, readiness and the export
path are CHOO-2807.

## The short version

Nothing leaves the deployment until `OTLP_ENDPOINT` names a collector. Set it,
set `DEPLOYMENT_ID` to a UUID, and the server reports metrics. Logs are a
second switch because they cost more.

```bash
OTLP_ENDPOINT=https://telemetry.example.com
DEPLOYMENT_ID=0e5d1b3a-6c1f-4c22-9a4c-3a9f5a2b7d10   # `uuidgen`, once, then leave it
OTLP_LOGS_ENABLED=true                                # optional
```

In Helm the same settings are `switchCore.observability.*`. Dashboards and
alerts are checked in under [`deploy/observability/`](../../deploy/observability/).

## The three things it emits

**Logs** have always been written to the container's output as JSON, keyed for
Datadog, with `tenant_id`, `request_id`, `agent_id` and `user_id` stamped on
every line by a filter on the handler — so records from libraries carry them
too. With `OTLP_LOGS_ENABLED` the same records are *also* posted to the
collector. The stderr copy is never replaced: `kubectl logs` keeps working, and
a collector outage costs a copy rather than the record.

**Metrics** are declared in
[`core/switch_core/observability/catalogue.py`](../../core/switch_core/observability/catalogue.py),
which is the reference for what exists. Nothing not declared there can be
recorded — the registry rejects an unknown name and an attribute the spec does
not list.

**Traces** are not implemented. See "What is missing" below.

## Why there is a catalogue

A metric's cost is the number of distinct attribute combinations it produces,
and the values that feel most natural to attach are unbounded: a room id, an
agent id, the raw request path. One of those reaching a call site is not a
noisier dashboard, it is a bill and a collector that starts dropping.

On a multi-tenant server it is also a disclosure question. Dashboards are read
by whoever can see them, which is not the same set of people as those entitled
to a given tenant's rows, so tenant attribution stays out of metrics. Product
events that *are* tenant-attributed are CHOO-2806's concern and travel as log
records, where they are scoped separately.

So every attribute value must come from a fixed set the code controls — a
platform name, a route template, a status class. Where that cannot be
guaranteed at the call site, it does not belong in a metric. Two examples in
the tree: the HTTP middleware labels by route template and folds everything
unmatched into one bucket, because a 404 path is attacker-chosen; and the
transport classifies `send_event`'s arbitrary event type into four values
rather than passing it through.

## Health: two routes, on purpose

| Route | Answers | Used by |
| --- | --- | --- |
| `/health` | Always `ok`, checks nothing | Liveness probe; the gateway Deployment and setup Job wait on it at boot |
| `/health/ready` | Each dependency, and 503 when a gating one fails | Readiness probe |

`/health` could not simply be made stricter. Two other workloads block on it
during a deploy, so anything it checked would become a boot-ordering
dependency for them.

**What gates readiness is deliberately narrow.** `switch-core` is pinned to one
replica with a `Recreate` strategy, because it holds live sessions in memory.
A failing readiness probe therefore does not move traffic to a healthy pod —
there is no other pod. It empties the Service. So only the database gates:
without it every request is an error anyway.

Everything else is reported and alertable but never fatal. A crashed Slack
adapter is a real fault; taking Switch off the air over it would turn one
broken bridge into every broken bridge.

The checks run on a timer rather than per request, and the kubelet and the
metrics exporter read the same cached answer. The cache carries its own age,
and one nobody is refreshing reports itself as a failure — which is also how a
blocked event loop shows up.

## What the process reports about itself

There is no Datadog agent in the cluster, so `switch-core` reports its own
memory, CPU, descriptors and garbage collections, read from `/proc/self` with
no extra dependency. Off Linux those readings are absent rather than
fabricated, and a warning at startup says which.

**Event-loop lag is the one no external agent could produce.** The server is
single-threaded and cooperative: one blocking call stalls every room, every
bridge and every heartbeat at once, and from the outside that looks like an
unrelated timeout somewhere else. The connection sweep already measured its own
oversleep to avoid expiring connections it had simply failed to hear from; that
number is now reported instead of discarded.

## What you still do not get without an agent

Pod and node facts the process cannot see: container restarts, OOM kills,
evictions, node pressure, and Datadog's Kubernetes views. Application health
does not depend on any of it, but capacity planning eventually does. That is
infrastructure work, separate from this.

## What is missing

**Tracing.** The export path is signal-agnostic and `OTLP_TRACES_ENABLED`
exists, but nothing produces spans yet, and the relay Switch reports to does
not serve `/v1/traces` — a POST there returns 404. Enabling the flag today
would mean every export failing, which is why it defaults off. Two things have
to happen: the collector must accept the signal, and the server must produce
spans.

When it does, the log records already carry `traceId` and `spanId` fields
wherever they are set, so log-to-trace correlation needs no further change to
the log path.

**Per-route trace sampling** will matter when it arrives. Switch's agent
polling endpoints (`/events`, `/room-history`, per-agent reads) are very high
volume and are already filtered out of the uvicorn access log for that reason;
tracing them at full rate would swamp APM and cost more than it tells anyone.

## Failure behaviour

Everything here follows the repository's rule that a visible failure beats a
silent fallback.

- A collector that rejects a payload raises rather than being ignored,
  including a partial rejection inside a `200` — the collector answers `200`
  for a payload it drops, so the body is read.
- Repeated export failures escalate from a warning to an error naming how many
  intervals were lost, because by then the dashboards are stale and somebody is
  about to be misled by them.
- The log queue is bounded and drops the oldest, and says how many it dropped.
  A gap that announces itself beats one nobody can see.
- `DEPLOYMENT_ID` is required whenever an endpoint is set, and the server
  refuses to start without it. The collector drops unattributed payloads
  silently, with a `200`, so the alternative is a deployment that looks
  configured and appears on no dashboard.
- An export failure never takes the server down. A metrics exporter that can
  kill the thing it measures is worse than no metrics exporter.
