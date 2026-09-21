"""Every metric this server emits, and the attributes each may carry.

Nothing is recorded that is not declared here. The registry rejects an unknown
metric name and an attribute key the spec does not name, which buys two things
that matter more on a server than they did in the desktop app this pattern
comes from:

**Cardinality.** A metric's cost is the number of distinct attribute
combinations it produces, and the values that feel most natural to attach —
room id, agent id, the raw request path — are unbounded. One of them reaching
a call site is not a slightly noisier dashboard, it is a bill and a collector
that starts dropping. Declaring the permitted keys makes that a test failure
rather than an invoice.

**Disclosure.** Switch is multi-tenant, and a metric is not the place tenant
data is allowed to surface: metrics are read by whoever can see the deployment's
dashboards, which is not the same set of people as those entitled to a given
tenant's rows. Tenant-attributed reporting is a product-events concern
(CHOO-2806) travelling as log records, where it is scoped and consented
separately.

Every attribute VALUE must come from a fixed set the code controls — a platform
name, a route template, a status class. When that cannot be guaranteed at the
call site, it does not belong in a metric.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

MetricKind = Literal["sum", "gauge", "histogram"]

# How many distinct attribute combinations one metric may produce before the
# registry stops accepting new ones. A ceiling rather than a target: crossing
# it means a call site is passing something unbounded, and the registry says so
# out loud rather than absorbing it.
MAX_SERIES_PER_METRIC = 500


@dataclass(frozen=True)
class MetricSpec:
    name: str
    kind: MetricKind
    unit: str
    description: str
    attributes: frozenset[str] = field(default_factory=frozenset)


def _spec(
    name: str,
    kind: MetricKind,
    unit: str,
    description: str,
    *attributes: str,
) -> MetricSpec:
    return MetricSpec(
        name=name,
        kind=kind,
        unit=unit,
        description=description,
        attributes=frozenset(attributes),
    )


# ── HTTP ─────────────────────────────────────────────────────────────────────
# `route` is the route *template* ("/agents/{agent_id}/rooms"), never the
# resolved path: the resolved path carries an id per request and is precisely
# the unbounded value this catalogue exists to keep out. `status_class` is
# "2xx"/"4xx"/"5xx" rather than the code, because the question a dashboard asks
# is "are we failing", and the exact code is in the logs.
HTTP_REQUESTS = _spec(
    "switch.http.requests",
    "sum",
    "{request}",
    "HTTP requests served, by route and outcome.",
    "route",
    "method",
    "status_class",
)
HTTP_REQUEST_DURATION = _spec(
    "switch.http.request.duration",
    "histogram",
    "ms",
    "Wall time to serve an HTTP request. The agent event streams are counted "
    "but not timed — they are held open for a wait the caller chooses, which "
    "is not a measure of this server's speed. See `observability.http."
    "UNTIMED_ROUTES`.",
    "route",
    "method",
)

# ── Database ─────────────────────────────────────────────────────────────────
DB_POOL_IN_USE = _spec(
    "switch.db.pool.in_use",
    "gauge",
    "{connection}",
    "Connections checked out of the pool right now.",
)
DB_POOL_SIZE = _spec(
    "switch.db.pool.size",
    "gauge",
    "{connection}",
    "Connections the pool is holding.",
)
DB_POOL_OVERFLOW = _spec(
    "switch.db.pool.overflow",
    "gauge",
    "{connection}",
    "Connections open beyond the pool's nominal size.",
)

# ── Message transport ────────────────────────────────────────────────────────
MESSAGES_SENT = _spec(
    "switch.messages.sent",
    "sum",
    "{message}",
    "Messages accepted into the room. Counted after the write commits, so "
    "a database outage stops this rather than drawing an unbroken rate. "
    "`kind:ephemeral` is the exception — presence-like state is delivered "
    "live and never stored.",
    "kind",
)
MESSAGES_DELIVERED = _spec(
    "switch.messages.delivered",
    "sum",
    "{message}",
    "Messages handed to a client's handler.",
    "kind",
)
SEND_FAILURES = _spec(
    "switch.messages.send_failures",
    "sum",
    "{failure}",
    "Sends that raised before the row was committed. `switch.messages.sent` "
    "counts only what persisted, so without this a database outage shows as "
    "an absence — and an absence looks the same as a quiet room.",
    "kind",
)
DELIVERY_FAILURES = _spec(
    "switch.messages.delivery_failures",
    "sum",
    "{failure}",
    "Delivery-loop iterations that raised. The loop survives these by design, "
    "so they are invisible without this counter.",
)
DELIVERY_LAG = _spec(
    "switch.messages.delivery_lag",
    "histogram",
    "ms",
    "Age of a message when it reached a client's handler. The number that "
    "says whether the room is keeping up, measured per delivery rather than "
    "inferred from a queue depth.",
    "kind",
)

# ── Collaboration bridges ────────────────────────────────────────────────────
# `platform` is one of the five registered adapter types, so it is bounded by
# the code rather than by what a caller passes.
BRIDGE_EVENTS_IN = _spec(
    "switch.bridge.events_in",
    "sum",
    "{event}",
    "Events accepted from a collaboration platform.",
    "platform",
    "event",
)
BRIDGE_EVENTS_OUT = _spec(
    "switch.bridge.events_out",
    "sum",
    "{event}",
    "Relays attempted out to a collaboration platform. Counted before the "
    "attempt, so it is the denominator `switch.bridge.errors` is a fraction "
    "of.",
    "platform",
    "kind",
)
BRIDGE_ERRORS = _spec(
    "switch.bridge.errors",
    "sum",
    "{error}",
    "Bridge operations that raised, by direction.",
    "platform",
    "direction",
)
BRIDGES_RUNNING = _spec(
    "switch.bridges.running",
    "gauge",
    "{bridge}",
    "Collaboration bridges with a live task. A configured bridge missing here "
    "has crashed.",
)

# ── Agent protocol ───────────────────────────────────────────────────────────
# The agent-side counterpart to the delivery counters above. An event that
# reaches the buffer and is dropped before the agent reads it is the same class
# of loss as a delivery that raised, and until this existed only one of the two
# was countable.
AGENT_EVENTS_DROPPED = _spec(
    "switch.agent.events_dropped",
    "sum",
    "{event}",
    "Buffered events discarded before an agent read them. The agent is told it "
    "missed events when it next reads, so this is disclosed rather than "
    "silent — but nothing counted it. `reason` separates an agent that cannot "
    "keep up (overflow) from one that was away too long (retention).",
    "reason",
)
AGENT_CONNECTIONS_EXPIRED = _spec(
    "switch.agent.connections_expired",
    "sum",
    "{connection}",
    "Agent connections closed because their heartbeat lapsed. A steady rate "
    "against a flat connection count is churn: agents reconnecting as fast as "
    "they are being expired, which a gauge alone cannot show.",
)

# ── Agents and clients ───────────────────────────────────────────────────────
AGENTS_CONNECTED = _spec(
    "switch.agents.connected",
    "gauge",
    "{agent}",
    "Agents holding a live protocol connection.",
)
CLIENTS_RUNNING = _spec(
    "switch.clients.running",
    "gauge",
    "{client}",
    "Room clients with a live task.",
)
CONNECTORS_RUNNING = _spec(
    "switch.connectors.running",
    "gauge",
    "{connector}",
    "Server-side connectors running. Started fire-and-forget at boot, with "
    "each failure logged and stepped over — so a connector short of the "
    "configured count is a dead agent host that nothing else reports.",
)

# ── Process and runtime ──────────────────────────────────────────────────────
# What an infrastructure agent would otherwise report. Switch has no Datadog
# agent deployed, so the process reports on itself; these stay useful even
# once one exists, because the app knows things the node does not.
RUNTIME_MEMORY_RSS = _spec(
    "switch.runtime.memory_rss",
    "gauge",
    "By",
    "Resident set size of the server process.",
)
RUNTIME_CPU_SECONDS = _spec(
    "switch.runtime.cpu_seconds",
    "sum",
    "s",
    "CPU time consumed by the server process.",
    "mode",
)
RUNTIME_OPEN_FDS = _spec(
    "switch.runtime.open_fds",
    "gauge",
    "{file}",
    "Open file descriptors. Climbing without bound is a leak.",
)
RUNTIME_EVENT_LOOP_LAG = _spec(
    "switch.runtime.event_loop_lag",
    "gauge",
    "ms",
    "How far past its deadline a fixed-interval task woke. The server is "
    "single-threaded and cooperative, so this is the one number that says "
    "whether anything is being starved.",
)
RUNTIME_GC_COLLECTIONS = _spec(
    "switch.runtime.gc_collections",
    "sum",
    "{collection}",
    "Garbage collections, by generation.",
    "generation",
)

# ── Health ───────────────────────────────────────────────────────────────────
# One series per dependency, 1 when that dependency answered and 0 when it did
# not — so a dashboard shows *which* one broke, and an alert on the readiness
# route does not have to guess.
HEALTH_CHECK = _spec(
    "switch.health.check",
    "gauge",
    "{status}",
    "1 when a readiness dependency passed its last check, 0 when it failed.",
    "check",
)

CATALOGUE: dict[str, MetricSpec] = {
    spec.name: spec
    for spec in (
        HTTP_REQUESTS,
        HTTP_REQUEST_DURATION,
        DB_POOL_IN_USE,
        DB_POOL_SIZE,
        DB_POOL_OVERFLOW,
        MESSAGES_SENT,
        MESSAGES_DELIVERED,
        SEND_FAILURES,
        DELIVERY_FAILURES,
        DELIVERY_LAG,
        BRIDGE_EVENTS_IN,
        BRIDGE_EVENTS_OUT,
        BRIDGE_ERRORS,
        BRIDGES_RUNNING,
        AGENT_EVENTS_DROPPED,
        AGENT_CONNECTIONS_EXPIRED,
        AGENTS_CONNECTED,
        CLIENTS_RUNNING,
        CONNECTORS_RUNNING,
        RUNTIME_MEMORY_RSS,
        RUNTIME_CPU_SECONDS,
        RUNTIME_OPEN_FDS,
        RUNTIME_EVENT_LOOP_LAG,
        RUNTIME_GC_COLLECTIONS,
        HEALTH_CHECK,
    )
}
