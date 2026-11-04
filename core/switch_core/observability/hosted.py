"""Metrics for hosted agents, from what hosted boxes already send Core.

Every hosted box's controller sends Core a status report, and the operator
sends an observation per machine. Nothing new runs in a box: the numbers
here are read out of those.

**Only numbers and fixed words leave.** A status report carries text a box
chose (`detail`, `directory`, provider messages) and ids (agents, sessions).
None of it is read here. Each report is reduced, as it arrives, to a summary
of bounded counts and words from the fixed sets below (`box_summary`), and
that summary is all the gauges ever see. A value outside a set becomes
`other` (or `none`), never itself.

**One process reports the gauges.** Several Core processes share one
database, and each would otherwise report every box. The sampler here takes
a session-level advisory lock on a connection of its own, and only the
process holding it reports. The lock goes with the connection if the process
dies, and another process's sampler takes it on its next try.

**The summaries live on the cloud machine row** (`cloud_machines.heartbeat`,
per workspace, beside the time of the report). That table is global, so the
sampler reads every box without binding a tenant, and nothing new is stored
beyond counts.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from switch_core.observability.catalogue import (
    CONTROLLER_CREDENTIAL_REFUSALS,
    HOSTED_AGENT_OOM_KILLS,
    HOSTED_AGENT_RESTARTS_10M,
    HOSTED_AGENTS,
    HOSTED_AGENTS_STOPPED,
    HOSTED_BOX_ANON_MEMORY,
    HOSTED_BOX_EVICTIONS,
    HOSTED_BOX_MEMORY_USED,
    HOSTED_BOXES_EXPECTED,
    HOSTED_BOXES_REPORTING,
    HOSTED_BOXES_VALVE_MEMORY,
    HOSTED_GATEWAY,
    HOSTED_GUARD_STOPS,
    HOSTED_SESSIONS,
    HOSTED_VALVE_PARKS,
    HOSTED_WAITING_FOR_ROOM,
)
from switch_core.observability.metrics import GaugeReading, metrics

logger = logging.getLogger(__name__)

# The controller's `PROCESS_STATES`, and the session states a report may carry
# (`none` for an agent with no session state).
PROCESS_STATES = (
    "pending",
    "starting",
    "running",
    "stopping",
    "stopped",
    "crashed",
    "failed",
)
SESSION_STATES = ("active", "waking", "parked", "none")
STOP_REASONS = ("out_of_memory", "crash_loop", "other")
VALVE_STATES = ("unprotected", "failing")
SESSION_KINDS = ("running", "max")
GATEWAY_KINDS = ("agents", "refused", "capped_boxes")

# The refusal codes the refusal guard is given (B91), and `lockout_started`.
# Any other code is counted as `other`.
REFUSAL_REASONS = frozenset(
    {
        "missing_credential",
        "invalid_credential",
        "token_expired",
        "controller_revoked",
        "workspace_not_enabled",
        "enrollment_code_invalid",
        "locked_out",
        "missing",
        "wrong",
        # The controller's bearer offered on the operator API (operator
        # bearer design v1.3): a worker still on the old bearer.
        "controller_token",
        "lockout_started",
        "other",
    }
)

# A report older than this counts as gone, so a silent box's agents drop out
# of the gauges rather than being reported as they were when it went quiet.
REPORT_FRESH_SECONDS = 180
# No count from a box is believed past this: a bigger one is clamped.
MAX_COUNT = 1_000_000

SAMPLE_INTERVAL_SECONDS = 30.0
SAMPLE_TIMEOUT_SECONDS = 5.0
FAILURE_LOG_INTERVAL_SECONDS = 60.0

# The lock the one reporting process holds. A fixed name, hashed by Postgres.
LOCK_NAME = "switch-hosted-metrics"

_FAILED_PROCESS_STATES = frozenset({"crashed", "failed"})


def _count(value: Any) -> int:
    """A count from a report: a non-negative int, clamped; anything else 0."""
    if isinstance(value, bool) or not isinstance(value, int):
        return 0
    return max(0, min(value, MAX_COUNT))


def _optional_count(value: Any) -> int | None:
    """A count a report may leave out: None when absent or not an int."""
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return max(0, min(value, MAX_COUNT))


def _word(value: Any, allowed: tuple[str, ...], fallback: str) -> str:
    return value if isinstance(value, str) and value in allowed else fallback


def stop_reason(reason: Any) -> str:
    return _word(reason, STOP_REASONS[:2], "other")


def refusal_reason(reason: str) -> str:
    return reason if reason in REFUSAL_REASONS else "other"


def box_summary(machine: Mapping[str, Any], agents: Any) -> dict[str, Any]:
    """A status report reduced to counts and fixed words: what the gauges read.

    `machine` is the report's `machine` object and `agents` its `agents` list,
    as stored. No id, name, path or free text is copied: each value is a
    bounded int, a bool, or a word from a fixed set.
    """
    by_state: dict[str, int] = {}
    stopped = dict.fromkeys(STOP_REASONS, 0)
    restarts = oom_kills = waiting = 0
    for agent in agents if isinstance(agents, list) else []:
        if not isinstance(agent, Mapping):
            continue
        process = _word(agent.get("process"), PROCESS_STATES, "other")
        if process == "other":
            # Core's schema takes any string; a state outside the set is not
            # counted rather than reported as text.
            continue
        session = _word(agent.get("session"), SESSION_STATES[:3], "none")
        key = f"{process}:{session}"
        by_state[key] = by_state.get(key, 0) + 1
        reason = agent.get("reason")
        # The memory guard reports its stop as `stopped` with this reason.
        if process in _FAILED_PROCESS_STATES or reason == "out_of_memory":
            stopped[stop_reason(reason)] += 1
        restarts += _count(agent.get("restarts_10m"))
        oom_kills += _count(agent.get("oom_kills"))
        waiting_for_room = agent.get("waiting_for_room")
        if isinstance(waiting_for_room, Mapping):
            waiting += _count(waiting_for_room.get("count"))
    valve = machine.get("valve_memory")
    return {
        "agents": by_state,
        "stopped": stopped,
        "restarts_10m": min(restarts, MAX_COUNT),
        "oom_kills": min(oom_kills, MAX_COUNT),
        "waiting_for_room": min(waiting, MAX_COUNT),
        "sessions_running": _count(machine.get("sessions_running")),
        "sessions_max": _count(machine.get("sessions_max")),
        "valve_memory": valve if valve in VALVE_STATES else None,
        "gateway_agents": _count(machine.get("gateway_agents")),
        "gateway_refused": _count(machine.get("gateway_refused")),
        "gateway_capped": machine.get("gateway_capped") is True,
        "guard_stops": _optional_count(machine.get("guard_stops")),
        "valve_parks": _optional_count(machine.get("valve_parks")),
    }


def record_box_report(machine: Mapping[str, Any]) -> None:
    """The two per-report histograms, recorded as a hosted box's report arrives."""
    total = machine.get("mem_total_bytes")
    free = machine.get("mem_free_bytes")
    if (
        isinstance(total, int)
        and isinstance(free, int)
        and not isinstance(total, bool)
        and not isinstance(free, bool)
        and total > 0
        and 0 <= free <= total
    ):
        metrics().observe(HOSTED_BOX_MEMORY_USED, {}, 100.0 * (total - free) / total)
    anon = machine.get("mem_anon_bytes")
    if isinstance(anon, int) and not isinstance(anon, bool) and anon >= 0:
        metrics().observe(HOSTED_BOX_ANON_MEMORY, {}, float(anon))


def record_evictions(evictions: int | None) -> None:
    """Boxes the operator says were pushed off their machine."""
    if evictions:
        metrics().increment(HOSTED_BOX_EVICTIONS, {}, float(_count(evictions)))


def record_credential_refusal(reason: str) -> None:
    """One refused controller credential, by its fixed reason code only."""
    metrics().increment(
        CONTROLLER_CREDENTIAL_REFUSALS, {"reason": refusal_reason(reason)}
    )


@dataclass
class HostedSnapshot:
    """The gauges' values, as of one sample."""

    agents: dict[tuple[str, str], int] = field(default_factory=dict)
    stopped: dict[str, int] = field(
        default_factory=lambda: dict.fromkeys(STOP_REASONS, 0)
    )
    restarts_10m: int = 0
    oom_kills: int = 0
    waiting_for_room: int = 0
    sessions_running: int = 0
    sessions_max: int = 0
    valve_memory: dict[str, int] = field(
        default_factory=lambda: dict.fromkeys(VALVE_STATES, 0)
    )
    gateway_agents: int = 0
    gateway_refused: int = 0
    gateway_capped: int = 0
    boxes_reporting: int = 0
    boxes_expected: int = 0


@dataclass(frozen=True)
class MachineRow:
    """What the sampler reads of one cloud machine."""

    id: str
    state: str
    desired_state: str
    heartbeat: Mapping[str, Any] | None
    heartbeat_at: datetime | None


def _fresh(at: Any, now: datetime) -> bool:
    if isinstance(at, datetime):
        moment = at
    elif isinstance(at, str):
        try:
            moment = datetime.fromisoformat(at)
        except ValueError:
            return False
    else:
        return False
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return now - moment <= timedelta(seconds=REPORT_FRESH_SECONDS)


def expected_to_run(row: MachineRow) -> bool:
    """Whether a box should be running and reporting: the one rule behind
    `switch.hosted.boxes_expected`, so a box that is meant to be quiet never
    reads as gone silent.

    Today that's a machine that is ready and wanted running, which leaves out
    a box stopped by its owner or for idleness. **Visibility set V3 extends
    this rule** with its paused and turned-off marks, here and nowhere else,
    so the silent-box alert never fires for a box an operator paused.
    """
    return row.state == "ready" and row.desired_state == "running"


def snapshot_of(
    rows: list[MachineRow], now: datetime
) -> tuple[HostedSnapshot, dict[str, tuple[int | None, int | None]]]:
    """The gauges from the machines' stored summaries, and each fresh box's
    since-start counts (guard stops, valve parks) keyed by machine and
    workspace, for the sampler to turn into rises."""
    snap = HostedSnapshot()
    counts: dict[str, tuple[int | None, int | None]] = {}
    for row in rows:
        if expected_to_run(row):
            snap.boxes_expected += 1
            if _fresh(row.heartbeat_at, now):
                snap.boxes_reporting += 1
        reports = (row.heartbeat or {}).get("controllers") or {}
        if not isinstance(reports, Mapping):
            continue
        for workspace_id, report in reports.items():
            if not isinstance(report, Mapping) or not _fresh(report.get("at"), now):
                continue
            summary = report.get("metrics")
            if not isinstance(summary, Mapping):
                continue
            agents = summary.get("agents")
            for key, number in agents.items() if isinstance(agents, Mapping) else []:
                process, _, session = str(key).partition(":")
                if process in PROCESS_STATES and session in SESSION_STATES:
                    pair = (process, session)
                    snap.agents[pair] = snap.agents.get(pair, 0) + _count(number)
            stopped = summary.get("stopped")
            if isinstance(stopped, Mapping):
                for reason in STOP_REASONS:
                    snap.stopped[reason] += _count(stopped.get(reason))
            snap.restarts_10m += _count(summary.get("restarts_10m"))
            snap.oom_kills += _count(summary.get("oom_kills"))
            snap.waiting_for_room += _count(summary.get("waiting_for_room"))
            snap.sessions_running += _count(summary.get("sessions_running"))
            snap.sessions_max += _count(summary.get("sessions_max"))
            valve = summary.get("valve_memory")
            if valve in VALVE_STATES:
                snap.valve_memory[valve] += 1
            snap.gateway_agents += _count(summary.get("gateway_agents"))
            snap.gateway_refused += _count(summary.get("gateway_refused"))
            if summary.get("gateway_capped") is True:
                snap.gateway_capped += 1
            counts[f"{row.id}/{workspace_id}"] = (
                _optional_count(summary.get("guard_stops")),
                _optional_count(summary.get("valve_parks")),
            )
    return snap, counts


def snapshot_readings(snap: HostedSnapshot) -> Iterator[GaugeReading]:
    """Every gauge, including zeros, so a series that empties reads 0."""
    for process in PROCESS_STATES:
        for session in SESSION_STATES:
            yield GaugeReading(
                HOSTED_AGENTS,
                float(snap.agents.get((process, session), 0)),
                {"process": process, "session": session},
            )
    for reason in STOP_REASONS:
        yield GaugeReading(
            HOSTED_AGENTS_STOPPED,
            float(snap.stopped.get(reason, 0)),
            {"reason": reason},
        )
    yield GaugeReading(HOSTED_AGENT_RESTARTS_10M, float(snap.restarts_10m), {})
    yield GaugeReading(HOSTED_AGENT_OOM_KILLS, float(snap.oom_kills), {})
    yield GaugeReading(
        HOSTED_SESSIONS, float(snap.sessions_running), {"kind": "running"}
    )
    yield GaugeReading(HOSTED_SESSIONS, float(snap.sessions_max), {"kind": "max"})
    yield GaugeReading(HOSTED_WAITING_FOR_ROOM, float(snap.waiting_for_room), {})
    for state in VALVE_STATES:
        yield GaugeReading(
            HOSTED_BOXES_VALVE_MEMORY,
            float(snap.valve_memory.get(state, 0)),
            {"state": state},
        )
    yield GaugeReading(HOSTED_GATEWAY, float(snap.gateway_agents), {"kind": "agents"})
    yield GaugeReading(HOSTED_GATEWAY, float(snap.gateway_refused), {"kind": "refused"})
    yield GaugeReading(
        HOSTED_GATEWAY, float(snap.gateway_capped), {"kind": "capped_boxes"}
    )
    yield GaugeReading(HOSTED_BOXES_REPORTING, float(snap.boxes_reporting), {})
    yield GaugeReading(HOSTED_BOXES_EXPECTED, float(snap.boxes_expected), {})


def _rise(previous: int | None, current: int | None) -> int:
    """How much a since-start count rose. The first sight is a baseline, and a
    fall is a controller restart, so the new count is all new."""
    if current is None or previous is None:
        return 0
    return current - previous if current >= previous else current


_MACHINES = text(
    "SELECT id, state, desired_state, heartbeat, heartbeat_at "
    "FROM cloud_machines WHERE state <> 'deleted'"
)
_TRY_LOCK = text("SELECT pg_try_advisory_lock(hashtext(:name))")


class HostedSampler:
    """Reads hosted boxes' stored summaries on a timer, in the one process
    holding the hosted metrics lock, and reports them.

    The gauges are read from the last sample, and absent once a sample has
    failed or the lock is not held here, so a process that isn't reporting
    never sends a stale or duplicate copy.
    """

    def __init__(
        self,
        engine_factory: Callable[[], AsyncEngine],
        *,
        interval_seconds: float = SAMPLE_INTERVAL_SECONDS,
        timeout_seconds: float = SAMPLE_TIMEOUT_SECONDS,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._engine_factory = engine_factory
        self._interval = interval_seconds
        self._timeout = timeout_seconds
        self._clock = clock
        self._engine: AsyncEngine | None = None
        self._conn: AsyncConnection | None = None
        self._holds_lock = False
        self._latest: HostedSnapshot | None = None
        self._last_counts: dict[str, tuple[int | None, int | None]] = {}
        self._last_failure_log = float("-inf")
        self.disabled = False

    @property
    def reporting(self) -> bool:
        return self._latest is not None

    def readings(self) -> Iterator[GaugeReading]:
        latest = self._latest
        if latest is None:
            return
        yield from snapshot_readings(latest)

    async def run_forever(self) -> None:
        try:
            while not self.disabled:
                await self.sample_once()
                await asyncio.sleep(self._interval)
        finally:
            await self.aclose()

    async def sample_once(self) -> HostedSnapshot | None:
        """Take one sample if this process holds the lock. None otherwise."""
        if self.disabled or not self._postgres():
            return None
        try:
            rows = await asyncio.wait_for(self._read(), self._timeout)
        except Exception as exc:
            self._lost()
            await self._drop_connection()
            self._log_failure(exc)
            return None
        if rows is None:
            self._lost()
            return None
        snap, counts = snapshot_of(rows, self._clock())
        self._record_rises(counts)
        self._latest = snap
        return snap

    def _lost(self) -> None:
        """Not reporting: no gauges, and no baselines kept for the rises,
        since another process may be counting them meanwhile."""
        self._latest = None
        self._last_counts = {}

    def _record_rises(self, counts: dict[str, tuple[int | None, int | None]]) -> None:
        guard = parks = 0
        for key, (stops, parked) in counts.items():
            before_stops, before_parked = self._last_counts.get(key, (None, None))
            guard += _rise(before_stops, stops)
            parks += _rise(before_parked, parked)
        # A box that went silent is forgotten, so its return is a new baseline.
        self._last_counts = counts
        if guard:
            metrics().increment(HOSTED_GUARD_STOPS, {}, float(guard))
        if parks:
            metrics().increment(HOSTED_VALVE_PARKS, {}, float(parks))

    def _postgres(self) -> bool:
        if self._engine is None:
            self._engine = self._engine_factory()
        if self._engine.dialect.name == "postgresql":
            return True
        logger.info("The database is not Postgres, so switch.hosted.* is not reported.")
        self.disabled = True
        return False

    async def _read(self) -> list[MachineRow] | None:
        conn = await self._connection()
        if not self._holds_lock:
            got = (await conn.execute(_TRY_LOCK, {"name": LOCK_NAME})).scalar()
            if not got:
                return None
            self._holds_lock = True
            logger.info("This process now reports the hosted agents' gauges.")
        result = await conn.execute(_MACHINES)
        return [
            MachineRow(
                id=str(row.id),
                state=str(row.state),
                desired_state=str(row.desired_state),
                heartbeat=row.heartbeat if isinstance(row.heartbeat, Mapping) else None,
                heartbeat_at=row.heartbeat_at,
            )
            for row in result
        ]

    async def _connection(self) -> AsyncConnection:
        if self._conn is None:
            assert self._engine is not None
            conn = await self._engine.connect()
            # Autocommit: the lock is held by the session, and the sampler
            # never sits idle in a transaction.
            self._conn = await conn.execution_options(isolation_level="AUTOCOMMIT")
            self._holds_lock = False
        return self._conn

    def _log_failure(self, exc: BaseException) -> None:
        now = time.monotonic()
        if now - self._last_failure_log < FAILURE_LOG_INTERVAL_SECONDS:
            return
        self._last_failure_log = now
        logger.warning(
            "Could not read the hosted boxes for their metrics (%s); retrying "
            "every %.0fs, and saying so at most once a minute.",
            type(exc).__name__,
            self._interval,
        )

    async def _drop_connection(self) -> None:
        conn, self._conn = self._conn, None
        # Closing the connection releases its session lock.
        self._holds_lock = False
        if conn is None:
            return
        try:
            await asyncio.wait_for(conn.close(), self._timeout)
        except Exception:
            logger.debug("Closing the hosted metrics sampler's connection failed.")

    async def aclose(self) -> None:
        self._lost()
        await self._drop_connection()
        engine, self._engine = self._engine, None
        if engine is not None:
            await engine.dispose()
