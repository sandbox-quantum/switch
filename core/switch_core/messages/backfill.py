"""Reconstructs a room's history from the bus into the message log.

Recording began when the recorder was deployed. Everything a room said before
that is on the message bus and nowhere else — which did not matter while the
read path went to the bus too, and matters a great deal now that it does not.
On the first deployment to record and then read, that was 731 of 739 bridged
messages: still on the homeserver, invisible to every agent.

This walks a room backwards and writes the messages it finds that have no row.

**Reconstructed rows are numbered below zero.** `seq` orders the room, so a
message from last month cannot take a number above one from this morning, and
it cannot take a number among the live rows either — those are taken, and
renumbering to make room would move every cursor pointing at them. Counting
down from zero keeps the order right, keeps `(room_id, seq)` unique, and makes
the sign say something worth being able to read off a row: positive was
recorded as it happened, negative was reconstructed afterwards. Delivery
cursors start at 0, so none of this is pushed at anybody.

**It is idempotent, and that is not incidental.** A backfill over a busy room
is long, and the useful thing to do with a walk that failed halfway is to run
it again. `transport_event_id` is unique, so every row this would write is
either absent or already correct; the walk checks before writing and the
constraint is the backstop.

**What it does not reconstruct.** Only what the log is scoped to keep — see
`recorded_types` — so bus traffic that was never part of the conversation
stays out, exactly as it does going forward. Arrivals are reconstructed:
membership is on the bus and the timeline reads wrong without them. Sender
display names come from the event where the bus carried one and are otherwise
null, which is what the read path already tolerates.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from switch_core.db.models import Message, MessageAttachment
from switch_core.db.stores.message_store import MessageStore
from switch_core.messages.recorded_types import MEMBERSHIP_EVENT_TYPE, should_record
from switch_core.transport import (
    InboundCustomEvent,
    InboundEvent,
    InboundMedia,
    InboundMembership,
    InboundMessage,
)

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.db.models import Room
    from switch_core.transport import MessageTransport

logger = logging.getLogger(__name__)

# One page of backwards history, matching the reconciliation walk so a backfill
# puts no unusual shape of load on the homeserver.
PAGE_SIZE = 100

# A stop for a walk that would otherwise never end. Reached only if the
# homeserver keeps handing out pages with a cursor that advances forever; a
# room that ends returns no next token and stops on its own.
MAX_PAGES = 10_000


@dataclass
class BackfillReport:
    room_id: str
    matrix_room_id: str
    room_name: str
    pages_read: int = 0
    seen: int = 0
    written: int = 0
    already_present: int = 0
    skipped_by_type: dict[str, int] = field(default_factory=dict)
    # True when the walk stopped because it ran out of pages rather than
    # because the room ended. The room is then partially reconstructed, and
    # saying so matters more than the count does.
    incomplete: bool = False

    def summary(self) -> str:
        line = (
            f"{self.room_name} ({self.matrix_room_id}): {self.written} written, "
            f"{self.already_present} already recorded, {self.seen} seen "
            f"over {self.pages_read} pages"
        )
        if self.skipped_by_type:
            counts = ", ".join(
                f"{name}={count}"
                for name, count in sorted(self.skipped_by_type.items())
            )
            line += f"; not part of the log: {counts}"
        if self.incomplete:
            line += "; INCOMPLETE — hit the page limit before the room ended"
        return line


async def backfill_room(
    transport: MessageTransport,
    session_factory: async_sessionmaker[AsyncSession],
    room: Room,
    *,
    store: MessageStore,
) -> BackfillReport:
    """Walk one room to its start, writing every message with no row.

    The transport must already be connected and a member of the room.

    Each page is its own transaction. A walk that fails partway therefore
    leaves the pages it finished written rather than rolling back an hour of
    work, and re-running picks up where it stopped — which is the behaviour
    that makes a long backfill practical rather than something to be afraid of.
    """
    report = BackfillReport(
        room_id=room.id,
        matrix_room_id=room.matrix_room_id,
        room_name=room.name,
    )
    start: str | None = None
    while report.pages_read < MAX_PAGES:
        page = await transport.read_history(
            room.matrix_room_id, start=start, limit=PAGE_SIZE
        )
        report.pages_read += 1

        # Newest first, which is how history comes back, and the direction the
        # numbering has to run: each row written takes the next position below
        # the last, so walking from the newest unrecorded message towards the
        # room's start leaves the oldest message with the lowest number. Any
        # other order would number the room backwards.
        for raw in page.events:
            await _consider(raw, session_factory, room, store, report)

        end = page.next_token
        if not end or end == start:
            return report
        start = end

    report.incomplete = True
    logger.warning(
        "Backfill of %s stopped at the %d page limit; the room is only "
        "partially reconstructed",
        room.matrix_room_id,
        MAX_PAGES,
    )
    return report


async def _consider(
    raw: object,
    session_factory: async_sessionmaker[AsyncSession],
    room: Room,
    store: MessageStore,
    report: BackfillReport,
) -> None:
    """Write one bus event as a message row, if it belongs in the log."""
    if not isinstance(raw, InboundEvent):
        report.skipped_by_type["unrecognised"] = (
            report.skipped_by_type.get("unrecognised", 0) + 1
        )
        return

    event_type = _event_type(raw)
    if event_type is None or not should_record(event_type):
        name = event_type or type(raw).__name__
        report.skipped_by_type[name] = report.skipped_by_type.get(name, 0) + 1
        return

    report.seen += 1
    async with session_factory() as session:
        existing = await store.get_by_transport_event_id(session, raw.event_id)
        if existing is not None:
            report.already_present += 1
            return
        message, attachments = _row_for(raw, room.id, event_type)
        await store.create_historical(session, message, attachments)
        await session.commit()
    report.written += 1


def _event_type(raw: InboundEvent) -> str | None:
    """The log's name for this event, or None if it has no place in the log."""
    if isinstance(raw, InboundMembership):
        # Only an arrival. A leave is not part of the timeline the log keeps,
        # and recording one would put a row in history with nothing to say.
        return MEMBERSHIP_EVENT_TYPE if raw.membership == "join" else None
    if isinstance(raw, InboundCustomEvent):
        return raw.event_type
    if isinstance(raw, InboundMessage):
        return "m.room.message"
    return None


def _row_for(
    raw: InboundEvent, room_id: str, event_type: str
) -> tuple[Message, list[MessageAttachment]]:
    """Build the row and its files from a bus event.

    `sender_client_id` is left null. It is the Switch client that did the
    sending, and the bus records an mxid rather than a client id; resolving it
    would be a lookup per row for a column nothing reads. `sender_name` comes
    from the event where the bus carried one.
    """
    content = dict(raw.content)
    message = Message(
        room_id=room_id,
        transport_event_id=raw.event_id,
        sender_matrix_id=raw.sender,
        sender_client_id=None,
        sender_name=_sender_name(raw, content),
        event_type=event_type,
        msgtype=getattr(raw, "msgtype", None),
        body=_body(raw),
        formatted_body=content.get("formatted_body"),
        thread_root_event_id=getattr(raw, "thread_root_id", None),
        content=content,
        sent_at=datetime.fromtimestamp(raw.timestamp / 1000, tz=UTC),
    )
    return message, _attachments(raw, content)


def _sender_name(raw: InboundEvent, content: dict) -> str | None:
    if isinstance(raw, InboundMembership):
        return raw.display_name
    name = content.get("sender_name")
    return str(name) if name else None


def _body(raw: InboundEvent) -> str | None:
    # An arrival carries no body: how it reads is the reader's to phrase, and
    # a rendered sentence in the log would freeze today's wording into every
    # row ever written. Matches what the live recorder does.
    if isinstance(raw, InboundMembership):
        return None
    return getattr(raw, "body", None)


def _attachments(raw: InboundEvent, content: dict) -> list[MessageAttachment]:
    """The files on this event, which on the bus is at most one.

    Matrix has no multi-attachment event, so a send of several files is
    several events sharing a group key. Reconstructing them as one row would
    mean holding a page's worth of parts and guessing which belong together;
    they are written as they were sent instead, and the group key survives in
    `content` for anyone who wants to coalesce them later.
    """
    if not isinstance(raw, InboundMedia):
        return []
    info = content.get("info") or {}
    size = info.get("size") if isinstance(info, dict) else None
    return [
        MessageAttachment(
            uri=raw.uri,
            filename=content.get("filename") or raw.body,
            mimetype=info.get("mimetype") if isinstance(info, dict) else None,
            size=int(size) if isinstance(size, int) else None,
        )
    ]


__all__ = ["BackfillReport", "backfill_room"]
