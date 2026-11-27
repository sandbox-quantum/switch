"""The hosted agents v2 warm pool's rows (`hosted_pool_boxes`) and the box
operator's last report (`hosted_operator_reports`).

Every function takes the caller's session and opens none: the callers are
`visibility.box_provision` and the hosted controller, provisioner and reaper
routes, which own the transactions (and the claims lock). A pool box's state
only moves forward:

    requested → waiting → claimed
        ↘          ↘        ↘ (a claim that failed before its owner was written)
         retiring ←──────────
             ↓
            gone

`retiring` is reapable only with one of `REAPABLE` as its reason; anything
else about a box that reached its owner is never this table's to delete.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Collection
from datetime import datetime, timedelta
from typing import Literal
from uuid import uuid4

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import HostedOperatorReport, HostedPoolBox

PoolState = Literal["requested", "waiting", "claimed", "retiring", "gone"]
RetireReason = Literal["image", "age", "size", "make_failed", "failed_before_owner"]

# The reasons a retiring box may be reaped for: nothing of a person's ever
# reached it, so only boxes no person ever had are destroyed.
REAPABLE: frozenset[str] = frozenset(
    {"image", "age", "size", "make_failed", "failed_before_owner"}
)
# The capabilities an operator may report; any other word is ignored.
CAPABILITIES: frozenset[str] = frozenset({"box_keyed_names", "pool", "bind"})
# How long a waiting box may be claimed after it came up.
FRESH_FOR = timedelta(hours=24)
OPERATOR_ROW = "operator"


async def request_boxes(session: AsyncSession, count: int, now: datetime) -> list[str]:
    """Add `count` pool boxes in `requested`; returns their ids (each the
    machine id it becomes when claimed)."""
    ids = [str(uuid4()) for _ in range(max(0, count))]
    for box_id in ids:
        session.add(HostedPoolBox(id=box_id, state="requested", requested_at=now))
    await session.flush()
    return ids


async def counts(session: AsyncSession) -> Counter[str]:
    """How many pool boxes are in each state (`gone` included)."""
    rows = await session.execute(select(HostedPoolBox.state))
    return Counter(state for (state,) in rows.all())


async def get(session: AsyncSession, box_id: str) -> HostedPoolBox | None:
    return await session.get(HostedPoolBox, box_id, populate_existing=True)


async def pick_waiting(
    session: AsyncSession, template_revision: str | None, now: datetime
) -> HostedPoolBox | None:
    """The oldest claimable box, locked for this transaction (`FOR UPDATE SKIP
    LOCKED`): waiting, made at the operator's current template revision, and
    up within `FRESH_FOR`. None when there's none, or no current revision is
    known: a claim never takes a box it can't vouch for."""
    if template_revision is None:
        return None
    found: HostedPoolBox | None = await session.scalar(
        select(HostedPoolBox)
        .where(
            HostedPoolBox.state == "waiting",
            HostedPoolBox.template_revision == template_revision,
            HostedPoolBox.ready_at.is_not(None),
            HostedPoolBox.ready_at > now - FRESH_FOR,
        )
        .order_by(HostedPoolBox.ready_at, HostedPoolBox.id)
        .limit(1)
        .with_for_update(skip_locked=True)
    )
    return found


async def mark_claimed(session: AsyncSession, box_id: str, now: datetime) -> bool:
    """`waiting` → `claimed`, only if it's still waiting: the second guard
    behind the row lock. Returns whether exactly one row changed."""
    result = await session.execute(
        update(HostedPoolBox)
        .where(HostedPoolBox.id == box_id, HostedPoolBox.state == "waiting")
        .values(state="claimed", claimed_at=now)
    )
    return bool(result.rowcount == 1)  # type: ignore[attr-defined]


async def mark_waiting(
    session: AsyncSession,
    box_id: str,
    *,
    namespace: str,
    template_revision: str | None,
    now: datetime,
) -> bool:
    """`requested` → `waiting`, when the operator reports the pool box made,
    with the namespace Core issued and the revision it was made at."""
    result = await session.execute(
        update(HostedPoolBox)
        .where(HostedPoolBox.id == box_id, HostedPoolBox.state == "requested")
        .values(
            state="waiting",
            namespace=namespace,
            template_revision=template_revision,
            ready_at=now,
        )
    )
    return bool(result.rowcount == 1)  # type: ignore[attr-defined]


async def retire(
    session: AsyncSession,
    box_id: str,
    reason: RetireReason,
    now: datetime,
    *,
    from_states: Collection[PoolState] = ("requested", "waiting"),
) -> bool:
    """Move a box to `retiring` with its reason, only from `from_states`
    (a claimed box only with `failed_before_owner`, and only when the caller
    has checked its bind never reached `owner_writing`)."""
    if reason not in REAPABLE:
        raise ValueError(f"not a retire reason: {reason}")
    states = list(from_states)
    if "claimed" in states and reason != "failed_before_owner":
        raise ValueError("a claimed box retires only as failed_before_owner")
    result = await session.execute(
        update(HostedPoolBox)
        .where(HostedPoolBox.id == box_id, HostedPoolBox.state.in_(states))
        .values(state="retiring", retire_reason=reason, retired_at=now)
    )
    return bool(result.rowcount == 1)  # type: ignore[attr-defined]


async def retiring(session: AsyncSession) -> list[HostedPoolBox]:
    """The boxes the reaper may destroy: `retiring` with a reapable reason."""
    rows = await session.scalars(
        select(HostedPoolBox)
        .where(
            HostedPoolBox.state == "retiring",
            HostedPoolBox.retire_reason.in_(sorted(REAPABLE)),
        )
        .order_by(HostedPoolBox.retired_at, HostedPoolBox.id)
    )
    return list(rows.all())


async def mark_gone(session: AsyncSession, box_id: str, now: datetime) -> bool:
    """`retiring` → `gone`, only with a reapable reason. False otherwise: the
    caller refuses the reaper and alerts."""
    result = await session.execute(
        update(HostedPoolBox)
        .where(
            HostedPoolBox.id == box_id,
            HostedPoolBox.state == "retiring",
            HostedPoolBox.retire_reason.in_(sorted(REAPABLE)),
        )
        .values(state="gone")
    )
    return bool(result.rowcount == 1)  # type: ignore[attr-defined]


async def live(session: AsyncSession) -> list[HostedPoolBox]:
    """Every pool box not yet claimed or gone, for the scaler and the sweep."""
    rows = await session.scalars(
        select(HostedPoolBox)
        .where(HostedPoolBox.state.in_(["requested", "waiting", "retiring"]))
        .order_by(HostedPoolBox.requested_at, HostedPoolBox.id)
    )
    return list(rows.all())


def known_capabilities(reported: object) -> frozenset[str]:
    """The fixed words in what an operator reported; anything else, ignored."""
    if not isinstance(reported, list):
        return frozenset()
    return frozenset(word for word in reported if word in CAPABILITIES)


async def record_operator(
    session: AsyncSession,
    *,
    template_revision: str | None,
    capabilities: Collection[str],
    now: datetime,
    boxes_live: int | None = None,
    box_ceiling: int | None = None,
) -> None:
    """Keep the operator's last report: its revision, its capabilities, and
    its live boxes and ceiling (None from an operator that doesn't send
    them)."""
    row = await session.get(HostedOperatorReport, OPERATOR_ROW, populate_existing=True)
    words = sorted(known_capabilities(list(capabilities)))
    if row is None:
        session.add(
            HostedOperatorReport(
                id=OPERATOR_ROW,
                template_revision=template_revision,
                capabilities=words,
                seen_at=now,
                boxes_live=boxes_live,
                box_ceiling=box_ceiling,
            )
        )
    else:
        row.template_revision = template_revision
        row.capabilities = words
        row.seen_at = now
        row.boxes_live = boxes_live
        row.box_ceiling = box_ceiling
    await session.flush()


async def operator(session: AsyncSession) -> HostedOperatorReport | None:
    return await session.get(HostedOperatorReport, OPERATOR_ROW, populate_existing=True)
