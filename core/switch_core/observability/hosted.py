"""Metrics for hosted agents' cloud machines, from what their controllers
already send Core.

Every cloud machine's controller sends Core a status report, and the hosted
controller service (the reconciler) polls Core and reports what it observes.
Nothing new runs on a machine: the numbers here are read out of those.

**Only numbers and fixed words leave.** A status report carries text a
machine chose (`detail`, `directory`, provider messages) and ids (agents,
sessions). None of it is read here. Each report is reduced, as it arrives, to
a summary of bounded counts and words from the fixed sets below
(`box_summary`), and that summary is all the gauges ever see. A value outside
a set is left out or becomes `other`, never itself.

**One process reports the gauges.** Several Core processes share one
database, and each would otherwise report every machine. The sampler takes a
session-level advisory lock on a connection of its own, and only the process
holding it reports. The lock goes with the connection if the process dies,
and another process's sampler takes it on its next try.

**The summaries live on the cloud machine row** (`cloud_machines.heartbeat`,
per workspace, beside the time of the report). That table is global, so the
sampler reads every machine without binding a tenant, and nothing new is
stored beyond counts.

Every series carries `backend`, the kind of machine: `vm` for every cloud
machine this server makes (`V1_BACKEND`), so a later kind of machine adds to
the same series rather than new ones.
Nothing here runs without `OTLP_ENDPOINT`: no registry is installed then, and
the sampler isn't started.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import event as sa_event
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, AsyncSession
from sqlalchemy.orm import Session, SessionTransaction

from switch_core.observability.catalogue import (
    CONTROLLER_CREDENTIAL_REFUSALS,
    HOSTED_AGENTS,
    HOSTED_AGENTS_STOPPED,
    HOSTED_BOX_MEMORY_USED,
    HOSTED_BOXES_EXPECTED,
    HOSTED_BOXES_REPORTING,
    HOSTED_CLOUD_ERRORS,
    HOSTED_CONTROLLER_ERRORS,
    HOSTED_CONTROLLER_RESTARTS,
    HOSTED_DISK_USED,
    HOSTED_MACHINE_EVENTS,
    HOSTED_PROVIDER_LOGIN_PROBLEMS,
    HOSTED_PROVISION_SECONDS,
    HOSTED_RECONCILER_SILENCE,
    HOSTED_SESSIONS,
    OBSERVABILITY_SAMPLE_FAILURES,
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
# The providers a controller runs (`agent-providers`), and the login states a
# report can carry that mean a provider can't be used. `unknown` (the check
# could not tell) is not counted. Anything else is `other`.
PROVIDERS = ("claude", "codex", "opencode", "cursor", "antigravity")
LOGIN_PROBLEMS = ("missing", "expired")
# The kinds of cloud machine. Only `vm` today: a later kind is added here, and
# anything else is left out of the gauges, and `other` on a counter.
BACKENDS = ("vm",)
# Every cloud machine this server makes is a v1 VM: there is no other kind yet.
V1_BACKEND = "vm"

# The controller refusal codes (`management.reason_codes`) a refused
# credential is counted by, plus the hosted controller service's own two. Any
# other code is counted as `other`.
REFUSAL_REASONS = frozenset(
    {
        "missing_credential",
        "invalid_credential",
        "token_expired",
        "controller_revoked",
        "workspace_not_enabled",
        "enrollment_code_invalid",
        "missing",
        "wrong",
        "other",
    }
)
# The kinds of route a credential is refused on. Anything else is `other`.
REFUSAL_ROUTES = frozenset({"agent", "management", "controller", "hosted_controller"})
# Cloud machine changes, each with its fixed words: the claim's change, the
# failure, what woke it, why it stopped, and `new` or `restart` for ready.
# Anything else is `other`.
MACHINE_EVENTS: dict[str, frozenset[str]] = {
    "requested": frozenset({"new", "joined_workspace", "unretained", "restarted"}),
    "ready": frozenset({"new", "restart"}),
    "failed": frozenset(
        {
            "not_scheduled",
            "never_started",
            "never_connected",
            # A machine started again (a wake or a restart) that didn't connect
            # within the timeout, apart from a first launch's `never_connected`.
            "wake_failed",
            # A machine that needs attention and has never been ready: its
            # launch was refused (the controller's own checks) or never came up.
            "launch_refused",
            "owner_left",
            "needs_attention",
            "reported",
            # An error observed while the machine is wanted stopped, retained
            # or deleted.
            "stop_failed",
        }
    ),
    "woken": frozenset({"message", "agent_placed", "owner"}),
    # `admin`: an operator holds it stopped (`switch-cloud-machine stop`).
    "stopped": frozenset({"idle", "owner", "retained", "admin"}),
}

# A report older than this counts as gone, so a silent machine's agents drop
# out of the gauges rather than being reported as they were when it went quiet.
REPORT_FRESH_SECONDS = 180
# No count from a machine is believed past this: a bigger one is clamped.
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


def _word(value: Any, allowed: tuple[str, ...], fallback: str) -> str:
    return value if isinstance(value, str) and value in allowed else fallback


def stop_reason(reason: Any) -> str:
    return _word(reason, STOP_REASONS[:2], "other")


def refusal_reason(reason: str) -> str:
    return reason if reason in REFUSAL_REASONS else "other"


def backend_of(value: Any) -> str:
    return _word(value, BACKENDS, "other")


def route_kind(path: str) -> str:
    """The kind of route a path is, from a fixed list, never the path itself,
    which the client chose."""
    if path == "/v1/management" or path.startswith("/v1/management/"):
        return "management"
    if path == "/v1/controllers" or path.startswith("/v1/controllers/"):
        return "controller"
    return "agent"


def box_summary(
    machine: Mapping[str, Any], agents: Any, providers: Any = None
) -> dict[str, Any]:
    """A status report reduced to counts and fixed words: what the gauges read.

    `machine` is the report's `machine` object and `agents` its `agents` list,
    as stored. No id, name, path or free text is copied: each value is a
    bounded int or a word from a fixed set.
    """
    by_state: dict[str, int] = {}
    stopped = dict.fromkeys(STOP_REASONS, 0)
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
        if process in _FAILED_PROCESS_STATES or reason == "out_of_memory":
            stopped[stop_reason(reason)] += 1
    login_problems: dict[str, int] = {}
    for entry in providers if isinstance(providers, list) else []:
        if not isinstance(entry, Mapping) or entry.get("installed") is False:
            continue
        auth = entry.get("auth")
        if auth not in LOGIN_PROBLEMS:
            continue
        key = f"{_word(entry.get('provider'), PROVIDERS, 'other')}:{auth}"
        login_problems[key] = min(login_problems.get(key, 0) + 1, MAX_COUNT)
    return {
        "agents": by_state,
        "stopped": stopped,
        "sessions_running": _count(machine.get("sessions_running")),
        "sessions_max": _count(machine.get("sessions_max")),
        "login_problems": login_problems,
    }


def _used_percent(total: Any, free: Any) -> float | None:
    """100 × (total − free) ÷ total, or None for figures that aren't a sane
    pair of byte counts."""
    if (
        isinstance(total, int)
        and isinstance(free, int)
        and not isinstance(total, bool)
        and not isinstance(free, bool)
        and total > 0
        and 0 <= free <= total
    ):
        return 100.0 * (total - free) / total
    return None


def record_box_report(machine: Mapping[str, Any], backend: str = V1_BACKEND) -> None:
    """How full a cloud machine's memory and disk were, recorded as its report
    arrives (once per machine: `reports_memory`)."""
    attributes = {"backend": backend_of(backend)}
    memory = _used_percent(
        machine.get("mem_total_bytes"), machine.get("mem_free_bytes")
    )
    if memory is not None:
        metrics().observe(HOSTED_BOX_MEMORY_USED, attributes, memory)
    disk = _used_percent(
        machine.get("disk_total_bytes"), machine.get("disk_free_bytes")
    )
    if disk is not None:
        metrics().observe(HOSTED_DISK_USED, attributes, disk)


def record_provisioned(seconds: float, backend: str = V1_BACKEND) -> None:
    """How long a new machine took from its claim to its first status report.
    A negative or absurd figure (a clock change) is not recorded."""
    if 0 <= seconds <= 86_400:
        metrics().observe(
            HOSTED_PROVISION_SECONDS, {"backend": backend_of(backend)}, seconds
        )


CLOUD_CALLS = ("launch", "start", "stop", "terminate", "volume", "describe", "other")
CLOUD_ERROR_KINDS = ("capacity", "throttled", "permission", "other")
CONTROLLER_ERROR_KINDS = ("cloud", "core_api", "state", "other")


def record_cloud_error(
    call: str, kind: str, count: int = 1, backend: str = V1_BACKEND
) -> None:
    """Failed cloud calls the hosted controller service reported, in its fixed
    words (Core's schema has already capped the count)."""
    if count > 0:
        metrics().increment(
            HOSTED_CLOUD_ERRORS,
            {
                "call": _word(call, CLOUD_CALLS, "other"),
                "kind": _word(kind, CLOUD_ERROR_KINDS, "other"),
                "backend": backend_of(backend),
            },
            count,
        )


def record_controller_errors(counts: Mapping[Any, int]) -> None:
    """The hosted controller service's errors since it last reported, by kind
    (Core's schema has already capped each count)."""
    for kind, count in counts.items():
        if count > 0:
            metrics().increment(
                HOSTED_CONTROLLER_ERRORS,
                {"kind": _word(kind, CONTROLLER_ERROR_KINDS, "other")},
                count,
            )


def record_controller_restart(backend: str = V1_BACKEND) -> None:
    """A cloud machine's agent controller started again."""
    metrics().increment(HOSTED_CONTROLLER_RESTARTS, {"backend": backend_of(backend)})


def record_sample_failure(sampler: str) -> None:
    """One sample a background sampler couldn't take, by its fixed name. Its
    own warning never reaches Datadog (the observability package's logs are
    kept out of the export to avoid loops), so this count is what shows it."""
    metrics().increment(OBSERVABILITY_SAMPLE_FAILURES, {"sampler": sampler})


def reports_memory(
    reports: Mapping[str, Any], workspace_id: str, now: datetime
) -> bool:
    """Whether this workspace's report is the one that records the machine's
    memory: the first, by workspace id, of the machine's fresh reports. A
    machine serving several workspaces sends its memory in each report, and
    counting it once per machine keeps the p95 fair. If that workspace's
    controller goes quiet, its report goes stale and the next one takes over."""
    fresh = [
        key
        for key, report in reports.items()
        if key == workspace_id
        or (isinstance(report, Mapping) and _fresh(report.get("at"), now))
    ]
    return bool(fresh) and min(fresh) == workspace_id


def record_credential_refusal(reason: str, route: str) -> None:
    """One refused controller credential, by its fixed reason code and kind
    of route only: never the address, the path or any part of the token."""
    metrics().increment(
        CONTROLLER_CREDENTIAL_REFUSALS,
        {
            "reason": refusal_reason(reason),
            "route": route if route in REFUSAL_ROUTES else "other",
        },
    )


def machine_event_reason(event: str, reason: Any) -> str:
    return reason if reason in MACHINE_EVENTS.get(event, ()) else "other"


def record_machine_event(
    session: AsyncSession, event: str, reason: Any, backend: Any = V1_BACKEND
) -> None:
    """Count one cloud machine change once `session` commits, and never if it
    rolls back, as its product telemetry event is (`emit_after_commit`, whose
    listeners this mirrors). It counts whether or not product telemetry is
    on, and only fixed words."""
    attributes = {
        "event": event if event in MACHINE_EVENTS else "other",
        "reason": machine_event_reason(event, reason),
        "backend": backend_of(backend),
    }
    after_commit(
        session, lambda: metrics().increment(HOSTED_MACHINE_EVENTS, attributes)
    )


def after_commit(session: AsyncSession, record: Callable[[], None]) -> None:
    """Run `record` once `session` commits, and never if it rolls back, as
    product telemetry's `emit_after_commit` does."""
    sync = session.sync_session
    committed = False
    decided = False

    def on_commit(_session: Session) -> None:
        nonlocal committed
        # A savepoint's commit fires this too, with the savepoint still
        # current; only the outermost commit makes the change durable.
        if not _session.in_nested_transaction():
            committed = True

    def on_end(_session: Session, transaction: SessionTransaction) -> None:
        nonlocal decided
        # Only the outermost transaction decides; a savepoint ending doesn't.
        # The listeners stay registered, inert once decided: removing one
        # while the session dispatches its events is refused.
        if decided or transaction.parent is not None:
            return
        decided = True
        if committed:
            record()

    sa_event.listen(sync, "after_commit", on_commit)
    sa_event.listen(sync, "after_transaction_end", on_end)


class ReconcilerWatch:
    """When this process last heard from the hosted controller service: its
    machine list poll, or an observation. In memory, per process. With
    hosted agents on, the process starts the count when it starts
    (`start`), so the gauge is there from boot; the minimum over pods is how
    long the reconciler has been silent. It watches the reconciler without
    changing its process."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._last: float | None = None

    def heard(self) -> None:
        self._last = self._clock()

    def start(self) -> None:
        """Count silence from now, if nothing has been heard yet: a process
        that starts while the reconciler is down reports rising silence
        rather than nothing, so the alert can fire."""
        if self._last is None:
            self._last = self._clock()

    def readings(self) -> Iterator[GaugeReading]:
        last = self._last
        if last is None:
            return
        yield GaugeReading(
            HOSTED_RECONCILER_SILENCE, max(0.0, self._clock() - last), {}
        )


_reconciler = ReconcilerWatch()


def reconciler_watch() -> ReconcilerWatch:
    return _reconciler


def reconciler_heard() -> None:
    """The hosted controller service just called: its poll or an observation."""
    _reconciler.heard()


def _per_backend() -> dict[str, int]:
    return dict.fromkeys(BACKENDS, 0)


@dataclass
class HostedSnapshot:
    """The gauges' values, as of one sample, per `backend`."""

    agents: dict[tuple[str, str, str], int] = field(default_factory=dict)
    stopped: dict[tuple[str, str], int] = field(default_factory=dict)
    sessions_running: dict[str, int] = field(default_factory=_per_backend)
    sessions_max: dict[str, int] = field(default_factory=_per_backend)
    boxes_reporting: dict[str, int] = field(default_factory=_per_backend)
    boxes_expected: dict[str, int] = field(default_factory=_per_backend)
    login_problems: dict[tuple[str, str, str], int] = field(default_factory=dict)


@dataclass(frozen=True)
class MachineRow:
    """What the sampler reads of one cloud machine."""

    id: str
    state: str
    desired_state: str
    heartbeat: Mapping[str, Any] | None
    heartbeat_at: datetime | None
    backend: str = V1_BACKEND


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
    """Whether a machine should be running and reporting: the one rule behind
    `switch.hosted.boxes_expected`, so a machine meant to be quiet (stopped by
    its owner or for idleness) never reads as gone silent."""
    return row.state == "ready" and row.desired_state == "running"


def snapshot_of(rows: list[MachineRow], now: datetime) -> HostedSnapshot:
    """The gauges, from the machines' stored summaries."""
    snap = HostedSnapshot()
    for row in rows:
        backend = row.backend if row.backend in BACKENDS else None
        if backend is None:
            # Not a kind of machine the gauges know: left out, never mixed
            # into another kind's counts.
            continue
        if expected_to_run(row):
            snap.boxes_expected[backend] += 1
            if _fresh(row.heartbeat_at, now):
                snap.boxes_reporting[backend] += 1
        reports = (row.heartbeat or {}).get("controllers") or {}
        if not isinstance(reports, Mapping):
            continue
        for report in reports.values():
            if not isinstance(report, Mapping) or not _fresh(report.get("at"), now):
                continue
            summary = report.get("metrics")
            if not isinstance(summary, Mapping):
                continue
            agents = summary.get("agents")
            for key, number in agents.items() if isinstance(agents, Mapping) else []:
                process, _, session = str(key).partition(":")
                if process in PROCESS_STATES and session in SESSION_STATES:
                    key3 = (backend, process, session)
                    snap.agents[key3] = snap.agents.get(key3, 0) + _count(number)
            stopped = summary.get("stopped")
            if isinstance(stopped, Mapping):
                for reason in STOP_REASONS:
                    pair = (backend, reason)
                    snap.stopped[pair] = snap.stopped.get(pair, 0) + _count(
                        stopped.get(reason)
                    )
            snap.sessions_running[backend] += _count(summary.get("sessions_running"))
            snap.sessions_max[backend] += _count(summary.get("sessions_max"))
            problems = summary.get("login_problems")
            for key, number in (
                problems.items() if isinstance(problems, Mapping) else []
            ):
                provider, _, reason = str(key).partition(":")
                if provider in (*PROVIDERS, "other") and reason in LOGIN_PROBLEMS:
                    key3 = (backend, provider, reason)
                    snap.login_problems[key3] = snap.login_problems.get(
                        key3, 0
                    ) + _count(number)
    return snap


def snapshot_readings(snap: HostedSnapshot) -> Iterator[GaugeReading]:
    """Every gauge, including zeros, so a series that empties reads 0."""
    for backend in BACKENDS:
        for process in PROCESS_STATES:
            for session in SESSION_STATES:
                yield GaugeReading(
                    HOSTED_AGENTS,
                    float(snap.agents.get((backend, process, session), 0)),
                    {"process": process, "session": session, "backend": backend},
                )
        for reason in STOP_REASONS:
            yield GaugeReading(
                HOSTED_AGENTS_STOPPED,
                float(snap.stopped.get((backend, reason), 0)),
                {"reason": reason, "backend": backend},
            )
        for kind, values in (
            ("running", snap.sessions_running),
            ("max", snap.sessions_max),
        ):
            yield GaugeReading(
                HOSTED_SESSIONS,
                float(values[backend]),
                {"kind": kind, "backend": backend},
            )
        yield GaugeReading(
            HOSTED_BOXES_REPORTING,
            float(snap.boxes_reporting[backend]),
            {"backend": backend},
        )
        yield GaugeReading(
            HOSTED_BOXES_EXPECTED,
            float(snap.boxes_expected[backend]),
            {"backend": backend},
        )
        for provider in (*PROVIDERS, "other"):
            for reason in LOGIN_PROBLEMS:
                yield GaugeReading(
                    HOSTED_PROVIDER_LOGIN_PROBLEMS,
                    float(snap.login_problems.get((backend, provider, reason), 0)),
                    {"provider": provider, "reason": reason, "backend": backend},
                )


_MACHINES = text(
    "SELECT id, state, desired_state, heartbeat, heartbeat_at "
    "FROM cloud_machines WHERE state <> 'deleted'"
)
_TRY_LOCK = text("SELECT pg_try_advisory_lock(hashtext(:name))")


class HostedSampler:
    """Reads cloud machines' stored summaries on a timer, in the one process
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
            self._latest = None
            await self._drop_connection()
            record_sample_failure("hosted")
            self._log_failure(exc)
            return None
        if rows is None:
            self._latest = None
            return None
        snap = snapshot_of(rows, self._clock())
        self._latest = snap
        return snap

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
            logger.info("This process now reports the hosted machines' gauges.")
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
            "Could not read the cloud machines for their metrics (%s); retrying "
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
        self._latest = None
        await self._drop_connection()
        engine, self._engine = self._engine, None
        if engine is not None:
            await engine.dispose()
