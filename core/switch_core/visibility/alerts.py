"""Operator alerts for hosted agents.

Seven conditions raise an alert, each with ids only:

- A1 a box pushed off its machine;
- A2 a box restarting 3 or more times in an hour;
- A3 a machine still in its safety check after 10 minutes;
- A4 a machine's used memory above 85% of allocatable, or unreadable;
- A5 a box whose memory can't be read;
- A6 a shared service with fewer ready copies than it wants for 2 minutes;
- A7 the operator's cluster report arriving late.

**Where alerts are kept.** Each raise and each clear is one row in
`server_audit_events` (`alert.raised`, `alert.cleared`), with no actor, the
target's type and id, and `details = {condition, severity, figure}`. The table
is append-only, global and already read by operators, so alerts outlive a Core
restart and every process sees the same ones. The Audit log tab leaves these
rows out unless an operator asks for them.

**One function writes every row,** `apply_alert`, under a transaction-level
advisory lock on the condition and target. It raises when the condition is
true and nothing is open, unless that pair was raised in the last 10 minutes,
and it clears when the condition is false and an alert is open. So two Core
processes can never both raise the same alert, and a condition that flaps
raises at most once every 10 minutes.

**Who decides.** Box conditions (A1, A2, A5) and A7 come from what Core stores
or holds, and one evaluator decides them every 30 s: the process holding the
`switch-hosted-alerts` advisory lock on a connection of its own. Cluster
conditions (A3, A4, A6) are decided in the cluster report's own request
(`gateway/hosted_controller.py`), whichever process it reaches.

**What an alert can say.** Targets are a box's keyed id, a node name checked
by the Kubernetes name rule, or a name from the fixed services list. Figures
are numbers. Titles and details come only from the templates here. No name,
email, raw id or text a box or report chose ever reaches an alert.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Any

from sqlalchemy import func, literal_column, select, text
from sqlalchemy.ext.asyncio import (
    AsyncConnection,
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
)

from switch_core.db.audit import ServerAuditAction
from switch_core.db.models import ServerAuditEvent
from switch_core.observability.catalogue import HOSTED_ALERTS_OPEN
from switch_core.observability.hosted import MachineRow, expected_to_run
from switch_core.observability.metrics import GaugeReading
from switch_core.tenant_context import no_tenant
from switch_core.visibility.cluster_report import (
    NODE_NAME_RE,
    SHARED_SERVICES,
    ClusterReport,
    HeldReport,
)
from switch_core.visibility.keyed_id import KeyedIdKey, KeyedIdKind, is_keyed_id

logger = logging.getLogger(__name__)


class Condition(StrEnum):
    BOX_EVICTED = "box_evicted"  # A1
    BOX_RESTARTS = "box_restarts"  # A2
    SAFETY_CHECK = "machine_safety_check"  # A3
    MACHINE_MEMORY = "machine_memory"  # A4
    BOX_MEMORY_UNREADABLE = "box_memory_unreadable"  # A5
    SERVICE_SHORT = "service_short"  # A6
    CLUSTER_REPORT_LATE = "cluster_report_late"  # A7
    # A pause still failed after 2 minutes. Raised and cleared
    # by the pause action, never by the evaluator.
    PAUSE_FAILED = "pause_failed"  # A8
    # A workspace admin's turn-off still failed after 2 minutes. Raised and
    # cleared by the turn-off action only. Its target is
    # the user and the workspace together (`turn_off_target`), since a person
    # can be turned off in more than one workspace.
    TURN_OFF_FAILED = "turn_off_failed"  # A9
    # A provisioning cap was reached, so new users wait for room. Raised
    # and cleared by box provisioning only, never by the evaluator. Its
    # target is the cap: `rate` (per minute) or `ceiling` (in total).
    BOX_CAP_REACHED = "box_cap_reached"  # A10
    # One operator made many actions in a short time (the bulk-action
    # alert). Raised and cleared by the operator-rate-limit code only, never by
    # the evaluator. Its target is the operator's keyed id. It alerts and
    # doesn't block; the hourly limit is what blocks.
    OPERATOR_BULK_ACTIONS = "operator_bulk_actions"  # A11


class TargetType(StrEnum):
    BOX = "box"
    MACHINE = "machine"
    SERVICE = "service"
    OPERATOR = "operator"
    USER = "user"
    CAP = "cap"  # a provisioning cap: one of CAP_TARGETS
    MEMBER = "member"  # a user in one workspace: "<user keyed id>:<workspace keyed id>"


SEVERITY: Mapping[Condition, str] = {
    Condition.BOX_EVICTED: "warning",
    Condition.BOX_RESTARTS: "warning",
    Condition.SAFETY_CHECK: "warning",
    Condition.MACHINE_MEMORY: "critical",
    Condition.BOX_MEMORY_UNREADABLE: "warning",
    Condition.SERVICE_SHORT: "critical",
    Condition.CLUSTER_REPORT_LATE: "critical",
    Condition.PAUSE_FAILED: "critical",
    Condition.TURN_OFF_FAILED: "critical",
    Condition.BOX_CAP_REACHED: "warning",
    Condition.OPERATOR_BULK_ACTIONS: "critical",
}

TARGET_OF: Mapping[Condition, TargetType] = {
    Condition.BOX_EVICTED: TargetType.BOX,
    Condition.BOX_RESTARTS: TargetType.BOX,
    Condition.SAFETY_CHECK: TargetType.MACHINE,
    Condition.MACHINE_MEMORY: TargetType.MACHINE,
    Condition.BOX_MEMORY_UNREADABLE: TargetType.BOX,
    Condition.SERVICE_SHORT: TargetType.SERVICE,
    Condition.CLUSTER_REPORT_LATE: TargetType.OPERATOR,
    Condition.PAUSE_FAILED: TargetType.USER,
    Condition.TURN_OFF_FAILED: TargetType.MEMBER,
    Condition.BOX_CAP_REACHED: TargetType.CAP,
    Condition.OPERATOR_BULK_ACTIONS: TargetType.USER,
}

BOX_CONDITIONS = frozenset(
    {Condition.BOX_EVICTED, Condition.BOX_RESTARTS, Condition.BOX_MEMORY_UNREADABLE}
)
CLUSTER_CONDITIONS = frozenset(
    {Condition.SAFETY_CHECK, Condition.MACHINE_MEMORY, Condition.SERVICE_SHORT}
)

# A10's two targets: the per-minute provisioning cap and the total ceiling.
CAP_TARGETS = frozenset({"rate", "ceiling"})

# The one target A7 has: the operator's cluster report as a whole.
CLUSTER_REPORT_TARGET = "cluster-report"

# The alerts' limits and thresholds.
REPEAT_LIMIT = timedelta(minutes=10)
RESTARTS_PER_HOUR = 3
SAFETY_CHECK_MINUTES = 10
MEMORY_USED_PCT = 85.0
SERVICE_SHORT_SECONDS = 120
CLUSTER_REPORT_LATE_AFTER = timedelta(minutes=3)
# An eviction alert clears itself this long after the box's last eviction.
EVICTION_CLEARS_AFTER = timedelta(minutes=30)
# A status summary older than this doesn't count (as for the metrics).
REPORT_FRESH = timedelta(minutes=3)

EVALUATE_INTERVAL_SECONDS = 30.0
EVALUATE_TIMEOUT_SECONDS = 10.0
FAILURE_LOG_INTERVAL_SECONDS = 60.0
LOCK_NAME = "switch-hosted-alerts"

# The row's condition, as one SQL expression with the key written inline. A
# bound key would be a fresh parameter at each use, and Postgres then refuses
# `DISTINCT ON (details ->> $1 …) … ORDER BY details ->> $3 …` as different
# expressions (an integration run caught it). `'condition'` is a constant, never input.
_CONDITION = ServerAuditEvent.details.op("->>")(literal_column("'condition'"))

_ALERT_ACTIONS = (
    ServerAuditAction.ALERT_RAISED.value,
    ServerAuditAction.ALERT_CLEARED.value,
)


@dataclass(frozen=True)
class Verdict:
    """One condition's state for one target, as one evaluation sees it."""

    condition: Condition
    target_id: str
    true_now: bool
    # A count, a percentage or minutes; None where the figure is unknown (A4
    # with used memory unreadable).
    figure: float | None = None


@dataclass(frozen=True)
class OpenAlert:
    event_id: str
    condition: Condition
    target_type: TargetType
    target_id: str
    raised_at: datetime
    figure: float | None


def _valid_target(condition: Condition, target_id: str) -> bool:
    """Every target is checked before it's written: a keyed id, a node name,
    a listed service, or A7's one fixed target. Nothing else gets in."""
    kind = TARGET_OF[condition]
    if kind in (TargetType.BOX, TargetType.USER):
        return is_keyed_id(target_id)
    if kind is TargetType.CAP:
        return target_id in CAP_TARGETS
    if kind is TargetType.MEMBER:
        user, sep, workspace = target_id.partition(":")
        return bool(sep) and is_keyed_id(user) and is_keyed_id(workspace)
    if kind is TargetType.MACHINE:
        return NODE_NAME_RE.fullmatch(target_id) is not None
    if kind is TargetType.SERVICE:
        return target_id in SHARED_SERVICES
    return target_id == CLUSTER_REPORT_TARGET


def turn_off_target(user_keyed_id: str, workspace_keyed_id: str) -> str:
    """A9's target: the person and the workspace they were turned off in,
    both as keyed ids."""
    return f"{user_keyed_id}:{workspace_keyed_id}"


def _figure(value: float | None) -> float | None:
    if value is None:
        return None
    return round(max(0.0, min(float(value), 1_000_000.0)), 1)


# ── Deciding: pure functions, no database ────────────────────────────────────


def _times(values: Any, now: datetime, within: timedelta) -> list[datetime]:
    out: list[datetime] = []
    for value in values if isinstance(values, list) else []:
        if not isinstance(value, str):
            continue
        try:
            moment = datetime.fromisoformat(value)
        except ValueError:
            continue
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=UTC)
        if timedelta(0) <= now - moment <= within:
            out.append(moment)
    return out


def _valve_problem(heartbeat: Mapping[str, Any] | None, now: datetime) -> bool:
    """Whether any fresh controller summary on the machine says its valve
    can't read the box's memory (`unprotected` or `failing`)."""
    reports = (heartbeat or {}).get("controllers") or {}
    if not isinstance(reports, Mapping):
        return False
    for report in reports.values():
        if not isinstance(report, Mapping):
            continue
        at = report.get("at")
        if not isinstance(at, str) or not _times([at], now, REPORT_FRESH):
            continue
        summary = report.get("metrics")
        if isinstance(summary, Mapping) and summary.get("valve_memory") in (
            "unprotected",
            "failing",
        ):
            return True
    return False


def box_verdicts(
    rows: Iterable[MachineRow], key: KeyedIdKey, now: datetime
) -> list[Verdict]:
    """A1, A2 and A5 for every hosted box. A box that isn't meant to be
    running is never in trouble, so its alerts clear."""
    out: list[Verdict] = []
    for row in rows:
        box_id = key.keyed_id(KeyedIdKind.BOX, row.id)
        facts = (row.heartbeat or {}).get("box") or {}
        if not isinstance(facts, Mapping):
            facts = {}
        evictions = _times(facts.get("eviction_times"), now, EVICTION_CLEARS_AFTER)
        restarts = _times(facts.get("restart_times"), now, timedelta(hours=1))
        running = expected_to_run(row)
        out.append(
            Verdict(Condition.BOX_EVICTED, box_id, bool(evictions), len(evictions))
        )
        out.append(
            Verdict(
                Condition.BOX_RESTARTS,
                box_id,
                running and len(restarts) >= RESTARTS_PER_HOUR,
                len(restarts),
            )
        )
        out.append(
            Verdict(
                Condition.BOX_MEMORY_UNREADABLE,
                box_id,
                running and _valve_problem(row.heartbeat, now),
            )
        )
    return out


def cluster_verdicts(report: ClusterReport) -> list[Verdict]:
    """A3, A4 and A6 for every node and listed service in one report."""
    out: list[Verdict] = []
    for node in report.nodes:
        held = node.gate == "held" and (node.held_minutes or 0) >= SAFETY_CHECK_MINUTES
        out.append(Verdict(Condition.SAFETY_CHECK, node.name, held, node.held_minutes))
        used = node.memory_used_pct
        out.append(
            Verdict(
                Condition.MACHINE_MEMORY,
                node.name,
                used is None or used > MEMORY_USED_PCT,
                used,
            )
        )
    for service in report.services:
        short = service.ready < service.wanted and (
            service.short_seconds >= SERVICE_SHORT_SECONDS
        )
        out.append(Verdict(Condition.SERVICE_SHORT, service.name, short, service.ready))
    return out


def cluster_report_verdict(
    held: HeldReport | None, now: datetime, waiting_since: datetime
) -> Verdict:
    """A7: no report in the last 3 minutes. Before the first report arrives,
    it counts from when this process started waiting."""
    last = held.received_at if held is not None else waiting_since
    late = now - last > CLUSTER_REPORT_LATE_AFTER
    minutes = (now - last).total_seconds() / 60
    return Verdict(Condition.CLUSTER_REPORT_LATE, CLUSTER_REPORT_TARGET, late, minutes)


# ── Writing ──────────────────────────────────────────────────────────────────


def _alert_rows(conditions: Iterable[Condition]):
    return select(ServerAuditEvent).where(
        ServerAuditEvent.action.in_(_ALERT_ACTIONS),
        _CONDITION.in_([c.value for c in conditions]),
    )


async def open_alerts(
    session: AsyncSession, conditions: Iterable[Condition] = tuple(Condition)
) -> list[OpenAlert]:
    """Each condition and target's latest row, where that row is a raise."""
    wanted = list(conditions)
    latest = (
        _alert_rows(wanted)
        .distinct(
            _CONDITION,
            ServerAuditEvent.target_type,
            ServerAuditEvent.target_id,
        )
        .order_by(
            _CONDITION,
            ServerAuditEvent.target_type,
            ServerAuditEvent.target_id,
            ServerAuditEvent.occurred_at.desc(),
            ServerAuditEvent.id.desc(),
        )
    )
    rows = (await session.execute(latest)).scalars().all()
    return [
        _open(row) for row in rows if row.action == ServerAuditAction.ALERT_RAISED.value
    ]


def _open(row: ServerAuditEvent) -> OpenAlert:
    details = row.details or {}
    figure = details.get("figure")
    return OpenAlert(
        event_id=row.id,
        condition=Condition(details["condition"]),
        target_type=TargetType(row.target_type),
        target_id=row.target_id or "",
        raised_at=row.occurred_at,
        figure=float(figure) if isinstance(figure, int | float) else None,
    )


async def apply_alert(
    session_factory: async_sessionmaker[AsyncSession],
    verdict: Verdict,
    now: datetime | None = None,
) -> str | None:
    """Raise or clear one alert, under its own lock. Returns `raised`,
    `cleared`, or None when nothing changed."""
    if not _valid_target(verdict.condition, verdict.target_id):
        logger.warning(
            "An alert target failed its pattern check and was not written",
            extra={"condition": verdict.condition.value},
        )
        return None
    moment = now or datetime.now(UTC)
    target_type = TARGET_OF[verdict.condition]
    pair = f"alert:{verdict.condition.value}:{target_type.value}:{verdict.target_id}"
    with no_tenant():
        async with session_factory() as session:
            await session.execute(
                select(func.pg_advisory_xact_lock(func.hashtext(pair)))
            )
            same = _alert_rows([verdict.condition]).where(
                ServerAuditEvent.target_type == target_type.value,
                ServerAuditEvent.target_id == verdict.target_id,
            )
            latest = (
                await session.execute(
                    same.order_by(
                        ServerAuditEvent.occurred_at.desc(), ServerAuditEvent.id.desc()
                    ).limit(1)
                )
            ).scalar_one_or_none()
            is_open = (
                latest is not None
                and latest.action == ServerAuditAction.ALERT_RAISED.value
            )
            if verdict.true_now and not is_open:
                last_raised = (
                    await session.execute(
                        select(func.max(ServerAuditEvent.occurred_at)).where(
                            ServerAuditEvent.action
                            == ServerAuditAction.ALERT_RAISED.value,
                            _CONDITION == verdict.condition.value,
                            ServerAuditEvent.target_type == target_type.value,
                            ServerAuditEvent.target_id == verdict.target_id,
                        )
                    )
                ).scalar_one_or_none()
                if last_raised is not None and moment - last_raised < REPEAT_LIMIT:
                    return None
                action = ServerAuditAction.ALERT_RAISED
            elif not verdict.true_now and is_open:
                action = ServerAuditAction.ALERT_CLEARED
            else:
                return None
            # The row's time is the one the 10-minute limit compared against,
            # so the limit and the row agree whatever the database clock says.
            session.add(
                ServerAuditEvent(
                    occurred_at=moment,
                    actor_user_id=None,
                    action=action.value,
                    target_type=target_type.value,
                    target_id=verdict.target_id,
                    details={
                        "condition": verdict.condition.value,
                        "severity": SEVERITY[verdict.condition],
                        "figure": _figure(verdict.figure),
                    },
                )
            )
            await session.commit()
    return "raised" if action is ServerAuditAction.ALERT_RAISED else "cleared"


async def apply_verdicts(
    session_factory: async_sessionmaker[AsyncSession],
    verdicts: Sequence[Verdict],
    conditions: Iterable[Condition],
    now: datetime | None = None,
) -> int:
    """Apply one evaluation's verdicts for `conditions`, touching the database
    only where something may change: a true verdict with nothing open, or an
    open alert whose condition is now false or whose target is gone. Returns
    how many rows were written."""
    wanted = frozenset(conditions)
    with no_tenant():
        async with session_factory() as session:
            current = await open_alerts(session, wanted)
    is_open = {(a.condition, a.target_id) for a in current}
    seen = {(v.condition, v.target_id) for v in verdicts if v.condition in wanted}
    todo = [
        v
        for v in verdicts
        if v.condition in wanted
        and (v.true_now != ((v.condition, v.target_id) in is_open))
    ]
    # A target no longer reported (a node or box gone) can't stay open for ever.
    todo += [
        Verdict(a.condition, a.target_id, False)
        for a in current
        if (a.condition, a.target_id) not in seen
    ]
    written = 0
    for verdict in todo:
        if await apply_alert(session_factory, verdict, now) is not None:
            written += 1
    return written


# ── The pause and turn-off hook ──────────────────────────────────────────────


def action_alert(
    session_factory: async_sessionmaker[AsyncSession],
) -> Callable[[str, str, str | None, bool], Awaitable[None]]:
    """The `HostedAccess.alert` hook, wired to A8 and A9. The pause code
    calls a plain function and this maps it: `pause` to A8 by the
    user's keyed id, and `turn_off` to A9 by the user's and workspace's. An
    unknown action, or a turn-off with no workspace, writes nothing."""

    async def alert(
        action: str, user: str, workspace: str | None, raised: bool
    ) -> None:
        if action == "pause":
            verdict = Verdict(Condition.PAUSE_FAILED, user, raised)
        elif action == "turn_off" and workspace is not None:
            verdict = Verdict(
                Condition.TURN_OFF_FAILED, turn_off_target(user, workspace), raised
            )
        else:
            logger.warning("An action alert with no matching condition was not written")
            return
        await apply_alert(session_factory, verdict)

    return alert


# ── Reading: the overview's alerts and the notifier's queue ──────────────────


# A11's window in minutes, for its title. Core sets it from
# `visibility_operator_bulk_window_minutes` at start (`set_bulk_window_minutes`).
_bulk_window_minutes = 10


def set_bulk_window_minutes(minutes: int) -> None:
    """At start: the A11 window the title names, from the setting."""
    global _bulk_window_minutes
    _bulk_window_minutes = int(minutes)


def alert_title(condition: Condition, target_id: str, figure: float | None) -> str:
    """The one-line title for the Alerts tab and the ops room. Fixed text,
    with only a checked id and a number in it."""
    t = f"`{target_id}`"
    n = "" if figure is None else f"{figure:g}"
    match condition:
        case Condition.BOX_EVICTED:
            return f"Box {t} was pushed off its machine"
        case Condition.BOX_RESTARTS:
            return f"Box {t} restarted {n} times in the last hour"
        case Condition.SAFETY_CHECK:
            return f"Machine {t} has been in its safety check for {n} minutes"
        case Condition.MACHINE_MEMORY:
            if figure is None:
                return f"Machine {t} memory can't be read"
            return f"Machine {t} is using {n}% of its memory"
        case Condition.BOX_MEMORY_UNREADABLE:
            return f"Box {t} memory can't be read"
        case Condition.SERVICE_SHORT:
            return f"Shared service {t} is short of copies ({n} ready)"
        case Condition.CLUSTER_REPORT_LATE:
            return "The operator's cluster report is late"
        case Condition.PAUSE_FAILED:
            return f"Pausing user {t} still hasn't finished after 2 minutes"
        case Condition.OPERATOR_BULK_ACTIONS:
            return (
                f"Operator {t} made {n} actions in the last "
                f"{_bulk_window_minutes} minutes"
            )
        case Condition.BOX_CAP_REACHED:
            which = "per-minute" if target_id == "rate" else "total"
            limit = "" if figure is None else f" of {n}"
            return f"New boxes are waiting: the {which} provisioning cap{limit} was reached"
        case Condition.TURN_OFF_FAILED:
            user, _, workspace = target_id.partition(":")
            return (
                f"Turning off user `{user}` in workspace `{workspace}` "
                "still hasn't finished after 2 minutes"
            )
    raise ValueError(condition)


DETAIL: Mapping[Condition, str] = {
    Condition.BOX_EVICTED: "The box restarts on another machine. Check the machine's pressure on the Machines tab.",
    Condition.BOX_RESTARTS: "Three or more restarts in an hour. The box's agents are interrupted each time.",
    Condition.SAFETY_CHECK: "The machine takes no boxes until its check passes.",
    Condition.MACHINE_MEMORY: "Above 85% of the machine's allocatable memory, read from metrics-server.",
    Condition.BOX_MEMORY_UNREADABLE: "The box's valve can't read its memory, so it isn't protecting the box.",
    Condition.SERVICE_SHORT: "Fewer ready copies than it wants, for 2 minutes or more.",
    Condition.CLUSTER_REPORT_LATE: "No cluster report for 3 minutes, so machine and service alerts can't fire.",
    Condition.PAUSE_FAILED: "The pause's action record says failed. Check it in the Audit log and try again.",
    Condition.TURN_OFF_FAILED: "The turn-off's action record says failed. Check it in the Audit log; the admin can try again.",
    Condition.BOX_CAP_REACHED: "New users wait for room until provisioning drops back under the cap. The cap is a Core setting.",
    Condition.OPERATOR_BULK_ACTIONS: "Check the Audit log for this operator's recent actions. Nothing is blocked until the hourly limit.",
}


async def overview_alerts(
    session: AsyncSession,
    now: datetime | None = None,
    window: timedelta = timedelta(hours=24),
    *,
    live_figures: Mapping[tuple[str, str], float] | None = None,
) -> list[dict[str, Any]]:
    """The alerts for Console's `/shared-cloud/overview` contract: every open
    alert, and every one cleared within `window`, newest first, as
    `{id, severity, title, detail, raised_at, cleared_at}`.

    `live_figures`, by `(condition, target id)`, replaces an open alert's
    figure with a current one: the audit log is append-only, so a raised
    alert's own row keeps the figure it was raised with (A11's count)."""
    moment = now or datetime.now(UTC)
    since = moment - window
    rows = (
        (
            await session.execute(
                _alert_rows(tuple(Condition))
                .where(ServerAuditEvent.occurred_at >= since)
                .order_by(ServerAuditEvent.occurred_at, ServerAuditEvent.id)
            )
        )
        .scalars()
        .all()
    )
    still_open = await open_alerts(session)
    raises: dict[str, dict[str, Any]] = {}
    last_raise_of: dict[tuple[str, str, str], str] = {}
    live = live_figures or {}
    for alert in still_open:
        raises[alert.event_id] = _overview_item(
            alert.event_id,
            alert.condition,
            alert.target_id,
            live.get((alert.condition.value, alert.target_id), alert.figure),
            alert.raised_at,
        )
    for row in rows:
        details = row.details or {}
        try:
            condition = Condition(str(details.get("condition")))
        except ValueError:
            continue
        pair = (condition.value, row.target_type, row.target_id or "")
        if row.action == ServerAuditAction.ALERT_RAISED.value:
            figure = details.get("figure")
            raises.setdefault(
                row.id,
                _overview_item(
                    row.id,
                    condition,
                    row.target_id or "",
                    float(figure) if isinstance(figure, int | float) else None,
                    row.occurred_at,
                ),
            )
            last_raise_of[pair] = row.id
        elif (raised := last_raise_of.get(pair)) is not None:
            raises[raised]["cleared_at"] = row.occurred_at.isoformat()
    return sorted(raises.values(), key=lambda item: item["raised_at"], reverse=True)


def _overview_item(
    event_id: str,
    condition: Condition,
    target_id: str,
    figure: float | None,
    raised_at: datetime,
) -> dict[str, Any]:
    return {
        "id": event_id,
        "severity": SEVERITY[condition],
        "title": alert_title(condition, target_id, figure),
        "detail": DETAIL[condition],
        "raised_at": raised_at.isoformat(),
        "cleared_at": None,
    }


async def raised_since(
    session: AsyncSession, after: tuple[datetime, str] | None, limit: int = 200
) -> list[OpenAlert]:
    """New raises after `after` (a row's time and id), oldest first: the queue
    the ops-room notifier reads, so it keeps no state of its own."""
    query = select(ServerAuditEvent).where(
        ServerAuditEvent.action == ServerAuditAction.ALERT_RAISED.value
    )
    if after is not None:
        at, event_id = after
        query = query.where(
            (ServerAuditEvent.occurred_at > at)
            | ((ServerAuditEvent.occurred_at == at) & (ServerAuditEvent.id > event_id))
        )
    rows = (
        (
            await session.execute(
                query.order_by(ServerAuditEvent.occurred_at, ServerAuditEvent.id).limit(
                    limit
                )
            )
        )
        .scalars()
        .all()
    )
    return [_open(row) for row in rows]


# ── The evaluator ────────────────────────────────────────────────────────────

_MACHINES = text(
    "SELECT id, state, desired_state, heartbeat, heartbeat_at "
    "FROM cloud_machines WHERE state <> 'deleted'"
)
_TRY_LOCK = text("SELECT pg_try_advisory_lock(hashtext(:name))")


class AlertEvaluator:
    """Decides the box conditions and A7 every 30 s, in the one process
    holding the hosted alerts lock, and reports open alerts as a gauge.

    The lock is a session lock on a connection of its own, so it goes with
    that connection if the process dies, and another process takes over on its
    next try. The rows are written through the ordinary session factory, under
    each pair's own lock, so a failover can't double an alert.
    """

    def __init__(
        self,
        engine_factory: Callable[[], AsyncEngine],
        session_factory: async_sessionmaker[AsyncSession],
        key: KeyedIdKey,
        latest_report: Callable[[], HeldReport | None],
        *,
        interval_seconds: float = EVALUATE_INTERVAL_SECONDS,
        timeout_seconds: float = EVALUATE_TIMEOUT_SECONDS,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._engine_factory = engine_factory
        self._session_factory = session_factory
        self._key = key
        self._latest_report = latest_report
        self._interval = interval_seconds
        self._timeout = timeout_seconds
        self._clock = clock
        self._engine: AsyncEngine | None = None
        self._conn: AsyncConnection | None = None
        self._holds_lock = False
        self._waiting_since = clock()
        self._open_counts: dict[Condition, int] | None = None
        self._last_failure_log = float("-inf")

    def readings(self) -> Iterator[GaugeReading]:
        """`switch.hosted.alerts_open{condition}`, only while this process
        evaluates, so two processes never both report it."""
        counts = self._open_counts
        if counts is None:
            return
        for condition in Condition:
            yield GaugeReading(
                HOSTED_ALERTS_OPEN,
                float(counts.get(condition, 0)),
                {"condition": condition.value},
            )

    async def run_forever(self) -> None:
        try:
            while True:
                await self.evaluate_once()
                await asyncio.sleep(self._interval)
        finally:
            await self.aclose()

    async def evaluate_once(self) -> int | None:
        """One evaluation if this process holds the lock: the number of rows
        written, or None when it isn't the evaluator."""
        try:
            return await asyncio.wait_for(self._evaluate(), self._timeout)
        except Exception as exc:
            self._open_counts = None
            await self._drop_connection()
            self._log_failure(exc)
            return None

    async def _evaluate(self) -> int | None:
        rows = await self._read()
        if rows is None:
            self._open_counts = None
            return None
        now = self._clock()
        verdicts = box_verdicts(rows, self._key, now)
        verdicts.append(
            cluster_report_verdict(self._latest_report(), now, self._waiting_since)
        )
        written = await apply_verdicts(
            self._session_factory,
            verdicts,
            BOX_CONDITIONS | {Condition.CLUSTER_REPORT_LATE},
            now,
        )
        with no_tenant():
            async with self._session_factory() as session:
                current = await open_alerts(session)
        counts: dict[Condition, int] = {}
        for alert in current:
            counts[alert.condition] = counts.get(alert.condition, 0) + 1
        self._open_counts = counts
        return written

    async def _read(self) -> list[MachineRow] | None:
        conn = await self._connection()
        if not self._holds_lock:
            got = (await conn.execute(_TRY_LOCK, {"name": LOCK_NAME})).scalar()
            if not got:
                return None
            self._holds_lock = True
            # A7 counts from now: a report that went to another process while
            # this one wasn't evaluating says nothing about the operator.
            self._waiting_since = self._clock()
            logger.info("This process now evaluates the hosted alerts.")
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
            if self._engine is None:
                self._engine = self._engine_factory()
            conn = await self._engine.connect()
            self._conn = await conn.execution_options(isolation_level="AUTOCOMMIT")
            self._holds_lock = False
        return self._conn

    def _log_failure(self, exc: BaseException) -> None:
        now = time.monotonic()
        if now - self._last_failure_log < FAILURE_LOG_INTERVAL_SECONDS:
            return
        self._last_failure_log = now
        logger.warning(
            "Could not evaluate the hosted alerts (%s); retrying every %.0fs, "
            "and saying so at most once a minute.",
            type(exc).__name__,
            self._interval,
        )

    async def _drop_connection(self) -> None:
        conn, self._conn = self._conn, None
        self._holds_lock = False
        if conn is None:
            return
        try:
            await asyncio.wait_for(conn.close(), self._timeout)
        except Exception:
            logger.debug("Closing the hosted alerts evaluator's connection failed.")

    async def aclose(self) -> None:
        self._open_counts = None
        await self._drop_connection()
        engine, self._engine = self._engine, None
        if engine is not None:
            await engine.dispose()
