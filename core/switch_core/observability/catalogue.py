"""Every metric this server emits, and the attributes each may carry.

Nothing undeclared can be recorded — the registry rejects an unknown name or
attribute key. Two reasons, both sharper on a multi-tenant server:

**Cardinality.** A metric costs its number of distinct attribute combinations,
and the values that feel most natural to attach — room id, agent id, the raw
path — are unbounded. Declaring the permitted keys makes that a test failure
rather than an invoice.

**Disclosure.** Dashboards are read by people who are not entitled to a given
tenant's rows, so tenant attribution stays out of metrics. Tenant-attributed
reporting is a product-events concern (CHOO-2806) carried as log records.

Every attribute VALUE must come from a fixed set the code controls. Where that
cannot be guaranteed at the call site, it does not belong in a metric.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

MetricKind = Literal["sum", "gauge", "histogram"]

# A ceiling, not a target: crossing it means a call site is passing something
# unbounded, and the registry says so rather than absorbing it.
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
# `route` is the template, never the resolved path. `status_class` is
# "2xx"/"4xx"/"5xx": the question is "are we failing", and the code is in the
# logs.
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
    "Wall time to serve an HTTP request. The agent event streams and the MCP "
    "mount are counted but not timed: they are held open for a wait the caller "
    "chooses. See `observability.http.UNTIMED_ROUTES`.",
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
# The pool gauges say whether connections are scarce; this says whether the
# database is slow, which is the other half and the one a slow request is
# usually about. `operation` is the statement's leading keyword mapped through
# a fixed table — never the statement, which is unbounded and carries literals.
DB_QUERY_DURATION = _spec(
    "switch.db.query.duration",
    "histogram",
    "ms",
    "Round trip for one statement, measured around the driver call. A "
    "statement that raised is not timed: a query that failed in four "
    "milliseconds is not evidence the database is fast.",
    "operation",
)

# ── Message transport ────────────────────────────────────────────────────────
MESSAGES_SENT = _spec(
    "switch.messages.sent",
    "sum",
    "{message}",
    "Messages accepted into the room, counted after the write commits. "
    "`kind:ephemeral` is the exception: presence-like state is delivered live "
    "and never stored.",
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
    "Sends that raised before the row was committed. Without this a database "
    "outage shows as an absence, which is what a quiet room looks like too.",
    "kind",
)
DELIVERY_FAILURES = _spec(
    "switch.messages.delivery_failures",
    "sum",
    "{failure}",
    "Delivery-loop iterations that raised. The loop survives these by design, "
    "which is what makes them invisible without a counter.",
)
DELIVERY_LAG = _spec(
    "switch.messages.delivery_lag",
    "histogram",
    "ms",
    "Age of a message when it reached a client's handler — whether the room is "
    "keeping up, measured per delivery rather than inferred from a queue.",
    "kind",
)

# ── Collaboration bridges ────────────────────────────────────────────────────
# `platform` is one of the registered adapter types, bounded by the code.
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
    "Relays attempted out to a collaboration platform — the denominator "
    "`switch.bridge.errors` is a fraction of.",
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
    "Collaboration bridges with a live task, by platform. A configured bridge "
    "missing here has crashed — and without `platform` the total says how many "
    "died and never which, which is the first thing anyone asks.",
    "platform",
)
BRIDGE_CALL_DURATION = _spec(
    "switch.bridge.call.duration",
    "histogram",
    "ms",
    "Round trip for one outbound call to a collaboration platform. The bridge "
    "counters say whether relays are failing; this says whether they are "
    "arriving late, which is what a room that feels unresponsive actually is.",
    "platform",
    "kind",
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
    "Buffered events discarded before an agent read them. `reason` separates "
    "an agent that cannot keep up (overflow) from one away too long "
    "(retention).",
    "reason",
)
AGENT_CONNECTIONS_EXPIRED = _spec(
    "switch.agent.connections_expired",
    "sum",
    "{connection}",
    "Agent connections closed on a lapsed heartbeat. A steady rate against a "
    "flat connection count is churn, which a gauge alone cannot show.",
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
    "Server-side connectors running. Started fire-and-forget with each failure "
    "logged and stepped over, so one short of the configured count is a dead "
    "agent host nothing else reports.",
)

# ── Process and runtime ──────────────────────────────────────────────────────
# What an infrastructure agent would report, and there is none deployed. Still
# useful once there is: the process knows things the node does not.
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
    "single-threaded, so this is the one number that says whether anything is "
    "being starved.",
)
RUNTIME_GC_COLLECTIONS = _spec(
    "switch.runtime.gc_collections",
    "sum",
    "{collection}",
    "Garbage collections, by generation.",
    "generation",
)

# ── Health ───────────────────────────────────────────────────────────────────
# One series per dependency, so a dashboard shows which one broke.
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
        DB_QUERY_DURATION,
        MESSAGES_SENT,
        MESSAGES_DELIVERED,
        SEND_FAILURES,
        DELIVERY_FAILURES,
        DELIVERY_LAG,
        BRIDGE_EVENTS_IN,
        BRIDGE_EVENTS_OUT,
        BRIDGE_ERRORS,
        BRIDGES_RUNNING,
        BRIDGE_CALL_DURATION,
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
