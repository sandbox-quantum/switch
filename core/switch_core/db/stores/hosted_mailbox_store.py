"""The wake mailbox: every addressed event for a hosted agent until its worker admits it.

Every transition is a conditional update that only moves a row forward, so a
retried ack, a reclaim racing an ack or a Stop racing an offer can never
regress a row. Rows are keyed by `(agent, room, roomInputId)`, the same key
the watcher dedupes by.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from sqlalchemy import and_, delete, func, or_, select, tuple_, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.agent.protocol.types import AgentEvent
from switch_core.db.models import HostedWakeMailbox, require_tenant_id

#: Rows `pending` or `offered` one agent may hold before an insert is refused.
MAILBOX_LIMIT = 500
OFFER_LEASE = timedelta(seconds=60)
MAILBOX_EXPIRY = timedelta(hours=24)
MAILBOX_RETENTION = timedelta(days=7)
WAKE_ENTRIES_PER_FRAME = 50
ACKS_PER_CALL = 200
#: Owed room notices the upkeep retries in one pass over a tenant.
NOTICE_RETRIES_PER_PASS = 100

#: Rows the worker has still to settle; these keep the VM awake.
BUSY_STATES = ("pending", "offered", "accepted")
TERMINAL_STATES = (
    "admitted",
    "cancelled",
    "refused",
    "duplicate",
    "expired",
    "expired_uncertain",
)

MailboxOutcome = Literal[
    "journaled", "admitted", "duplicate", "refused", "held", "cancelled"
]

#: Outcome -> (states it moves a row from, state it moves the row to).
TRANSITIONS: dict[str, tuple[tuple[str, ...], str]] = {
    "journaled": (("pending", "offered"), "accepted"),
    "duplicate": (("pending", "offered"), "accepted"),
    "admitted": (
        ("pending", "offered", "accepted", "held", "cancel_requested"),
        "admitted",
    ),
    "refused": (("pending", "offered", "accepted"), "refused"),
    "held": (("pending", "offered", "accepted"), "held"),
    "cancelled": (("cancel_requested",), "cancelled"),
}


#: The notice for a tombstone the watcher answers `admitted`, by cancel reason.
STARTED_BEFORE = {"stopped": "started_before_stop", "expired": "started_before_expiry"}


class MailboxFull(Exception):
    """The agent already has `MAILBOX_LIMIT` rows waiting for its worker."""


def room_input_id(event: AgentEvent) -> str | None:
    """The watcher's `roomInputId` (`host/room-inbox.ts`): the key it dedupes a room input by.

    None for an event the watcher does not act on, which the mailbox does not
    hold either.
    """
    payload = event.payload.model_dump(mode="json")
    if event.type == "message":
        return payload["message_id"] if payload.get("addressed") is True else None
    if event.type == "room_join" and payload.get("listening") is not True:
        return None
    if event.type != "room_join" and not event.type.startswith("task_"):
        return None
    canonical = json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    return f"{event.type}:{hashlib.sha256(canonical.encode()).hexdigest()}"


@dataclass(frozen=True)
class MailboxEntry:
    """One addressed event as the mailbox holds it and a `wake` frame carries it."""

    room_id: str
    message_id: str
    thread_id: str | None
    event: dict[str, Any]
    origin: Literal["live", "cutover"]

    @classmethod
    def of(cls, event: AgentEvent) -> MailboxEntry | None:
        message_id = room_input_id(event)
        if message_id is None:
            return None
        payload = event.payload.model_dump(mode="json")
        thread_id = payload.get("thread_id")
        return cls(
            room_id=event.room_id,
            message_id=message_id,
            thread_id=thread_id if isinstance(thread_id, str) else None,
            event={"type": event.type, "payload": payload, "missed": None},
            origin="live",
        )

    @classmethod
    def of_row(cls, row: HostedWakeMailbox) -> MailboxEntry:
        return cls(
            room_id=row.room_id,
            message_id=row.message_id,
            thread_id=row.thread_id,
            event=row.event,
            origin="cutover" if row.origin == "cutover" else "live",
        )

    def wire(self) -> dict[str, Any]:
        return {
            "room_id": self.room_id,
            "message_id": self.message_id,
            "thread_id": self.thread_id,
            "event": self.event,
            "origin": self.origin,
        }


@dataclass(frozen=True)
class MailboxNotice:
    """A notice Core owes a room for a mailbox row, posted after the commit."""

    agent_id: str
    room_id: str
    message_id: str
    thread_id: str | None
    reason: str


@dataclass(frozen=True)
class StopSplit:
    """What an explicit Stop did to the mailbox."""

    cancelled: list[MailboxNotice]
    cancel_requested: list[tuple[str, str]]


@dataclass(frozen=True)
class AgentBacklog:
    agent_id: str
    waiting: int
    oldest: datetime | None
    refused: int


def by_room(
    notices: Sequence[MailboxNotice],
) -> list[tuple[MailboxNotice, list[str]]]:
    """Per (agent, room, reason): the latest row's notice, and every message it answers for."""
    groups: dict[tuple[str, str, str], tuple[MailboxNotice, list[str]]] = {}
    for notice in notices:
        key = (notice.agent_id, notice.room_id, notice.reason)
        messages = groups[key][1] if key in groups else []
        messages.append(notice.message_id)
        groups[key] = (notice, messages)
    return list(groups.values())


def one_per_room(notices: Sequence[MailboxNotice]) -> list[MailboxNotice]:
    """The latest row's notice per (agent, room, reason): one notice per room, in its thread."""
    return [notice for notice, _ in by_room(notices)]


def _notice(row: HostedWakeMailbox, reason: str) -> MailboxNotice:
    return MailboxNotice(
        agent_id=row.agent_id,
        room_id=row.room_id,
        message_id=row.message_id,
        thread_id=row.thread_id,
        reason=reason,
    )


def _notices(owed: Sequence[tuple[HostedWakeMailbox, str]]) -> list[MailboxNotice]:
    """Oldest first, so the latest row of a room is the same one on every retry."""
    return [
        _notice(row, reason)
        for row, reason in sorted(
            owed, key=lambda item: (item[0].addressed_at, item[0].message_id)
        )
    ]


class HostedMailboxStore:
    async def write(
        self,
        session: AsyncSession,
        *,
        agent_id: str,
        launch_id: str,
        entry: MailboxEntry,
        offered_to: str | None,
    ) -> bool:
        """Insert the row, already offered when a worker is there to take it.

        False when the row exists (a redelivered event). Raises `MailboxFull`
        at the limit. Serialised per launch by the launch lock the caller holds.
        """
        tenant_id = require_tenant_id()
        exists = await session.scalar(
            select(HostedWakeMailbox.state).where(
                HostedWakeMailbox.tenant_id == tenant_id,
                HostedWakeMailbox.agent_id == agent_id,
                HostedWakeMailbox.room_id == entry.room_id,
                HostedWakeMailbox.message_id == entry.message_id,
            )
        )
        if exists is not None:
            return False
        waiting = await session.scalar(
            select(func.count()).where(
                HostedWakeMailbox.tenant_id == tenant_id,
                HostedWakeMailbox.agent_id == agent_id,
                HostedWakeMailbox.state.in_(("pending", "offered")),
            )
        )
        if (waiting or 0) >= MAILBOX_LIMIT:
            raise MailboxFull(
                f"agent {agent_id} already has {waiting} mailbox rows waiting"
            )
        now = datetime.now(UTC)
        offered = offered_to is not None
        result = await session.execute(
            insert(HostedWakeMailbox)
            .values(
                tenant_id=tenant_id,
                agent_id=agent_id,
                room_id=entry.room_id,
                message_id=entry.message_id,
                launch_id=launch_id,
                thread_id=entry.thread_id,
                event=entry.event,
                state="offered" if offered else "pending",
                ever_offered=offered,
                offered_to=offered_to,
                offered_until=now + OFFER_LEASE if offered else None,
                origin=entry.origin,
                addressed_at=now,
                updated_at=now,
                expires_at=now + MAILBOX_EXPIRY,
            )
            .on_conflict_do_nothing()
            .returning(HostedWakeMailbox.message_id)
        )
        return result.scalar() is not None

    async def pending(
        self, session: AsyncSession, agent_id: str
    ) -> list[HostedWakeMailbox]:
        """The agent's `pending` rows, oldest first."""
        return list(
            await session.scalars(
                select(HostedWakeMailbox)
                .where(
                    HostedWakeMailbox.tenant_id == require_tenant_id(),
                    HostedWakeMailbox.agent_id == agent_id,
                    HostedWakeMailbox.state == "pending",
                )
                .order_by(HostedWakeMailbox.addressed_at, HostedWakeMailbox.room_id)
            )
        )

    async def mark_offered(
        self,
        session: AsyncSession,
        agent_id: str,
        keys: Sequence[tuple[str, str]],
        offered_to: str,
    ) -> set[tuple[str, str]]:
        """Offer the rows that are still `pending`; the keys that moved."""
        if not keys:
            return set()
        now = datetime.now(UTC)
        result = await session.execute(
            update(HostedWakeMailbox)
            .where(
                HostedWakeMailbox.tenant_id == require_tenant_id(),
                HostedWakeMailbox.agent_id == agent_id,
                tuple_(HostedWakeMailbox.room_id, HostedWakeMailbox.message_id).in_(
                    list(keys)
                ),
                HostedWakeMailbox.state == "pending",
            )
            .values(
                state="offered",
                ever_offered=True,
                offered_to=offered_to,
                offered_until=now + OFFER_LEASE,
                updated_at=now,
            )
            .returning(HostedWakeMailbox.room_id, HostedWakeMailbox.message_id)
            .execution_options(synchronize_session=False)
        )
        return {(row.room_id, row.message_id) for row in result}

    async def reclaim(
        self,
        session: AsyncSession,
        agent_id: str | None,
        live_offers: dict[str, str],
    ) -> int:
        """Return `offered` rows to `pending` unless their lease is held by a live stream.

        `live_offers` maps an agent to the offer key of its attached worker;
        a row offered to anything else (another Core boot, an older
        generation) or past its lease is reclaimed. `agent_id` narrows it to
        one agent.
        """
        now = datetime.now(UTC)
        conditions = [
            HostedWakeMailbox.tenant_id == require_tenant_id(),
            HostedWakeMailbox.state == "offered",
        ]
        if agent_id is not None:
            conditions.append(HostedWakeMailbox.agent_id == agent_id)
        held = [
            and_(
                HostedWakeMailbox.agent_id == agent,
                HostedWakeMailbox.offered_to == offer,
                HostedWakeMailbox.offered_until > now,
            )
            for agent, offer in live_offers.items()
        ]
        if held:
            conditions.append(~or_(*held))
        result = await session.execute(
            update(HostedWakeMailbox)
            .where(*conditions)
            .values(
                state="pending", offered_to=None, offered_until=None, updated_at=now
            )
            .execution_options(synchronize_session=False)
        )
        return int(getattr(result, "rowcount", 0) or 0)

    async def agents_with_pending(self, session: AsyncSession) -> list[str]:
        return list(
            await session.scalars(
                select(HostedWakeMailbox.agent_id)
                .where(
                    HostedWakeMailbox.tenant_id == require_tenant_id(),
                    HostedWakeMailbox.state == "pending",
                )
                .distinct()
            )
        )

    async def cancelled_entries(
        self, session: AsyncSession, agent_id: str
    ) -> list[dict[str, str]]:
        """Every tombstone the worker has still to answer, for `worker_attached`."""
        rows = await session.execute(
            select(
                HostedWakeMailbox.room_id,
                HostedWakeMailbox.message_id,
                HostedWakeMailbox.cancel_reason,
            )
            .where(
                HostedWakeMailbox.tenant_id == require_tenant_id(),
                HostedWakeMailbox.agent_id == agent_id,
                HostedWakeMailbox.state == "cancel_requested",
            )
            .order_by(HostedWakeMailbox.addressed_at)
        )
        return [
            {"room_id": room_id, "message_id": message_id, "reason": reason}
            for room_id, message_id, reason in rows
        ]

    async def busy(self, session: AsyncSession, launch_id: str) -> bool:
        """Whether a row of the launch waits for its worker (`held` and tombstones do not)."""
        return bool(
            await session.scalar(
                select(
                    select(HostedWakeMailbox.message_id)
                    .where(
                        HostedWakeMailbox.tenant_id == require_tenant_id(),
                        HostedWakeMailbox.launch_id == launch_id,
                        HostedWakeMailbox.state.in_(BUSY_STATES),
                    )
                    .exists()
                )
            )
        )

    async def stop(self, session: AsyncSession, launch_id: str) -> StopSplit:
        """An explicit Stop: definite cancels for rows never offered, tombstones for the rest."""
        tenant_id = require_tenant_id()
        now = datetime.now(UTC)
        cancelled = await session.scalars(
            update(HostedWakeMailbox)
            .where(
                HostedWakeMailbox.tenant_id == tenant_id,
                HostedWakeMailbox.launch_id == launch_id,
                HostedWakeMailbox.state == "pending",
                HostedWakeMailbox.ever_offered.is_(False),
            )
            .values(state="cancelled", notice_owed="stopped", updated_at=now)
            .returning(HostedWakeMailbox)
            .execution_options(synchronize_session=False)
        )
        notices = _notices([(row, "stopped") for row in cancelled])
        requested = await session.execute(
            update(HostedWakeMailbox)
            .where(
                HostedWakeMailbox.tenant_id == tenant_id,
                HostedWakeMailbox.launch_id == launch_id,
                HostedWakeMailbox.state.in_(("pending", "offered", "accepted", "held")),
            )
            .values(
                state="cancel_requested",
                cancel_reason="stopped",
                offered_to=None,
                offered_until=None,
                updated_at=now,
            )
            .returning(HostedWakeMailbox.room_id, HostedWakeMailbox.message_id)
            .execution_options(synchronize_session=False)
        )
        return StopSplit(
            cancelled=notices,
            cancel_requested=[(row.room_id, row.message_id) for row in requested],
        )

    async def ack(
        self,
        session: AsyncSession,
        agent_id: str,
        acks: Sequence[tuple[str, str, str]],
    ) -> tuple[dict[tuple[str, str], str], list[MailboxNotice]]:
        """Apply `(room, message, outcome)` acks; each row's state after, and the notices owed.

        An ack for a row at or past its target, or for no row at all, changes
        nothing and is not an error: acks are retried.
        """
        keys = list({(room, message) for room, message, _ in acks})
        rows = {
            (row.room_id, row.message_id): row
            for row in await session.scalars(
                select(HostedWakeMailbox)
                .where(
                    HostedWakeMailbox.tenant_id == require_tenant_id(),
                    HostedWakeMailbox.agent_id == agent_id,
                    tuple_(HostedWakeMailbox.room_id, HostedWakeMailbox.message_id).in_(
                        keys
                    ),
                )
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        }
        now = datetime.now(UTC)
        owed: list[tuple[HostedWakeMailbox, str]] = []
        for room, message, outcome in acks:
            row = rows.get((room, message))
            if row is None:
                continue
            sources, target = TRANSITIONS[outcome]
            if row.state not in sources:
                continue
            if row.state == "cancel_requested":
                reason = row.cancel_reason or "stopped"
                row.notice_owed = (
                    reason if target == "cancelled" else STARTED_BEFORE[reason]
                )
                owed.append((row, row.notice_owed))
            row.state = target
            row.offered_to = None
            row.offered_until = None
            row.updated_at = now
        return {key: row.state for key, row in rows.items()}, _notices(owed)

    async def expire(
        self, session: AsyncSession, now: datetime
    ) -> tuple[list[MailboxNotice], int]:
        """Settle rows 24 h old by state; the notices owed and the tombstones made.

        `cancel_requested` rows are never touched: a tombstone stays until the
        watcher answers it or the launch goes.
        """
        tenant_id = require_tenant_id()
        due = [
            HostedWakeMailbox.tenant_id == tenant_id,
            HostedWakeMailbox.expires_at <= now,
        ]
        never_offered = await session.scalars(
            update(HostedWakeMailbox)
            .where(
                *due,
                HostedWakeMailbox.state == "pending",
                HostedWakeMailbox.ever_offered.is_(False),
            )
            .values(state="expired", notice_owed="expired", updated_at=now)
            .returning(HostedWakeMailbox)
            .execution_options(synchronize_session=False)
        )
        owed = [(row, "expired") for row in never_offered]
        uncertain = await session.scalars(
            update(HostedWakeMailbox)
            .where(*due, HostedWakeMailbox.state.in_(("pending", "offered")))
            .values(
                state="expired_uncertain",
                notice_owed="expired_uncertain",
                offered_to=None,
                offered_until=None,
                updated_at=now,
            )
            .returning(HostedWakeMailbox)
            .execution_options(synchronize_session=False)
        )
        notices = _notices(owed + [(row, "expired_uncertain") for row in uncertain])
        tombstoned = await session.execute(
            update(HostedWakeMailbox)
            .where(*due, HostedWakeMailbox.state.in_(("accepted", "held")))
            .values(state="cancel_requested", cancel_reason="expired", updated_at=now)
            .execution_options(synchronize_session=False)
        )
        return notices, int(getattr(tombstoned, "rowcount", 0) or 0)

    async def owed_notices(
        self, session: AsyncSession, limit: int
    ) -> list[MailboxNotice]:
        """Room notices terminal moves owe and no one has posted yet, oldest first.

        Bounded to `limit` (agent, room, reason) groups, each whole, so a
        group's latest row is the one every retry posts for.
        """
        tenant_id = require_tenant_id()
        owed = (
            HostedWakeMailbox.tenant_id == tenant_id,
            HostedWakeMailbox.notice_owed.is_not(None),
        )
        groups = (
            select(
                HostedWakeMailbox.agent_id,
                HostedWakeMailbox.room_id,
                HostedWakeMailbox.notice_owed,
            )
            .where(*owed)
            .group_by(
                HostedWakeMailbox.agent_id,
                HostedWakeMailbox.room_id,
                HostedWakeMailbox.notice_owed,
            )
            .order_by(func.min(HostedWakeMailbox.addressed_at))
            .limit(limit)
            .subquery()
        )
        rows = await session.scalars(
            select(HostedWakeMailbox)
            .join(
                groups,
                and_(
                    HostedWakeMailbox.agent_id == groups.c.agent_id,
                    HostedWakeMailbox.room_id == groups.c.room_id,
                    HostedWakeMailbox.notice_owed == groups.c.notice_owed,
                ),
            )
            .where(*owed)
            .order_by(HostedWakeMailbox.addressed_at, HostedWakeMailbox.message_id)
        )
        return [
            _notice(row, row.notice_owed) for row in rows if row.notice_owed is not None
        ]

    async def notice_posted(
        self,
        session: AsyncSession,
        agent_id: str,
        room_id: str,
        reason: str,
        message_ids: Sequence[str],
    ) -> None:
        """The room has the notice these rows owed under `reason`; they owe nothing more."""
        await session.execute(
            update(HostedWakeMailbox)
            .where(
                HostedWakeMailbox.tenant_id == require_tenant_id(),
                HostedWakeMailbox.agent_id == agent_id,
                HostedWakeMailbox.room_id == room_id,
                HostedWakeMailbox.message_id.in_(list(message_ids)),
                HostedWakeMailbox.notice_owed == reason,
            )
            .values(notice_owed=None)
            .execution_options(synchronize_session=False)
        )

    async def prune(self, session: AsyncSession, now: datetime) -> int:
        result = await session.execute(
            delete(HostedWakeMailbox)
            .where(
                HostedWakeMailbox.tenant_id == require_tenant_id(),
                HostedWakeMailbox.state.in_(TERMINAL_STATES),
                HostedWakeMailbox.updated_at < now - MAILBOX_RETENTION,
            )
            .execution_options(synchronize_session=False)
        )
        return int(getattr(result, "rowcount", 0) or 0)

    async def delete_launch(self, session: AsyncSession, launch_id: str) -> None:
        """A removed launch's rows go with it, tombstones included, with no notice."""
        await session.execute(
            delete(HostedWakeMailbox)
            .where(
                HostedWakeMailbox.tenant_id == require_tenant_id(),
                HostedWakeMailbox.launch_id == launch_id,
            )
            .execution_options(synchronize_session=False)
        )

    async def backlog(
        self, session: AsyncSession, since: datetime
    ) -> list[AgentBacklog]:
        """Per agent: rows waiting, the oldest of them, and watcher refusals since `since`."""
        waiting = func.count().filter(
            HostedWakeMailbox.state.in_(("pending", "offered"))
        )
        oldest = func.min(HostedWakeMailbox.addressed_at).filter(
            HostedWakeMailbox.state.in_(("pending", "offered"))
        )
        refused = func.count().filter(
            HostedWakeMailbox.state == "refused",
            HostedWakeMailbox.updated_at >= since,
        )
        rows = await session.execute(
            select(HostedWakeMailbox.agent_id, waiting, oldest, refused)
            .where(HostedWakeMailbox.tenant_id == require_tenant_id())
            .group_by(HostedWakeMailbox.agent_id)
        )
        return [
            AgentBacklog(agent_id=agent, waiting=count, oldest=first, refused=no)
            for agent, count, first, no in rows
            if count or no
        ]
