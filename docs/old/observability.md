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

In Helm the same settings are `switchCore.observability.*`, with one
exception: `OTLP_HEADERS` is `secrets.otlpHeaders`, because the documented use
for it is a collector's API key and every other credential in that chart comes
from the Secret rather than the pod spec. Dashboards and alerts are checked in
under [`deploy/observability/`](../../deploy/observability/).

## Checking it actually works

You do not need a Datadog account, or the relay, or a cluster. Run a collector
on your laptop and read what the server sends it.

### The self-contained way

This touches nothing you already have: its own database on its own port, its
own settings, no `.env`, and it cleans up after itself. Worth preferring even
if you do have a working local stack, because nothing it does can disturb one.

```bash
# A throwaway database.
docker run -d --name switch-obs-check \
  -e POSTGRES_PASSWORD=check -e POSTGRES_DB=switch \
  -p 55432:5432 postgres:16-alpine

# One terminal: a stand-in collector that prints what arrives.
python scripts/otlp_sink.py

# Another: the server, reporting to it.
DB_HOST=localhost DB_PORT=55432 DB_USER=postgres DB_PASSWORD=check DB_NAME=switch \
DB_REQUIRE_RESTRICTED_ROLE=false \
MATRIX_SERVER_NAME=switch.local \
AGENT_REGISTRATION_TOKEN=check JWT_SECRET_KEY=check-jwt-secret-key-long-enough \
GATEWAY_ADMIN_EMAIL=admin@switch.local GATEWAY_ADMIN_PASSWORD=check \
SERVER_PORT=8099 LOG_FORMAT=json ENVIRONMENT=local \
OTLP_ENDPOINT=http://localhost:4318 \
DEPLOYMENT_ID=$(uuidgen | tr 'A-Z' 'a-z') \
OTLP_EXPORT_INTERVAL_SECONDS=5 \
OTLP_LOGS_ENABLED=true \
uv run --project core python -m switch_core.main
```

`DB_REQUIRE_RESTRICTED_ROLE=false` is what lets this run as the superuser
against a throwaway database. It logs an error saying tenant isolation is not
in force, which is correct and is why it is not a default — never set it on
anything real.

`uv run` directly rather than `just run`, because `just` loads `.env` from the
working directory and this recipe deliberately has none. Clean up with
`docker rm -f switch-obs-check`.

### Using your own local stack instead

`just run` reads `.env` from the directory you run it in. **A git worktree has
no `.env`** — it is untracked, so it does not come across with the branch — and
without one every database and secret setting is missing and `SwitchConfig`
refuses to start, listing all ten. Copy one in (`cp ../switch/.env .`), and
check it against `.env.example` first: an older one predates the
runtime/owner database roles and `just up` will refuse it. Add
`SERVER_PORT=8099` if your usual server is already on 8000.

### Reading what comes out

Within a few seconds the sink prints each interval. Make some requests
(`curl localhost:8099/health`) and the next one carries them:

```
[15:37:39] POST /v1/metrics
  resource: service=switch-core version=0.26.0 env=local deployment=0e5d1b3a-…
    switch.http.requests +9  {method=GET, route=/health, status_class=2xx}
    switch.http.requests +4  {method=GET, route=unmatched, status_class=4xx}
    switch.http.request.duration n=9 mean=0.3ms  {method=GET, route=/health}
    switch.health.check = 1  {check=database}
    switch.db.pool.in_use = 0
```

Four things in that output are worth checking deliberately, because each is a
way this could be quietly wrong rather than visibly broken:

- **Routes are templates.** Requests to several unknown paths collapse into one
  `unmatched` series rather than one series each.
- **Counters are deltas.** An interval with no traffic carries no
  `switch.http.requests` line at all, rather than repeating the last total.
- **`switch.db.pool.overflow` reads 0 on an idle pool**, not a negative number.
- **Log records carry `tenant_id` and `request_id`**, which is the whole reason
  for shipping them rather than counting them.

Two things that look like faults and are not. Off Linux,
`switch.runtime.memory_rss` and `switch.runtime.open_fds` are absent, and a
warning at startup says so. And for the first few intervals after boot,
`switch.health.check{check:message_listener}` reads 0 — the checks begin before
the notification listener has finished connecting, and it reports what is true
at the time rather than assuming the best. It goes to 1 on its own, and
readiness never gated on it.

A steady `switch.runtime.event_loop_lag` of one or two milliseconds is the
floor, not a stall: it is how far past its deadline a timer normally wakes.
The alert on it fires at a thousand times that.

**What this does not exercise.** A bare server has no rooms, no agents and no
bridges, so nine of the twenty-five metrics never appear — everything under
`switch.messages.*`, `switch.bridge.*` and `switch.agent.*`. Their absence
here is correct and
says nothing about whether they work; what covers them is
`TestWhatIsMeasured` in `core/tests/switch_core/transport/test_postgres_transport.py`
and `test_bridge_metrics.py`, which record against a real database and a real
dispatch path. To see them live you need an agent in a room actually talking.

### Checking readiness for real

Stop the database out from under a running server:

```bash
docker stop switch-obs-check
curl -s localhost:8099/health/ready   # 503, naming the database
curl -so /dev/null -w '%{http_code}' localhost:8099/health   # still 200
docker start switch-obs-check
curl -s localhost:8099/health/ready   # back to 200 within ~15s
```

Both halves matter. Readiness failing is what takes the pod out of service;
liveness staying up is what stops Kubernetes restarting a server whose only
problem is a database it does not own. A restart would not fix it and would
drop every live session to find that out.

## The three things it emits

**Logs** go to the container's output, with `tenant_id`, `request_id`,
`agent_id`, `room_id` and `user_id` stamped on every line by a filter on the
handler — so records from libraries carry them too. A room id is a log field
and deliberately not a metric attribute: it is unbounded and belongs to one
tenant, which rules it out of a dashboard label for the reasons under "Why
there is a catalogue" — and following one room through a failure is the single
most common thing anyone asks these logs for. Set `LOG_FORMAT=json` to get them as
fields rather than inside the message text; the default is `text`, which is for
reading in a terminal, so anywhere the logs are actually collected wants the
JSON form. With `OTLP_LOGS_ENABLED` the same records are *also* posted to the
collector. The stderr copy is never replaced: `kubectl logs` keeps working, and
a collector outage costs a copy rather than the record.

**Metrics** are declared in
[`core/switch_core/observability/catalogue.py`](../../core/switch_core/observability/catalogue.py),
which is the reference for what exists. Nothing not declared there can be
recorded — the registry rejects an unknown name and an attribute the spec does
not list.

**Traces** are not implemented. See "What is missing" below.

**The agent event streams are counted but not timed.** A long poll is held
open until something happens or the caller's own timeout expires, so its
duration measures a parameter the client chose rather than anything this
server did. In a latency histogram that is worse than useless: it would make
those routes' percentiles meaningless and, sharing an axis, flatten every
other route to the floor. They are counted like everything else.

**What is timed, as against counted.** Four things: HTTP requests, message
delivery lag, database statements and outbound calls to a collaboration
platform. That set is chosen to answer "what is slow" without guessing — on
this server a slow request is nearly always a slow query or a slow platform,
and those are the two the process cannot see from a count alone. A database
statement is timed around the driver call by SQLAlchemy's cursor events
(`observability/query.py`), so what is measured is the round trip rather than
the Python either side of it; the statement text never becomes an attribute,
only its leading keyword mapped through a fixed table. A statement that raised
is not timed, because a query that failed in four milliseconds is not evidence
the database is fast.

**Not every HTTP surface is counted.** `switch.http.*` comes from middleware on
the FastAPI app, which is the agent bridge, the MCP mount and the gateway
beneath it. Two listeners sit outside it — the Teams bridge and the
collaboration callback ingress each run their own `aiohttp` server on their own
port — so their traffic appears in no request metric. Read the HTTP panels as
"the main API", not "everything this process serves".

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

## What is counted because it is otherwise invisible

Most of the catalogue is volume and state — useful, and you would miss it, but
its absence would not mislead anyone. A handful of counters exist for a
different reason: each one measures something that is *already handled*, and
handled in a way that leaves no trace.

- **`switch.messages.delivery_failures`** — the delivery loop swallows one
  room's exception so it cannot stop the others. Correct, and it means a room
  that stopped delivering leaves only a log line.
- **`switch.messages.send_failures`** — a send that raises before the commit
  writes nothing, so the symptom is an absence, and an absence is what a quiet
  room looks like too.
- **`switch.agent.events_dropped`** — an agent's buffer discards events when it
  overflows or when they age out. The agent is *told* it missed them, so
  nothing is hidden from the agent; nothing told anybody else.
- **`switch.agent.connections_expired`** — a lapsed heartbeat closes a
  connection and the agent reconnects. A gauge of live connections stays
  perfectly flat while that happens as fast as it can.
- **`switch.bridge.errors`** — an inbound bridge failure is a message a person
  sent that nobody received; from the platform it is indistinguishable from
  being ignored.
- **`switch.connectors.running`** — connectors start fire-and-forget, each
  failure logged and stepped over, so one that never came up is a dead agent
  host nothing else reports.

If you add another place that catches an exception to keep something alive,
this is the list it belongs on.

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
memory, CPU, descriptors and garbage collections, with no extra dependency.
CPU and collection counts come from the standard library and work anywhere;
memory and open descriptors are read from `/proc/self`, so off Linux those two
are absent rather than fabricated, and a warning at startup names them.

**Event-loop lag is the one no external agent could produce.** The server is
single-threaded and cooperative: one blocking call stalls every room, every
bridge and every heartbeat at once, and from the outside that looks like an
unrelated timeout somewhere else. The connection sweep already measured its own
oversleep to avoid expiring connections it had simply failed to hear from; that
number is now reported instead of discarded.

## What a Datadog agent would add

There is no Datadog agent in this cluster, and nothing above needs one — an
application reporting over OTLP covers application health on its own. What an
agent adds is everything the application is not in a position to know, and the
list is worth writing down because the gaps are not obvious from a dashboard
that looks full.

**It can report the process's death.** This is the structural one. Everything
here is reported *by* switch-core, so a process that is OOM-killed or
segfaults takes its queued logs and its last metric interval with it. What
survives is an alert saying reporting stopped — which says something happened
and nothing about what. An agent watches from outside and reports the restart,
the exit code and the kill reason.

**Limits, not just usage.** The process reads its own resident memory from
`/proc/self`, which is the numerator. The cgroup limit it is measured against,
and CPU throttling when it exceeds its quota, are container facts it cannot
see. A server being throttled looks from the inside like a server that is
mysteriously slow — and the event-loop lag metric would show the symptom while
naming nothing.

**Kubernetes state.** Pod phase, restart counts, evictions, pending pods that
never scheduled, node pressure, PersistentVolume usage. The last matters more
than it sounds: Postgres and Mattermost hold this deployment's data on
volumes, and nothing currently reports how full they are.

**The database from the database's side.** Switch reports its own connection
pool, which answers "are we holding too many connections" and not "is the
database struggling". The agent's Postgres integration gives query
performance, locks, replication lag and server-side connection counts. Given
that the database is the one dependency that gates readiness, seeing only the
client's half of it is a real gap.

**Log collection without an in-process shipper.** An agent tailing container
output would make `OTLP_LOGS_ENABLED` unnecessary and would capture the lines
a dying process cannot flush.

**Trace intake.** An agent accepts OTLP traces directly, which is one of the
two ways the gap below gets closed.

None of this blocks the work here, and none of it should be added to the
application — it is infrastructure, tracked separately.

## What is missing

**Tracing.** The export path is signal-agnostic, but nothing produces spans,
and the relay Switch reports to does not serve `/v1/traces` — a POST there
returns 404. Two things have to happen: the collector must accept the signal,
and the server must produce spans.

This is the one item of CHOO-1414 that is not built, and it is the one that
ticket marks *optional*. The order matters: spans built against a collector
that 404s cannot be turned on, cannot be verified, and would be reviewed
against nothing. The collector side is tracked with the infrastructure work
(an agent that accepts OTLP traces directly is one of the two ways it closes);
the server side is a day's work once there is somewhere to send them, and the
log records already carry the fields to correlate against.

There is deliberately **no** `OTLP_TRACES_ENABLED` setting in the meantime. A
flag a deployment can turn on and see no difference from is a configuration
surface that lies about what it controls; it arrives when there is something
for it to switch off.

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
