"""The operators' audit log and operator list, read-only.

Two routes, for people on Core's operator list only. `GET
/shared-cloud/audit-events` is the log; `GET /shared-cloud/operators` is who
holds the role now (W5's Operators tab).

The log route reads this feature's entries in `server_audit_events`: every
operator action, name reveal and operator grant, each alert, and a keyed copy
of each workspace admin change. The table's older server-wide entries are never
returned. Workspaces appear there as keyed ids only, so this route never
needs to read any workspace's own table.

There is no route that changes or deletes an entry, for any role, and the
runtime role has no `UPDATE` or `DELETE` on the table either.

**Operators are named to each other**, and to no one
else. An entry's `actor_name` is filled only for an actor who has ever been
granted the role in this log (`operator.granted`), so a removed operator's past
entries keep their name, and no other person's name can come back: a workspace
admin's copy carries a keyed id as its actor, and box and alert entries carry
none. Names are read from `users`, which has no tenant and no policy, on the
request's own session. Nothing returns an email.
"""

from __future__ import annotations

from collections.abc import Collection, Sequence
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel
from sqlalchemy import ColumnElement, func, literal_column, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.audit import ServerAuditAction
from switch_core.db.models import ServerAuditEvent, User
from switch_core.gateway.dependencies import get_session, get_session_factory
from switch_core.visibility.alerts import Condition, alert_title
from switch_core.visibility.guards import (
    get_operator_list,
    record_list_changes,
    require_operator,
)
from switch_core.visibility.operators import OperatorList

router = APIRouter()

# Only this feature's entries, never the table's older server-wide ones
# (connector apps, settings), which weren't written to the ids-only rule and
# may hold raw ids or names. Applied to every read.
HOSTED_ACTION_PREFIXES = ("hosted.", "operator.", "alert.")
# Alerts share the table and would bury the actions, so the default view
# leaves them out; an operator sees them by filtering for one.
ALERT_PREFIX = "alert."


def is_hosted_action(action: str) -> bool:
    return action.startswith(HOSTED_ACTION_PREFIXES)


def _hosted_only() -> ColumnElement[bool]:
    return or_(
        *(
            ServerAuditEvent.action.startswith(prefix, autoescape=True)
            for prefix in HOSTED_ACTION_PREFIXES
        )
    )


_MAX_TARGET = 128

# An alert row's condition, with the key written inline, as the alerts code does
# (`alerts._CONDITION`): `'condition'` is a constant, never input.
_CONDITION = ServerAuditEvent.details.op("->>")(literal_column("'condition'"))


class OperatorAuditEvent(BaseModel):
    id: str
    occurred_at: str
    actor_user_id: str | None
    # The operator's name, for an actor ever granted the role; else None.
    actor_name: str | None = None
    action: str
    target_type: str
    target_id: str | None
    details: dict[str, Any] | None
    # An alert entry's fixed one-line title (`alerts.alert_title`), so every
    # screen words an alert the way the ops room does. None on other entries.
    title: str | None = None


async def _ever_operators(session: AsyncSession, ids: Collection[str]) -> set[str]:
    """Which of `ids` have ever been granted the role in this log."""
    if not ids:
        return set()
    rows = await session.scalars(
        select(ServerAuditEvent.target_id)
        .where(
            ServerAuditEvent.action == ServerAuditAction.OPERATOR_GRANTED.value,
            ServerAuditEvent.target_id.in_(list(ids)),
        )
        .distinct()
    )
    return {row for row in rows if row is not None}


async def _names(session: AsyncSession, ids: Collection[str]) -> dict[str, str]:
    if not ids:
        return {}
    rows = await session.execute(
        select(User.id, User.name).where(User.id.in_(list(ids)))
    )
    return {user_id: name for user_id, name in rows.all() if name}


def _condition(row: ServerAuditEvent) -> Condition | None:
    try:
        return Condition(str((row.details or {}).get("condition")))
    except ValueError:
        return None


def _figure(details: dict[str, Any] | None) -> float | None:
    figure = (details or {}).get("figure")
    if isinstance(figure, bool) or not isinstance(figure, int | float):
        return None
    return float(figure)


async def _alert_titles(
    session: AsyncSession, rows: Sequence[ServerAuditEvent]
) -> dict[str, str]:
    """Each alert entry's title. A clear is titled with the figure of the raise
    it closes, so "Alert cleared" names what was raised, not the figure that
    cleared it."""
    alerts = [row for row in rows if row.action.startswith(ALERT_PREFIX)]
    clears = [
        row for row in alerts if row.action == ServerAuditAction.ALERT_CLEARED.value
    ]
    raises_by_pair: dict[tuple[str, str, str], list[ServerAuditEvent]] = {}
    clears_by_pair: dict[tuple[str, str, str], list[ServerAuditEvent]] = {}
    for row in clears:
        condition = _condition(row)
        if condition is not None:
            pair = (condition.value, row.target_type, row.target_id or "")
            clears_by_pair.setdefault(pair, []).append(row)
    for (condition_value, target_type, target_id), paired in clears_by_pair.items():
        # Only the raises these clears can close: from the newest raise at or
        # before the earliest clear on the page, up to the latest clear. So a
        # box raised and cleared many times costs the same as one raised once.
        same = (
            ServerAuditEvent.action == ServerAuditAction.ALERT_RAISED.value,
            _CONDITION == condition_value,
            ServerAuditEvent.target_type == target_type,
            ServerAuditEvent.target_id == target_id,
        )
        first = min(row.occurred_at for row in paired)
        last = max(row.occurred_at for row in paired)
        floor = (
            select(func.max(ServerAuditEvent.occurred_at))
            .where(*same, ServerAuditEvent.occurred_at <= first)
            .scalar_subquery()
        )
        earlier = await session.scalars(
            select(ServerAuditEvent)
            .where(
                *same,
                ServerAuditEvent.occurred_at <= last,
                ServerAuditEvent.occurred_at >= func.coalesce(floor, first),
            )
            .order_by(ServerAuditEvent.occurred_at, ServerAuditEvent.id)
        )
        raises_by_pair[(condition_value, target_type, target_id)] = list(earlier)
    titles: dict[str, str] = {}
    for row in alerts:
        condition = _condition(row)
        if condition is None:
            continue
        figure = _figure(row.details)
        if row.action == ServerAuditAction.ALERT_CLEARED.value:
            pair = (condition.value, row.target_type, row.target_id or "")
            before = [
                r
                for r in raises_by_pair.get(pair, [])
                if r.occurred_at <= row.occurred_at
            ]
            figure = _figure(before[-1].details) if before else None
        titles[row.id] = alert_title(condition, row.target_id or "", figure)
    return titles


@router.get("/shared-cloud/audit-events")
async def list_operator_audit_events(
    session: Annotated[AsyncSession, Depends(get_session)],
    _operator: Annotated[User, Depends(require_operator)],
    action: Annotated[str | None, Query()] = None,
    target_id: Annotated[str | None, Query(max_length=_MAX_TARGET)] = None,
    since: Annotated[datetime | None, Query()] = None,
    before: Annotated[datetime | None, Query()] = None,
    before_id: Annotated[str | None, Query(max_length=_MAX_TARGET)] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> list[OperatorAuditEvent]:
    """Newest first. Filter by action, by target (a keyed id, or an operator's
    user id for grants), and by time. Alerts show only when filtered for.

    Page back by passing the last entry returned as `before` (its
    `occurred_at`) and `before_id` (its `id`): the next page starts strictly
    after it in the same (time, id) order, so entries sharing that exact time
    are neither skipped nor repeated. `before` alone still means "older than
    this time"."""
    query = select(ServerAuditEvent).where(_hosted_only())
    if action is not None:
        if len(action) > _MAX_TARGET or not is_hosted_action(action):
            raise HTTPException(status_code=422, detail="Unknown action")
        query = query.where(ServerAuditEvent.action == action)
    else:
        query = query.where(
            ~ServerAuditEvent.action.startswith(ALERT_PREFIX, autoescape=True)
        )
    if target_id is not None:
        query = query.where(ServerAuditEvent.target_id == target_id)
    if since is not None:
        query = query.where(ServerAuditEvent.occurred_at >= since)
    if before is not None and before_id is not None:
        query = query.where(
            or_(
                ServerAuditEvent.occurred_at < before,
                (ServerAuditEvent.occurred_at == before)
                & (ServerAuditEvent.id < before_id),
            )
        )
    elif before is not None:
        query = query.where(ServerAuditEvent.occurred_at < before)
    rows = (
        (
            await session.execute(
                query.order_by(
                    ServerAuditEvent.occurred_at.desc(), ServerAuditEvent.id.desc()
                ).limit(limit)
            )
        )
        .scalars()
        .all()
    )
    # A workspace admin's copy names its actor by keyed id, never a user id,
    # so it is never looked up.
    actors = {
        row.actor_user_id
        for row in rows
        if row.actor_user_id is not None
        and row.action != ServerAuditAction.HOSTED_ADMIN_CHANGE.value
    }
    names = await _names(session, await _ever_operators(session, actors))
    titles = await _alert_titles(session, rows)
    await session.commit()
    return [
        OperatorAuditEvent(
            id=row.id,
            occurred_at=row.occurred_at.isoformat(),
            actor_user_id=row.actor_user_id,
            actor_name=(
                names.get(row.actor_user_id)
                if row.actor_user_id is not None
                and row.action != ServerAuditAction.HOSTED_ADMIN_CHANGE.value
                else None
            ),
            action=row.action,
            target_type=row.target_type,
            target_id=row.target_id,
            details=row.details,
            title=titles.get(row.id),
        )
        for row in rows
    ]


class HostedOperator(BaseModel):
    name: str
    # When they were last granted the role, from the log; None if the log has
    # no grant for them (it always should).
    since: str | None
    how: Literal["server_settings"] = "server_settings"
    you: bool


@router.get("/shared-cloud/operators")
async def list_hosted_operators(
    session: Annotated[AsyncSession, Depends(get_session)],
    operator: Annotated[User, Depends(require_operator)],
    operators: Annotated[OperatorList, Depends(get_operator_list)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    response: Response,
) -> list[HostedOperator]:
    """Who is on the operator list now, by name, for operators only (W5's
    Operators tab). Someone removed from the list isn't here, whatever the log
    holds. No ids and no emails: a name, when they got the role, how (always
    Core's server settings, since the list is a file), and whether it's you."""
    response.headers["Cache-Control"] = "no-store"
    # The list as it's now recorded on the log: the snapshot `require_operator`
    # checked, or a newer one if the file changed in between.
    current = (await record_list_changes(operators, session_factory)).ids
    names = await _names(session, current)
    granted = await session.execute(
        select(ServerAuditEvent.target_id, func.max(ServerAuditEvent.occurred_at))
        .where(
            ServerAuditEvent.action == ServerAuditAction.OPERATOR_GRANTED.value,
            ServerAuditEvent.target_id.in_(list(current)),
        )
        .group_by(ServerAuditEvent.target_id)
    )
    since = {user_id: at for user_id, at in granted.all()}
    await session.commit()
    listed = [
        HostedOperator(
            name=names[user_id],
            since=since[user_id].isoformat() if user_id in since else None,
            you=user_id == operator.id,
        )
        # A listed id with no user, or no name, is left out rather than shown
        # as an id.
        for user_id in current
        if user_id in names
    ]
    return sorted(listed, key=lambda o: o.name.casefold())
