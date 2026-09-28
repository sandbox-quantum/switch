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

from switch_core.observability.otlp import SUB_MILLISECOND_BOUNDS_MS

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
    # Histograms only, and only where the default set cannot resolve the
    # measurement: bounds are the resolution, and a histogram whose readings
    # all land in one bucket reports that bucket for ever. None means the
    # shared latency bounds, which suit anything measured in tens of
    # milliseconds and upwards.
    bounds: tuple[float, ...] | None = None


def _spec(
    name: str,
    kind: MetricKind,
    unit: str,
    description: str,
    *attributes: str,
    bounds: tuple[float, ...] | None = None,
) -> MetricSpec:
    return MetricSpec(
        name=name,
        kind=kind,
        unit=unit,
        description=description,
        attributes=frozenset(attributes),
        bounds=bounds,
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
    "The most connections checked out of the pool at once since the last "
    "reading — a peak, not a snapshot. Exhaustion here is a burst that fills and "
    "drains the pool inside a few hundred milliseconds, which a value sampled "
    "once a minute would step straight over.",
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
# The pool gauges say how full the pool got; this says when full stopped being
# enough. The pool queues rather than sheds when saturated, so a request that
# waited out `db_pool_timeout` without a connection is the failure a peak at the
# ceiling only implies. Counted on the request path, which is where every
# observed timeout has originated — auth resolves a token against the database
# before the handler runs, so a saturated pool surfaces there first. A
# background loop that times out is logged, not counted here.
DB_POOL_TIMEOUTS = _spec(
    "switch.db.pool.timeouts",
    "sum",
    "{timeout}",
    "Requests that gave up waiting for a pooled connection. Loud where a pool "
    "at its ceiling is only suggestive: this is a request that got no connection "
    "at all within the timeout.",
)
# How long a connection stayed borrowed, by who borrowed it. The peak above
# says the pool filled; this says which code was holding it. `caller` is the
# first switch_core function on the stack when the connection was handed out,
# as `module:function`, so the series count is bounded by the code, not the
# traffic. A hold far longer than the queries inside it is code awaiting
# something else with a connection in hand.
DB_POOL_HOLD_DURATION = _spec(
    "switch.db.pool.hold.duration",
    "histogram",
    "ms",
    "How long a pooled connection stayed checked out, by the code that "
    "borrowed it. Compare with query duration: a hold much longer than its "
    "queries is code waiting on something else while holding a connection.",
    "caller",
)
# The timeouts above count requests that waited the full `db_pool_timeout`;
# this is every wait, so a pool that makes requests queue for 200 ms shows up
# long before one makes them give up.
DB_POOL_WAIT_DURATION = _spec(
    "switch.db.pool.wait.duration",
    "histogram",
    "ms",
    "Time from asking the pool for a connection to getting one, including "
    "opening a new one when the pool grows. Requests that timed out are not "
    "here; they are counted in switch.db.pool.timeouts.",
    bounds=SUB_MILLISECOND_BOUNDS_MS,
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
    "milliseconds is not evidence the database is fast. Not every statement "
    "the process runs — see `observability/query.py` for what is outside it, "
    "notably migrations and the message listener.",
    "operation",
    bounds=SUB_MILLISECOND_BOUNDS_MS,
)

# What the database itself reports, sampled by this server on a connection of
# its own rather than one from the pool above: the case worth seeing is the pool
# exhausted, when a pooled connection is the one thing a sampler cannot get.
# Only the server role's own sessions in its own database are counted, which is
# also all `pg_stat_activity` shows a role that is not a superuser.
DB_SERVER_CONNECTIONS = _spec(
    "switch.db.server.connections",
    "gauge",
    "{connection}",
    "Sessions the database holds for this server's role, by state, as of the "
    "last sample. `idle_in_transaction` is a connection checked out and held "
    "across work that is not a query, the usual way a pool runs dry. Counts "
    "every replica's sessions, not only this one's.",
    "state",
)
DB_SERVER_TRANSACTIONS = _spec(
    "switch.db.server.transactions",
    "sum",
    "{transaction}",
    "Transactions committed or rolled back in this server's database, from the "
    "database's own counters. Counts every client of the database, every "
    "replica included.",
)

# ── Message transport ────────────────────────────────────────────────────────
MESSAGES_SENT = _spec(
    "switch.messages.sent",
    "sum",
    "{message}",
    "Messages accepted into the room, counted after the write commits. "
    "`kind:ephemeral` is the exception: presence-like state is delivered live "
    "and never stored. `actor` is who wrote it: human, agent, system or bridge.",
    "kind",
    "actor",
)
MESSAGES_DELIVERED = _spec(
    "switch.messages.delivered",
    "sum",
    "{message}",
    "Messages handed to a client's handler. `actor` is who read it: agent, "
    "system or bridge. Never human, because a human actor reads nothing.",
    "kind",
    "actor",
)
SEND_FAILURES = _spec(
    "switch.messages.send_failures",
    "sum",
    "{failure}",
    "Sends that raised before the row was committed. Without this a database "
    "outage shows as an absence, which is what a quiet room looks like too. "
    "`actor` is who was writing.",
    "kind",
    "actor",
)
DELIVERY_FAILURES = _spec(
    "switch.messages.delivery_failures",
    "sum",
    "{failure}",
    "Delivery-loop iterations that raised. The loop survives these by design, "
    "which is what makes them invisible without a counter. `actor` is whose "
    "loop it was.",
    "actor",
)
OBSERVER_FAILURES = _spec(
    "switch.messages.observer_failures",
    "sum",
    "{failure}",
    "Reports about a message that raised: the transport telling its observer "
    "after the commit, or an agent's consumer reporting a message addressed to "
    "it. The message is unaffected and only the report is lost, so these are "
    "caught by design and invisible without a counter. `actor` is who was "
    "writing or reading.",
    "actor",
)
DELIVERY_LAG = _spec(
    "switch.messages.delivery_lag",
    "histogram",
    "ms",
    "Age of a message when it reached a client's handler — whether the room is "
    "keeping up, measured per delivery rather than inferred from a queue. "
    "`actor` is who read it.",
    "kind",
    "actor",
)

# ── Shared room reads ────────────────────────────────────────────────────────
# The per-room cache of recent rows (`transport/room_cache.py`). Every value
# below comes from a fixed set in that module.
DELIVERY_CACHE_READS = _spec(
    "switch.delivery_cache.reads",
    "sum",
    "{read}",
    "A transport asking the room cache for the rows after its cursor. "
    "`outcome` is hit (served from memory), filled (served after waiting for "
    "the room's one read), or why it fell back to its own database read: "
    "behind (cursor below what is held), evicted (dropped while it waited, "
    "and the read it waited for could not answer it), "
    "unwatched, or gave_up.",
    "outcome",
)
DELIVERY_CACHE_FILLS = _spec(
    "switch.delivery_cache.fills",
    "sum",
    "{fill}",
    "Database reads made by the room cache on behalf of every member of a "
    "room. `outcome` is ok, failed, or discarded (the room was dropped while "
    "it read).",
    "outcome",
)
DELIVERY_CACHE_ROWS_READ = _spec(
    "switch.delivery_cache.rows_read",
    "sum",
    "{row}",
    "Rows the room cache read from the database. Against "
    "switch.messages.delivered, the number of deliveries each read served.",
)
DELIVERY_CACHE_EVICTIONS = _spec(
    "switch.delivery_cache.evictions",
    "sum",
    "{eviction}",
    "Rows or rooms the room cache let go of, by reason: bytes or rooms (the "
    "process-wide limits), rows or age (one room's), unwatched (its last "
    "member left), invalidated.",
    "reason",
)
DELIVERY_CACHE_BYTES = _spec(
    "switch.delivery_cache.bytes",
    "gauge",
    "By",
    "Estimated memory the room cache holds, against room_delivery_cache_max_bytes.",
)
DELIVERY_CACHE_ROOMS = _spec(
    "switch.delivery_cache.rooms",
    "gauge",
    "{room}",
    "Rooms the room cache holds rows for.",
)

# ── Bridges ──────────────────────────────────────────────────────────────────
# Both bridges report the same metrics. `bridge` is "collaboration" or
# "agent". For a collaboration bridge `platform` is one of the registered
# adapter types, bounded by the code; the agent bridge reports "switch",
# because agents speak Switch's own protocol. On the agent side an event in is
# an operation an agent called (`event` is the operation's name, bounded by the
# registry), an event out is one delivered on its stream, and a call is an
# operation's run.
BRIDGE_EVENTS_IN = _spec(
    "switch.bridge.events_in",
    "sum",
    "{event}",
    "Events accepted by a bridge: from a platform, or operations from an agent.",
    "bridge",
    "platform",
    "event",
)
BRIDGE_EVENTS_OUT = _spec(
    "switch.bridge.events_out",
    "sum",
    "{event}",
    "Relays attempted out through a bridge, to a platform or down an agent's "
    "stream — the denominator "
    "`switch.bridge.errors` is a fraction of.",
    "bridge",
    "platform",
    "kind",
)
BRIDGE_ERRORS = _spec(
    "switch.bridge.errors",
    "sum",
    "{error}",
    "Bridge operations that raised, by direction.",
    "bridge",
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
    "bridge",
    "platform",
)
BRIDGE_CALL_DURATION = _spec(
    "switch.bridge.call.duration",
    "histogram",
    "ms",
    "Round trip for one outbound call to a collaboration platform. The bridge "
    "counters say whether relays are failing; this says whether they are "
    "arriving late, which is what a room that feels unresponsive actually is.",
    "bridge",
    "platform",
    "kind",
)
BRIDGE_THROTTLE_HELD = _spec(
    "switch.bridge.throttle.held",
    "histogram",
    "s",
    "How long a publication was held back by a platform rate limit, recorded "
    "each time one is refused for it. `delivery` separates a bot one tenant "
    "owns from a shared app bot, where one tenant's burst holds back every "
    "other tenant's — a rising `shared` reading is what says per-tenant "
    "fairness has started to matter.",
    "platform",
    "delivery",
    bounds=(1.0, 2.0, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0, 600.0),
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
# The buffer answers a read and an unread count by walking the agent's retained
# events from the oldest. These say what that walk costs, so whether to index
# the buffer is decided from data. `operation` is "read" or "unread".
AGENT_BUFFER_SCANNED = _spec(
    "switch.agent.buffer.scanned",
    "histogram",
    "{event}",
    "Retained events walked to answer one buffer read or unread count. Bounded "
    "by the per-agent cap, so a p95 near it means every read walks a full buffer.",
    "operation",
    bounds=(0.0, 10.0, 50.0, 100.0, 250.0, 500.0, 1000.0, 1500.0, 2000.0),
)
AGENT_BUFFER_SCAN_DURATION = _spec(
    "switch.agent.buffer.scan.duration",
    "histogram",
    "ms",
    "Wall time of one buffer read or unread count. A read runs on every pass "
    "of a connection's delivery loop, an unread count on every addressed event "
    "it delivers.",
    "operation",
    bounds=(0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 25.0, 100.0),
)
# `reason` is from a fixed set the refusal sites choose. `transport_removed` is
# a client still asking for the retired event stream, the one way to see old
# clients that never manage to connect at all. Nothing sends it while the event
# stream is kept for its compatibility window; it is kept here for the release
# that removes the stream, when it starts firing again.
AGENT_CONNECTIONS_REFUSED = _spec(
    "switch.agent.connections_refused",
    "sum",
    "{connection}",
    "Agent connections refused on opening, by reason: transport_removed (an "
    "old client asking for the event stream), protocol (no agent-protocol "
    "revision in common), unauthorized (no valid credential), other.",
    "reason",
)
AGENT_CONNECTIONS_EXPIRED = _spec(
    "switch.agent.connections_expired",
    "sum",
    "{connection}",
    "Agent connections closed on a lapsed heartbeat, whichever path noticed: "
    "the sweep, the next use of the dead connection, or its own event stream. "
    "A steady rate against a flat connection count is churn, which a gauge "
    "alone cannot show.",
)

# Every stream open, by what it was. `reattach` is a live connection whose
# socket came back; `after_lapse` and `after_close` are a connection id this
# process closed recently, coming back; `fresh` is one this process has never
# seen, which is a first connect or anything after a server restart. A burst
# of `after_lapse` is the reconnect storm the expiry counter only implies.
AGENT_CONNECTIONS_OPENED = _spec(
    "switch.agent.connections_opened",
    "sum",
    "{connection}",
    "Agent event streams opened, by kind: reattach, after_lapse, after_close or fresh.",
    "kind",
)

# ── Agents and clients ───────────────────────────────────────────────────────
# `client` is the declared artifact when the registry knows the name, else
# `other` or `unknown`. Never the declared version: the client chooses it.
# `transport` is `websocket`, `sse` (an old client on the event stream, kept
# for a compatibility window that ends when this stays at zero), `detached`
# (the stream dropped, and the connection waits out its heartbeat window), or
# `controller` (run by an agents controller, on that controller's connection).
AGENTS_CONNECTED = _spec(
    "switch.agents.connected",
    "gauge",
    "{agent}",
    "Agents holding a live protocol connection, by transport (websocket, sse, "
    "detached, controller) and client. An agent connected more than one way counts once "
    "under each, so summing across the attributes can exceed the number of "
    "agents.",
    "transport",
    "client",
)
CONSUMERS_RUNNING = _spec(
    "switch.consumers.running",
    "gauge",
    "{consumer}",
    "Room consumers with a live read loop. Actors that only write (a person on "
    "another platform) run no loop and are not counted. A collaboration "
    "bridge's workspace consumer counts under switch.bridges.running.",
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
# One per process start, so a restart lines up against everything else on a
# dashboard. The version is already on every series' resource.
RUNTIME_STARTS = _spec(
    "switch.runtime.starts",
    "sum",
    "{start}",
    "Process starts. A marker: deploys and restarts, to line up against "
    "reconnect bursts and pool peaks.",
)
RUNTIME_GC_COLLECTIONS = _spec(
    "switch.runtime.gc_collections",
    "sum",
    "{collection}",
    "Garbage collections, by generation.",
    "generation",
)
# Measured from inside the collector, so unlike the event-loop lag above it
# catches every pause, not only one that happens to overlap the sweep timer's
# wake. A full collection walks every tracked object with the interpreter lock
# held: on a large heap that freezes the event loop as surely as blocking code.
RUNTIME_GC_PAUSE = _spec(
    "switch.runtime.gc_pause",
    "histogram",
    "ms",
    "How long each garbage collection stopped the process, by generation. "
    "Generation 2 is the full collection, the one that grows with the heap.",
    "generation",
    bounds=(0.1, 0.5, 1.0, 5.0, 10.0, 25.0, 50.0, 100.0, 250.0, 500.0, 1000.0),
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
        DB_POOL_TIMEOUTS,
        DB_POOL_HOLD_DURATION,
        DB_POOL_WAIT_DURATION,
        DB_QUERY_DURATION,
        DB_SERVER_CONNECTIONS,
        DB_SERVER_TRANSACTIONS,
        MESSAGES_SENT,
        MESSAGES_DELIVERED,
        SEND_FAILURES,
        DELIVERY_FAILURES,
        OBSERVER_FAILURES,
        DELIVERY_LAG,
        DELIVERY_CACHE_READS,
        DELIVERY_CACHE_FILLS,
        DELIVERY_CACHE_ROWS_READ,
        DELIVERY_CACHE_EVICTIONS,
        DELIVERY_CACHE_BYTES,
        DELIVERY_CACHE_ROOMS,
        BRIDGE_EVENTS_IN,
        BRIDGE_EVENTS_OUT,
        BRIDGE_ERRORS,
        BRIDGES_RUNNING,
        BRIDGE_CALL_DURATION,
        BRIDGE_THROTTLE_HELD,
        AGENT_EVENTS_DROPPED,
        AGENT_BUFFER_SCANNED,
        AGENT_BUFFER_SCAN_DURATION,
        AGENT_CONNECTIONS_REFUSED,
        AGENT_CONNECTIONS_EXPIRED,
        AGENT_CONNECTIONS_OPENED,
        AGENTS_CONNECTED,
        CONSUMERS_RUNNING,
        CONNECTORS_RUNNING,
        RUNTIME_MEMORY_RSS,
        RUNTIME_CPU_SECONDS,
        RUNTIME_OPEN_FDS,
        RUNTIME_EVENT_LOOP_LAG,
        RUNTIME_STARTS,
        RUNTIME_GC_COLLECTIONS,
        RUNTIME_GC_PAUSE,
        HEALTH_CHECK,
    )
}
