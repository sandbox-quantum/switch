"""Rate limits on operator actions, and the bulk-action alert (A11).

Limits, so a stolen operator login can't pause or restart everyone:

- **Actions** (pause, resume, restart, drain; one drain is one action): at most
  `visibility_operator_actions_per_hour` per operator (10), and at most
  `visibility_operator_actions_server_per_hour` across every operator (30).
- **Show name:** at most `visibility_operator_reveals_per_hour` per operator (30).
- **A11:** an operator's `visibility_operator_bulk_actions`th action (3) within
  `visibility_operator_bulk_window_minutes` (10) raises `operator_bulk_actions`
  by their keyed id. It alerts and never blocks. `clear_quiet_bulk_alerts`, on
  its own timer, clears it once they've gone quiet. The evaluator never
  touches it.

**The audit log is the counter.** A request entry is written for every
attempt, refused ones included, so the count is the operator's own
`requested` entries in `server_audit_events`. Nothing is kept in memory, so
it holds across Core processes and restarts. **The count and the write sit
under one advisory lock** (`limit_slot`): server-wide for actions, because of
the server-wide ceiling, and per operator for Show name. So two requests at
once can't both take the last slot.

Over a limit, the request is still written, marked `rate_limited: true` in
its own details (`request_extra`), then its result is `failed` with the step
`rate_limited`, and the caller answers 429 with `Retry-After: 3600`.

Counting:
- **The server-wide count leaves out requests refused for a limit**, read
  from that mark, so one operator past their own limit can't use up everyone
  else's. Refused requests still count towards their own limit and A11.
- **The lock covers the count and the request entry only.** The caller does
  the action itself (the mark, the revoke, the retire) after the block ends.
  The lock waits at most `LOCK_TIMEOUT_S`; past that, `LimitBusy` (a 503).
- A11's title takes the window from the setting, and the overview shows the
  operator's current count while A11 is raised (`bulk_counts`).

Drains:
- **A daily drain cap:** at most `visibility_operator_drains_per_day` drains
  (3) in the last 24 hours across every operator, refused ones left out. It's
  a third limit, kind `drain`, under the same server-wide lock as actions; a
  drain still counts as one action towards the hourly limits.
- **Which limit refused:** `limit_slot` yields the refusal code, or None:
  `drain_daily_cap` for the cap, `rate_limited` for the others. Both mark the
  entry `rate_limited`, so neither count is used up by a refused request.
- **Any drain raises A11** for its operator, whatever their count, and the
  sweep keeps it raised while the drain is in the window.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Collection, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Literal

from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.db.audit import ServerAuditAction
from switch_core.db.models import ServerAuditEvent
from switch_core.tenant_context import no_tenant
from switch_core.visibility.alerts import (
    Condition,
    Verdict,
    apply_alert,
    open_alerts,
    set_bulk_window_minutes,
)
from switch_core.visibility.audit_log import (
    OperatorActionRecord,
    TargetType,
    record_operator_request,
)
from switch_core.visibility.keyed_id import KeyedIdKey, KeyedIdKind

logger = logging.getLogger(__name__)

# The operator actions the hourly limits and the bulk alert count together.
ACTIONS: tuple[str, ...] = (
    ServerAuditAction.HOSTED_USER_PAUSED.value,
    ServerAuditAction.HOSTED_USER_RESUMED.value,
    ServerAuditAction.HOSTED_BOX_RESTARTED.value,
    ServerAuditAction.HOSTED_MACHINE_DRAINED.value,
)
REVEALS: tuple[str, ...] = (ServerAuditAction.OPERATOR_NAME_REVEALED.value,)

HOUR = timedelta(hours=1)
RETRY_AFTER_S = 3600
RATE_LIMITED = "rate_limited"
# How long a request waits for the limit's lock before it's answered 503.
LOCK_TIMEOUT_S = 10
_LOCK_NOT_AVAILABLE = "55P03"
# The limits. Each is a Core setting; one set above its default is
# allowed (bounded in `SwitchConfig`) but warned about at start.
DEFAULTS = {
    "visibility_operator_actions_per_hour": 10,
    "visibility_operator_actions_server_per_hour": 30,
    "visibility_operator_reveals_per_hour": 30,
    "visibility_operator_bulk_actions": 3,
    "visibility_operator_bulk_window_minutes": 10,
    "visibility_operator_drains_per_day": 3,
}

Kind = Literal["action", "reveal", "drain"]
DRAINS: tuple[str, ...] = (ServerAuditAction.HOSTED_MACHINE_DRAINED.value,)
DAY = timedelta(hours=24)
DRAIN_DAILY_CAP = "drain_daily_cap"


class LimitBusy(Exception):
    """The limit's lock wasn't free within `LOCK_TIMEOUT_S`: answer 503, with
    nothing written."""


def request_extra(over: bool) -> dict[str, bool] | None:
    """The request entry's mark for a request refused for a limit, so the
    server-wide count can leave it out without a join to its result."""
    return {RATE_LIMITED: True} if over else None


@dataclass(frozen=True)
class Limits:
    actions_per_hour: int
    actions_server_per_hour: int
    reveals_per_hour: int
    bulk_actions: int
    bulk_window: timedelta
    drains_per_day: int = 3

    @classmethod
    def from_config(cls, config: SwitchConfig) -> Limits:
        return cls(
            actions_per_hour=config.visibility_operator_actions_per_hour,
            actions_server_per_hour=config.visibility_operator_actions_server_per_hour,
            reveals_per_hour=config.visibility_operator_reveals_per_hour,
            bulk_actions=config.visibility_operator_bulk_actions,
            bulk_window=timedelta(
                minutes=config.visibility_operator_bulk_window_minutes
            ),
            drains_per_day=config.visibility_operator_drains_per_day,
        )


def configure_limits(config: SwitchConfig) -> None:
    """Once at start: A11's title takes its window from the setting, and any
    limit looser than the default is named."""
    set_bulk_window_minutes(config.visibility_operator_bulk_window_minutes)
    warn_raised_limits(config)


def warn_raised_limits(config: SwitchConfig) -> None:
    """Once at start: name any limit set above the default (names and
    numbers only), so a loosened limit is never silent."""
    for name, default in DEFAULTS.items():
        value = getattr(config, name)
        # The window is the one where a larger number is the stricter one.
        looser = (
            value < default
            if name == "visibility_operator_bulk_window_minutes"
            else value > default
        )
        if looser:
            logger.warning(
                "Operator limit %s is %s, looser than its default of %s",
                name,
                value,
                default,
            )


async def operator_requests_since(
    session: AsyncSession,
    operator_id: str | None,
    actions: Collection[str],
    since: datetime,
    *,
    skip_rate_limited: bool = False,
    skip_not_found: bool = False,
) -> int:
    """Request entries for these actions since `since`, refused ones included:
    one operator's, or everyone's with `operator_id` None. With
    `skip_rate_limited`, requests refused for a limit are left out; with
    `skip_not_found`, drains for an id that matched no node."""
    query = (
        select(func.count())
        .select_from(ServerAuditEvent)
        .where(
            ServerAuditEvent.action.in_(list(actions)),
            ServerAuditEvent.occurred_at > since,
            ServerAuditEvent.details["phase"].astext == "requested",
        )
    )
    if operator_id is not None:
        query = query.where(ServerAuditEvent.actor_user_id == operator_id)
    if skip_rate_limited:
        query = query.where(
            ServerAuditEvent.details[RATE_LIMITED].astext.is_distinct_from("true")
        )
    if skip_not_found:
        query = query.where(
            ServerAuditEvent.details["not_found"].astext.is_distinct_from("true")
        )
    return int(await session.scalar(query) or 0)


@asynccontextmanager
async def limit_slot(
    session_factory: async_sessionmaker[AsyncSession],
    operator_id: str,
    kind: Kind,
    limits: Limits,
    now: datetime,
    *,
    lock_timeout_s: int | None = None,
) -> AsyncIterator[str | None]:
    """Hold the limit's lock while the caller writes its request entry, and
    nothing else: the action itself runs after the block ends.

    Yields the refusal code when the request is over a limit, else None:
    `drain_daily_cap` for a drain over the daily cap, `rate_limited` for any
    other limit. The caller then writes the request with `request_extra(True)`
    and a result with that code as its step, and answers 429, doing nothing
    else. The lock is released once the caller's
    block ends, so the next request's count sees this one's entry. Raises
    `LimitBusy` if the lock isn't free within `lock_timeout_s`."""
    lock = (
        f"switch.operator_limit:reveals:{operator_id}"
        if kind == "reveal"
        else "switch.operator_limit:actions"
    )
    with no_tenant():
        async with session_factory() as session:
            # A whole number of seconds, so it's safe to put in the statement.
            timeout = int(LOCK_TIMEOUT_S if lock_timeout_s is None else lock_timeout_s)
            await session.execute(text(f"SET LOCAL lock_timeout = '{timeout}s'"))
            try:
                await session.execute(
                    text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
                    {"key": lock},
                )
            except DBAPIError as error:
                if getattr(error.orig, "sqlstate", None) == _LOCK_NOT_AVAILABLE:
                    await session.rollback()
                    raise LimitBusy(kind) from None
                raise
            refusal = await _refusal(session, operator_id, kind, limits, now)
            try:
                yield refusal
            finally:
                # Ends the transaction, which releases the lock.
                await session.commit()


async def _refusal(
    session: AsyncSession,
    operator_id: str,
    kind: Kind,
    limits: Limits,
    now: datetime,
) -> str | None:
    """Which limit, if any, this request is over, counted under the lock."""
    since = now - HOUR
    if kind == "reveal":
        over = (
            await operator_requests_since(session, operator_id, REVEALS, since)
            >= limits.reveals_per_hour
        )
        return RATE_LIMITED if over else None
    # The daily drain cap first: it's server-wide and lasts longest, so it's
    # the more useful thing to tell the operator. Drains refused for a limit
    # don't count, nor ones for an id that matched no node.
    if (
        kind == "drain"
        and await operator_requests_since(
            session,
            None,
            DRAINS,
            now - DAY,
            skip_rate_limited=True,
            skip_not_found=True,
        )
        >= limits.drains_per_day
    ):
        return DRAIN_DAILY_CAP
    # D1: the server-wide count leaves out refused requests, so one operator
    # past their own limit can't use up everyone's.
    over = (
        await operator_requests_since(session, operator_id, ACTIONS, since)
        >= limits.actions_per_hour
        or await operator_requests_since(
            session, None, ACTIONS, since, skip_rate_limited=True
        )
        >= limits.actions_server_per_hour
    )
    return RATE_LIMITED if over else None


async def limited_request(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    operator_id: str,
    kind: Kind,
    limits: Limits,
    now: datetime,
    action: ServerAuditAction,
    target_type: TargetType,
    target_keyed_id: str,
    reason: str,
    workspaces: Sequence[tuple[str, str]] = (),
    box_keyed_id: str | None = None,
    extra: Mapping[str, Any] | None = None,
) -> tuple[OperatorActionRecord, str | None]:
    """The one way an operator action, drain or Show name is let through the
    limits: the count and the request entry, under the limit's lock, and
    nothing else. Returns the entry and the refusal code if it was over a
    limit (`rate_limited`, or `drain_daily_cap` for kind `drain`), else None.

    Over a limit, the entry is marked `rate_limited` (so the server-wide count
    leaves it out) and gets no workspace copies, since nothing happens in any
    workspace; the caller records its `rate_limited` result and answers 429.
    Otherwise the caller does the action itself after this returns, with the
    lock released. Raises `LimitBusy` (a 503) if the lock isn't free in time,
    with nothing written, and `AuditInputError` for a bad reason."""
    async with limit_slot(session_factory, operator_id, kind, limits, now) as refusal:
        over = refusal is not None
        record = await record_operator_request(
            session_factory,
            actor_user_id=operator_id,
            action=action,
            target_type=target_type,
            target_keyed_id=target_keyed_id,
            reason=reason,
            workspaces=() if over else workspaces,
            box_keyed_id=box_keyed_id,
            # A caller can never mark its own request refused: only this helper
            # sets `rate_limited`.
            extra={
                **{k: v for k, v in (extra or {}).items() if k != RATE_LIMITED},
                **(request_extra(over) or {}),
            }
            or None,
        )
    return record, refusal


async def note_bulk_actions(
    session_factory: async_sessionmaker[AsyncSession],
    key: KeyedIdKey,
    operator_id: str,
    limits: Limits,
    now: datetime,
) -> None:
    """After an operator's action request (done or refused): raise A11 at the
    threshold, or on any drain of theirs in the window. Never blocks, and
    a failure is logged without touching the action."""
    try:
        with no_tenant():
            async with session_factory() as session:
                since = now - limits.bulk_window
                count = await operator_requests_since(
                    session, operator_id, ACTIONS, since
                )
                drains = await operator_requests_since(
                    session, operator_id, DRAINS, since
                )
                await session.commit()
        if count >= limits.bulk_actions or drains > 0:
            await apply_alert(
                session_factory,
                Verdict(
                    Condition.OPERATOR_BULK_ACTIONS,
                    key.keyed_id(KeyedIdKind.USER, operator_id),
                    True,
                    count,
                ),
                now,
            )
    except Exception:
        logger.exception("Updating the bulk operator action alert failed")


async def bulk_counts(
    session: AsyncSession,
    key: KeyedIdKey,
    window: timedelta,
    now: datetime,
    *,
    actions: Collection[str] = ACTIONS,
) -> dict[str, int]:
    """Each recent operator's requests for `actions` (every operator action
    by default) within `window`, by their keyed id: recomputed from each
    recent actor, never reversed."""
    actors = (
        await session.scalars(
            select(ServerAuditEvent.actor_user_id)
            .where(
                ServerAuditEvent.action.in_(list(ACTIONS)),
                ServerAuditEvent.occurred_at > now - timedelta(days=1),
                ServerAuditEvent.actor_user_id.is_not(None),
            )
            .distinct()
        )
    ).all()
    counts: dict[str, int] = {}
    for actor in actors:
        if actor is None:
            continue
        counts[key.keyed_id(KeyedIdKind.USER, actor)] = await operator_requests_since(
            session, actor, actions, now - window
        )
    return counts


async def live_bulk_figures(
    session: AsyncSession, key: KeyedIdKey, limits: Limits, now: datetime
) -> dict[tuple[str, str], float]:
    """For the overview: each raised A11's current count, so its title follows
    the operator's actions rather than the count it was raised at. Empty when
    no A11 is raised."""
    raised = await open_alerts(session, (Condition.OPERATOR_BULK_ACTIONS,))
    if not raised:
        return {}
    counts = await bulk_counts(session, key, limits.bulk_window, now)
    return {
        (Condition.OPERATOR_BULK_ACTIONS.value, alert.target_id): float(
            counts[alert.target_id]
        )
        for alert in raised
        if alert.target_id in counts
    }


async def clear_quiet_bulk_alerts(
    session_factory: async_sessionmaker[AsyncSession],
    key: KeyedIdKey,
    limits: Limits,
    now: datetime,
) -> int:
    """Clear A11 for every operator now under the threshold in the window.
    The alert names a keyed id, so it's matched by recomputing the keyed id
    of each recent actor, never by reversing it. An alert whose operator has
    no action in the last day is cleared too. Returns how many it cleared."""
    with no_tenant():
        async with session_factory() as session:
            raised = await open_alerts(session, (Condition.OPERATOR_BULK_ACTIONS,))
            if not raised:
                await session.commit()
                return 0
            counts = await bulk_counts(session, key, limits.bulk_window, now)
            drains = await bulk_counts(
                session, key, limits.bulk_window, now, actions=DRAINS
            )
            await session.commit()
    cleared = 0
    for alert in raised:
        quiet = counts.get(alert.target_id, 0) < limits.bulk_actions
        # A drain in the window keeps A11 raised whatever the count.
        if quiet and drains.get(alert.target_id, 0) == 0:
            outcome = await apply_alert(
                session_factory,
                Verdict(Condition.OPERATOR_BULK_ACTIONS, alert.target_id, False),
                now,
            )
            cleared += outcome == "cleared"
    return cleared
