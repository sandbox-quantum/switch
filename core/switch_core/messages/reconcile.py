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

**The window's floor is an event id, not a moment.** A row's `sent_at` is when
it was written, and writing happens after the send is accepted, so the bus
event for the very first recorded message is always a little older than the
row that describes it. A timestamp cutoff therefore excludes that event from
the bus side while including its row on the recorded side, and the oldest
message in every room reports as drift for as long as the room exists. Paging
back to the oldest row's own event id instead makes the boundary exact and
takes both clocks out of it. The timestamp survives only as a backstop, so a
room whose anchor event is gone from the bus terminates instead of walking to
the beginning of time — and says so rather than reporting the difference as
drift it cannot explain.

Events the bus replays that a send never produced — membership changes and
the like — are counted by type rather than dropped, so a category nobody
thought about shows up as unclassified instead of as agreement. Custom event
types the recorder deliberately does not keep are counted the same way, under
their own type name: they are absent by design, and calling that drift would
make the report worthless.

**Both sides apply that filter, not just the bus side.** A row of a type the
bus walk discards has nothing to be compared against, so measuring it against
an empty set reports it as recorded-but-never-sent every run, forever. Two
kinds exist: arrivals, which are recorded but were never a send, and rows for
types written before they were denied. Neither is drift. They are counted
under `unverifiable_by_type` — disclosed as outside the check rather than
quietly dropped from it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, cast

from sqlalchemy import select

from switch_core.db.models import Message
from switch_core.messages.recorded_types import MEMBERSHIP_EVENT_TYPE, should_record
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

# How far past the window the walk may go looking for the anchor event before
# giving up. Only reached when the anchor is not on the bus at all; generous
# because the cost of overshooting is a few extra pages, and the cost of
# stopping early is a report that cannot tell drift from a short walk.
ANCHOR_SEARCH_SLACK = timedelta(hours=1)


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
    # Rows of a type the bus walk does not collect, so nothing could be
    # compared against them. Not drift, but not checked either.
    unverifiable_by_type: dict[str, int] = field(default_factory=dict)
    # Whether the walk reached the oldest recorded row's own event. False means
    # the boundary fell back to a timestamp, so the edge of the window is
    # approximate and a difference there may be an artefact of the walk.
    anchored: bool = True

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
        line = (
            f"{where}: {verdict} — {self.agreed}/{self.compared} agreed, "
            f"{len(self.missing_rows)} missing, {len(self.unsent_rows)} unsent, "
            f"{len(self.mismatches)} mismatched (since {self.since.isoformat()})"
        )
        if self.unverifiable_by_type:
            skipped = sum(self.unverifiable_by_type.values())
            line += f"; {skipped} rows not checkable against the bus"
        if not self.anchored:
            line += "; WINDOW UNANCHORED — oldest recorded event not found on the bus"
        return line


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
    anchor = await _oldest_recorded(session, room.id)
    # `Message.sent_at` is a timestamptz the models annotate as `str` — the
    # established convention across every model in this package.
    recorded_from = cast("datetime | None", anchor.sent_at) if anchor else None
    window_start = since or recorded_from
    if window_start is None:
        return RoomReconciliation(
            room_id=room.id,
            matrix_room_id=room.matrix_room_id,
            room_name=room.name,
            since=None,
        )

    # An explicit `since` is the caller overriding the boundary, so the anchor
    # only applies when the window is the recorded one.
    anchor_event_id = anchor.transport_event_id if anchor and since is None else None
    on_the_bus, ignored, anchored = await _read_back_to(
        transport,
        room.matrix_room_id,
        anchor_event_id=anchor_event_id,
        floor_ms=_to_ms(window_start - ANCHOR_SEARCH_SLACK),
        window_start_ms=_to_ms(window_start),
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

    unsent_rows: list[str] = []
    unverifiable: dict[str, int] = {}
    for event_id, row in recorded.items():
        if event_id in on_the_bus:
            continue
        if _comparable(row):
            unsent_rows.append(event_id)
        else:
            unverifiable[row.event_type] = unverifiable.get(row.event_type, 0) + 1

    return RoomReconciliation(
        room_id=room.id,
        matrix_room_id=room.matrix_room_id,
        room_name=room.name,
        since=window_start,
        compared=len(on_the_bus),
        agreed=agreed,
        missing_rows=missing_rows,
        unsent_rows=unsent_rows,
        mismatches=mismatches,
        ignored_by_type=ignored,
        unverifiable_by_type=unverifiable,
        anchored=anchored,
    )


def _comparable(row: Message) -> bool:
    """Whether the bus walk would have collected this row's event.

    An arrival is recorded but was never a send, and a row written before its
    type was denied has a bus event the walk now discards. Measuring either
    against the collected set says "recorded, never sent" every single run.
    """
    if row.event_type == MEMBERSHIP_EVENT_TYPE:
        return False
    return should_record(row.event_type)


def _to_ms(moment: datetime) -> int:
    return int(moment.timestamp() * 1000)


async def _oldest_recorded(session: AsyncSession, room_id: str) -> Message | None:
    """The row recording began with, which anchors the window.

    Ordered by `seq` rather than `sent_at`: within a room `seq` is a total
    order with no ties, so "the first row" is a fact rather than whichever of
    two equal timestamps the planner returned first.
    """
    result = await session.execute(
        select(Message).where(Message.room_id == room_id).order_by(Message.seq).limit(1)
    )
    return result.scalars().first()


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
    transport: MessageTransport,
    matrix_room_id: str,
    *,
    anchor_event_id: str | None,
    floor_ms: int,
    window_start_ms: int,
) -> tuple[dict[str, InboundEvent], dict[str, int], bool]:
    """Page backwards until the window is covered.

    Stops on `anchor_event_id` — the oldest recorded row's own event — which
    puts the boundary on an identity rather than on two clocks that disagree
    by however long a write takes. `floor_ms` only ends a walk that never
    finds it, and the third return value says which of the two happened.

    Unbounded within those limits on purpose, unlike the read path: a
    reconciliation that gave up after a page budget would report the events it
    never looked at as agreeing, which is the one answer it must never give.
    """
    events: dict[str, InboundEvent] = {}
    ignored: dict[str, int] = {}
    start: str | None = None
    anchored = False
    done = False
    while not done:
        page = await transport.read_history(
            matrix_room_id, start=start, limit=PAGE_SIZE
        )
        for raw in page.events:
            if not isinstance(raw, InboundEvent):
                ignored["unrecognised"] = ignored.get("unrecognised", 0) + 1
                continue
            # History comes back newest first, so reaching either limit is the
            # end of the walk rather than an event to skip past.
            if raw.timestamp < floor_ms:
                done = True
                break
            is_anchor = raw.event_id == anchor_event_id
            # The anchor is the one event admitted from before the window: its
            # row's `sent_at` is by construction later than it.
            if raw.timestamp >= window_start_ms or is_anchor:
                _classify(raw, events, ignored)
            elif anchor_event_id is None:
                done = True
                break
            if is_anchor:
                anchored = True
                done = True
                break
        if done:
            break
        end = page.next_token
        if not end or end == start:
            break
        start = end
    return events, ignored, anchored or anchor_event_id is None


def _classify(
    raw: InboundEvent, events: dict[str, InboundEvent], ignored: dict[str, int]
) -> None:
    """Sort one bus event into the comparison set or the ignored tally."""
    if isinstance(raw, InboundCustomEvent) and not should_record(raw.event_type):
        ignored[raw.event_type] = ignored.get(raw.event_type, 0) + 1
    elif isinstance(raw, InboundMessage | InboundCustomEvent):
        events[raw.event_id] = raw
    else:
        name = type(raw).__name__
        ignored[name] = ignored.get(name, 0) + 1


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
