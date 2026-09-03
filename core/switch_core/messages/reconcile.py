"""Compares what the message bus holds for a room against what was recorded.

Recording happens after a send is accepted and cannot fail it, so a database
problem leaves a row missing for a message that really was delivered. That is
a deliberate trade, and this is how the cost of it is measured: before the
read path moves onto these rows, the two records have to be shown to agree on
a real room, not on fakes.

**Only the window where recording was active is compared.** Rows exist from
the moment the recorder was deployed; every message older than that is
legitimately absent, and reporting a room's entire back-catalogue as missing
would bury the one row that actually went astray. The window therefore starts
at the oldest recorded message unless the caller names an earlier point, and
every report says which window it covered.

Events the bus replays that a send never produced — membership changes and
the like — are counted by type rather than dropped, so a category nobody
thought about shows up as unclassified instead of as agreement.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, cast

from sqlalchemy import func, select

from switch_core.db.models import Message
from switch_core.transport import (
    InboundCustomEvent,
    InboundEvent,
    InboundMedia,
    InboundMessage,
)

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from switch_core.db.models import Room
    from switch_core.transport import MessageTransport

# One page of backwards history. Matches the size the read path already uses,
# so a reconciliation walk puts no unusual shape of load on the homeserver.
PAGE_SIZE = 100


@dataclass(frozen=True)
class Mismatch:
    """One field that disagrees between the bus and the recorded row."""

    event_id: str
    field_name: str
    on_the_bus: object
    recorded: object

    def describe(self) -> str:
        return (
            f"{self.event_id} {self.field_name}: "
            f"bus={self.on_the_bus!r} recorded={self.recorded!r}"
        )


@dataclass(frozen=True)
class RoomReconciliation:
    room_id: str
    matrix_room_id: str
    room_name: str
    # The window compared. None means the room had no recorded messages at
    # all, so there was nothing to compare rather than nothing wrong.
    since: datetime | None
    compared: int = 0
    agreed: int = 0
    missing_rows: list[str] = field(default_factory=list)
    unsent_rows: list[str] = field(default_factory=list)
    mismatches: list[Mismatch] = field(default_factory=list)
    ignored_by_type: dict[str, int] = field(default_factory=dict)

    @property
    def compared_nothing(self) -> bool:
        return self.since is None

    @property
    def clean(self) -> bool:
        return not (self.missing_rows or self.unsent_rows or self.mismatches)

    def summary(self) -> str:
        where = f"{self.room_name} ({self.matrix_room_id})"
        if self.since is None:
            return f"{where}: no recorded messages, nothing to compare"
        verdict = "clean" if self.clean else "DRIFT"
        return (
            f"{where}: {verdict} — {self.agreed}/{self.compared} agreed, "
            f"{len(self.missing_rows)} missing, {len(self.unsent_rows)} unsent, "
            f"{len(self.mismatches)} mismatched (since {self.since.isoformat()})"
        )


async def reconcile_room(
    transport: MessageTransport,
    session: AsyncSession,
    room: Room,
    *,
    since: datetime | None = None,
) -> RoomReconciliation:
    """Compare one room. `since` overrides the recorded-from cutoff.

    The transport must already be connected and a member of the room.
    """
    window_start = since or await _oldest_recorded(session, room.id)
    if window_start is None:
        return RoomReconciliation(
            room_id=room.id,
            matrix_room_id=room.matrix_room_id,
            room_name=room.name,
            since=None,
        )

    on_the_bus, ignored = await _read_back_to(
        transport, room.matrix_room_id, _to_ms(window_start)
    )
    recorded = await _recorded_since(session, room.id, window_start)

    agreed = 0
    missing_rows: list[str] = []
    mismatches: list[Mismatch] = []
    for event_id, event in on_the_bus.items():
        row = recorded.get(event_id)
        if row is None:
            missing_rows.append(event_id)
            continue
        found = _compare(event_id, event, row)
        if found:
            mismatches.extend(found)
        else:
            agreed += 1

    return RoomReconciliation(
        room_id=room.id,
        matrix_room_id=room.matrix_room_id,
        room_name=room.name,
        since=window_start,
        compared=len(on_the_bus),
        agreed=agreed,
        missing_rows=missing_rows,
        unsent_rows=[e for e in recorded if e not in on_the_bus],
        mismatches=mismatches,
        ignored_by_type=ignored,
    )


def _to_ms(moment: datetime) -> int:
    return int(moment.timestamp() * 1000)


async def _oldest_recorded(session: AsyncSession, room_id: str) -> datetime | None:
    """When recording began for this room.

    `Message.sent_at` is a timestamptz the models annotate as `str` — the
    established convention across every model in this package. The value is a
    datetime, hence the cast.
    """
    result = await session.execute(
        select(func.min(Message.sent_at)).where(Message.room_id == room_id)
    )
    return cast("datetime | None", result.scalar_one_or_none())


async def _recorded_since(
    session: AsyncSession, room_id: str, since: datetime
) -> dict[str, Message]:
    result = await session.execute(
        select(Message)
        .where(Message.room_id == room_id, Message.sent_at >= since)
        .order_by(Message.seq)
    )
    return {row.transport_event_id: row for row in result.scalars().all()}


async def _read_back_to(
    transport: MessageTransport, matrix_room_id: str, since_ms: int
) -> tuple[dict[str, InboundEvent], dict[str, int]]:
    """Page backwards until the window is covered.

    Unbounded on purpose, unlike the read path: a reconciliation that gave up
    after a page budget would report the events it never looked at as
    agreeing, which is the one answer it must never give.
    """
    events: dict[str, InboundEvent] = {}
    ignored: dict[str, int] = {}
    start: str | None = None
    while True:
        page = await transport.read_history(
            matrix_room_id, start=start, limit=PAGE_SIZE
        )
        reached_window_start = False
        for raw in page.events:
            if not isinstance(raw, InboundEvent):
                ignored["unrecognised"] = ignored.get("unrecognised", 0) + 1
                continue
            if raw.timestamp < since_ms:
                reached_window_start = True
                continue
            if isinstance(raw, InboundMessage | InboundCustomEvent):
                events[raw.event_id] = raw
            else:
                name = type(raw).__name__
                ignored[name] = ignored.get(name, 0) + 1
        if reached_window_start:
            break
        end = page.next_token
        if not end or end == start:
            break
        start = end
    return events, ignored


def _compare(event_id: str, event: InboundEvent, row: Message) -> list[Mismatch]:
    """Compare the fields a reader will depend on once the read path moves.

    Not the whole content dict: the bus is free to hand back an event
    annotated with fields it added itself, and reporting those as drift would
    train everyone to ignore the report.
    """
    expected: list[tuple[str, object, object]] = [
        ("sender", event.sender, row.sender_matrix_id),
    ]
    if isinstance(event, InboundCustomEvent):
        expected.append(("event_type", event.event_type, row.event_type))
        expected.append(("thread_root", event.thread_root_id, row.thread_root_event_id))
    elif isinstance(event, InboundMessage):
        expected.append(("event_type", "m.room.message", row.event_type))
        expected.append(("body", event.body, row.body))
        expected.append(("msgtype", event.msgtype, row.msgtype))
        expected.append(("thread_root", event.thread_root_id, row.thread_root_event_id))
        if isinstance(event, InboundMedia):
            expected.append(("uri", event.uri, row.content.get("url")))

    return [
        Mismatch(
            event_id=event_id,
            field_name=name,
            on_the_bus=on_the_bus,
            recorded=recorded,
        )
        for name, on_the_bus, recorded in expected
        if on_the_bus != recorded
    ]
