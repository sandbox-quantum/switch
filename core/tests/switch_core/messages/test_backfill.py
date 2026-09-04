"""Reconstructed history lands in the right order, below the live log.

The two properties that matter most are the ones a careless implementation
gets wrong in ways nobody notices for weeks: the numbering must run the same
way time does, and running the walk twice must not double the room.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.cli.backfill import _ReadOnlyStore
from switch_core.db.models import Message, Room
from switch_core.db.stores.message_store import MessageStore
from switch_core.messages import backfill_room
from switch_core.transport import (
    HistoryPage,
    InboundCustomEvent,
    InboundMedia,
    InboundMembership,
    InboundMessage,
)

BASE = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)


class PagingTransport:
    """Replays fixed pages of backwards history, newest first."""

    def __init__(self, pages: list[HistoryPage]) -> None:
        self._pages = pages
        self.reads = 0

    async def read_history(
        self, room_id: str, *, start: str | None, limit: int
    ) -> HistoryPage:
        page = self._pages[min(self.reads, len(self._pages) - 1)]
        self.reads += 1
        return page


def _at(seconds: int) -> datetime:
    return BASE + timedelta(seconds=seconds)


def _ms(seconds: int) -> int:
    return int(_at(seconds).timestamp() * 1000)


def _event(event_id: str, at: int, body: str = "hello", **overrides: object):  # type: ignore[no-untyped-def]
    fields: dict[str, object] = {
        "room_id": "!room:test",
        "event_id": event_id,
        "sender": "@a:test",
        "timestamp": _ms(at),
        "content": {"body": body, "sender_name": "Alice"},
        "body": body,
        "msgtype": "m.text",
    }
    fields.update(overrides)
    return InboundMessage(**fields)  # type: ignore[arg-type]


async def _make_room(session: AsyncSession) -> Room:
    room = Room(
        matrix_room_id=f"!room-{uuid.uuid4().hex[:8]}:test",
        name="a room",
        description="",
    )
    session.add(room)
    await session.commit()
    return room


async def _rows(
    session_factory: async_sessionmaker[AsyncSession], room_id: str
) -> list[Message]:
    async with session_factory() as session:
        result = await session.execute(
            select(Message).where(Message.room_id == room_id).order_by(Message.seq)
        )
        return list(result.scalars().all())


class TestNumbering:
    async def test_history_is_numbered_below_the_live_log(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A message from before recording must not outrank one from after it.

        Ordering is by `seq`, so a positive number on reconstructed history
        would put last month at the top of every read.
        """
        store = MessageStore()
        async with session_factory() as session:
            room = await _make_room(session)
            live = Message(
                room_id=room.id,
                transport_event_id="$live",
                sender_matrix_id="@a:test",
                event_type="m.room.message",
                msgtype="m.text",
                body="today",
                content={},
                sent_at=_at(100),
            )
            await store.create(session, live, [])
            await session.commit()

        transport = PagingTransport(
            [HistoryPage(events=[_event("$old", 10, "yesterday")], next_token=None)]
        )
        async with session_factory() as session:
            room = await session.get(Room, room.id)  # type: ignore[assignment]
            await backfill_room(transport, session_factory, room, store=store)

        rows = await _rows(session_factory, room.id)
        assert [(r.seq, r.body) for r in rows] == [(-1, "yesterday"), (1, "today")]

    async def test_the_oldest_message_gets_the_lowest_number(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Numbering has to run the same way time does, across pages as well as
        within them — a walk that numbered per page would interleave."""
        store = MessageStore()
        async with session_factory() as session:
            room = await _make_room(session)

        transport = PagingTransport(
            [
                HistoryPage(
                    events=[_event("$d", 40, "d"), _event("$c", 30, "c")],
                    next_token="t1",
                ),
                HistoryPage(
                    events=[_event("$b", 20, "b"), _event("$a", 10, "a")],
                    next_token=None,
                ),
            ]
        )
        async with session_factory() as session:
            room = await session.get(Room, room.id)  # type: ignore[assignment]
            await backfill_room(transport, session_factory, room, store=store)

        rows = await _rows(session_factory, room.id)
        assert [r.body for r in rows] == ["a", "b", "c", "d"]
        assert [r.seq for r in rows] == [-4, -3, -2, -1]

    async def test_the_timestamp_is_when_it_was_sent_not_when_it_was_written(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The read path filters on `sent_at`. Stamping the backfill's own
        clock would pile a year of history onto tonight."""
        store = MessageStore()
        async with session_factory() as session:
            room = await _make_room(session)

        transport = PagingTransport(
            [HistoryPage(events=[_event("$a", 10)], next_token=None)]
        )
        async with session_factory() as session:
            room = await session.get(Room, room.id)  # type: ignore[assignment]
            await backfill_room(transport, session_factory, room, store=store)

        rows = await _rows(session_factory, room.id)
        assert rows[0].sent_at == _at(10)


class TestCompletionMark:
    """A room is marked done only by a walk that really wrote it.

    The mark is what stops a re-run re-reading every page of every room. It is
    also what a dry run must not leave behind: the documented first step is a
    dry run, and if that marked every room, the real run afterwards would find
    nothing to do and say so as though the work were finished.
    """

    async def test_a_completed_walk_marks_the_room(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room = await _make_room(session)

        transport = PagingTransport(
            [HistoryPage(events=[_event("$a", 10, "a")], next_token=None)]
        )
        async with session_factory() as session:
            room = await session.get(Room, room.id)  # type: ignore[assignment]
            await backfill_room(transport, session_factory, room, store=MessageStore())

        async with session_factory() as session:
            written = await session.get(Room, room.id)
            assert written is not None
            assert written.history_backfilled_at is not None

    async def test_a_dry_run_marks_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Otherwise the dry run disables the real one, silently."""
        async with session_factory() as session:
            room = await _make_room(session)

        transport = PagingTransport(
            [HistoryPage(events=[_event("$a", 10, "a")], next_token=None)]
        )
        async with session_factory() as session:
            room = await session.get(Room, room.id)  # type: ignore[assignment]
            report = await backfill_room(
                transport, session_factory, room, store=_ReadOnlyStore()
            )

        assert report.written == 1
        async with session_factory() as session:
            untouched = await session.get(Room, room.id)
            assert untouched is not None
            assert untouched.history_backfilled_at is None
            assert await _rows(session_factory, room.id) == []


class TestIdempotence:
    async def test_running_it_twice_writes_nothing_the_second_time(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A long walk that fails halfway should be safe to just run again."""
        store = MessageStore()
        async with session_factory() as session:
            room = await _make_room(session)

        def _transport() -> PagingTransport:
            return PagingTransport(
                [
                    HistoryPage(
                        events=[_event("$b", 20, "b"), _event("$a", 10, "a")],
                        next_token=None,
                    )
                ]
            )

        async with session_factory() as session:
            room = await session.get(Room, room.id)  # type: ignore[assignment]
            first = await backfill_room(
                _transport(), session_factory, room, store=store
            )
            second = await backfill_room(
                _transport(), session_factory, room, store=store
            )

        assert (first.written, first.already_present) == (2, 0)
        assert (second.written, second.already_present) == (0, 2)
        assert len(await _rows(session_factory, room.id)) == 2

    async def test_a_message_already_recorded_live_is_left_alone(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The walk overlaps the recorded window by design — it starts at the
        newest message on the bus, not at the oldest row."""
        store = MessageStore()
        async with session_factory() as session:
            room = await _make_room(session)
            live = Message(
                room_id=room.id,
                transport_event_id="$b",
                sender_matrix_id="@a:test",
                event_type="m.room.message",
                msgtype="m.text",
                body="b",
                content={},
                sent_at=_at(20),
            )
            await store.create(session, live, [])
            await session.commit()

        transport = PagingTransport(
            [
                HistoryPage(
                    events=[_event("$b", 20, "b"), _event("$a", 10, "a")],
                    next_token=None,
                )
            ]
        )
        async with session_factory() as session:
            room = await session.get(Room, room.id)  # type: ignore[assignment]
            report = await backfill_room(transport, session_factory, room, store=store)

        assert (report.written, report.already_present) == (1, 1)
        rows = await _rows(session_factory, room.id)
        assert [(r.seq, r.body) for r in rows] == [(-1, "a"), (1, "b")]


class TestWhatBelongsInTheLog:
    async def test_bus_traffic_the_log_does_not_keep_is_skipped(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The same scoping as the live recorder, or the backfill would put
        back exactly what scoping the log took out."""
        store = MessageStore()
        async with session_factory() as session:
            room = await _make_room(session)

        transport = PagingTransport(
            [
                HistoryPage(
                    events=[
                        _event("$msg", 20),
                        InboundCustomEvent(
                            room_id="!room:test",
                            event_id="$state",
                            sender="@a:test",
                            timestamp=_ms(10),
                            content={"state": "busy"},
                            event_type="com.switch.agent.runtime_state",
                        ),
                    ],
                    next_token=None,
                )
            ]
        )
        async with session_factory() as session:
            room = await session.get(Room, room.id)  # type: ignore[assignment]
            report = await backfill_room(transport, session_factory, room, store=store)

        assert report.written == 1
        assert report.skipped_by_type == {"com.switch.agent.runtime_state": 1}

    async def test_an_arrival_is_reconstructed_with_no_body(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The timeline reads wrong without arrivals, and the sentence stays
        the reader's to phrase — same as the live path."""
        store = MessageStore()
        async with session_factory() as session:
            room = await _make_room(session)

        transport = PagingTransport(
            [
                HistoryPage(
                    events=[
                        InboundMembership(
                            room_id="!room:test",
                            event_id="$join",
                            sender="@bob:test",
                            timestamp=_ms(10),
                            state_key="@bob:test",
                            membership="join",
                            display_name="Bob",
                        )
                    ],
                    next_token=None,
                )
            ]
        )
        async with session_factory() as session:
            room = await session.get(Room, room.id)  # type: ignore[assignment]
            await backfill_room(transport, session_factory, room, store=store)

        rows = await _rows(session_factory, room.id)
        assert rows[0].event_type == "m.room.member"
        assert rows[0].body is None
        assert rows[0].sender_name == "Bob"

    async def test_a_departure_is_not_history_worth_keeping(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = MessageStore()
        async with session_factory() as session:
            room = await _make_room(session)

        transport = PagingTransport(
            [
                HistoryPage(
                    events=[
                        InboundMembership(
                            room_id="!room:test",
                            event_id="$leave",
                            sender="@bob:test",
                            timestamp=_ms(10),
                            state_key="@bob:test",
                            membership="leave",
                        )
                    ],
                    next_token=None,
                )
            ]
        )
        async with session_factory() as session:
            room = await session.get(Room, room.id)  # type: ignore[assignment]
            report = await backfill_room(transport, session_factory, room, store=store)

        assert report.written == 0
        assert await _rows(session_factory, room.id) == []

    async def test_a_file_comes_back_with_its_attachment_row(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = MessageStore()
        async with session_factory() as session:
            room = await _make_room(session)

        transport = PagingTransport(
            [
                HistoryPage(
                    events=[
                        InboundMedia(
                            room_id="!room:test",
                            event_id="$img",
                            sender="@a:test",
                            timestamp=_ms(10),
                            content={
                                "info": {"mimetype": "image/png", "size": 42},
                                "body": "chart.png",
                            },
                            body="chart.png",
                            msgtype="m.image",
                            uri="mxc://s/abc",
                        )
                    ],
                    next_token=None,
                )
            ]
        )
        async with session_factory() as session:
            room = await session.get(Room, room.id)  # type: ignore[assignment]
            await backfill_room(transport, session_factory, room, store=store)

        rows = await _rows(session_factory, room.id)
        async with session_factory() as session:
            attachments = await store.attachments_for(session, [rows[0].id])
        [attachment] = attachments[rows[0].id]
        assert (attachment.uri, attachment.filename) == ("mxc://s/abc", "chart.png")
        assert (attachment.mimetype, attachment.size) == ("image/png", 42)


class TestStopping:
    async def test_a_cursor_that_does_not_advance_stops_the_walk(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A homeserver that keeps returning the token it was given would
        otherwise walk forever."""
        store = MessageStore()
        async with session_factory() as session:
            room = await _make_room(session)

        transport = PagingTransport(
            [HistoryPage(events=[_event("$a", 10)], next_token="stuck")]
        )
        async with session_factory() as session:
            room = await session.get(Room, room.id)  # type: ignore[assignment]
            report = await backfill_room(transport, session_factory, room, store=store)

        assert transport.reads == 2
        assert report.written == 1
