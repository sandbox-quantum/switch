"""Reconciliation reports the differences it is supposed to, and no others.

The whole value of this check is that its verdict can be trusted. So the tests
that matter most are the ones proving it does not cry drift over things that
are legitimately different — history predating the recorder, membership events
that were never sends — and the one proving it does not report a room it could
not fully read as clean.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Message, Room
from switch_core.messages import reconcile_room
from switch_core.transport import (
    HistoryPage,
    InboundCustomEvent,
    InboundMedia,
    InboundMembership,
    InboundMessage,
)


class PagingTransport:
    """Replays fixed pages of backwards history, newest first."""

    def __init__(self, pages: list[HistoryPage]) -> None:
        self._pages = pages
        self.reads = 0

    async def read_history(
        self, room_id: str, *, start: str | None, limit: int
    ) -> HistoryPage:
        page = self._pages[self.reads]
        self.reads += 1
        return page


def _ms(moment: datetime) -> int:
    return int(moment.timestamp() * 1000)


async def _make_room(session: AsyncSession) -> Room:
    room = Room(
        matrix_room_id=f"!room-{uuid.uuid4().hex[:8]}:test",
        name="a room",
        description="",
    )
    session.add(room)
    await session.flush()
    return room


def _row(
    room_id: str, event_id: str, sent_at: datetime, **overrides: object
) -> Message:
    fields: dict[str, object] = {
        "room_id": room_id,
        "transport_event_id": event_id,
        "sender_matrix_id": "@agent:test",
        "sender_name": "agent one",
        "event_type": "m.room.message",
        "msgtype": "m.text",
        "body": "hello",
        "content": {"msgtype": "m.text", "body": "hello"},
        "sent_at": sent_at,
    }
    fields.update(overrides)
    return Message(**fields)


def _event(event_id: str, at: datetime, **overrides: object) -> InboundMessage:
    fields: dict[str, object] = {
        "room_id": "!room:test",
        "event_id": event_id,
        "sender": "@agent:test",
        "timestamp": _ms(at),
        "content": {},
        "body": "hello",
        "msgtype": "m.text",
    }
    fields.update(overrides)
    return InboundMessage(**fields)  # type: ignore[arg-type]


class TestAgreement:
    async def test_a_room_whose_records_match_is_clean(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        now = datetime.now(UTC)
        async with session_factory() as session:
            room = await _make_room(session)
            session.add(_row(room.id, "$a", now))
            session.add(_row(room.id, "$b", now + timedelta(seconds=1)))
            await session.commit()
            room_id = room.id

        transport = PagingTransport(
            [
                HistoryPage(
                    events=[
                        _event("$b", now + timedelta(seconds=1)),
                        _event("$a", now),
                    ],
                    next_token=None,
                )
            ]
        )

        async with session_factory() as session:
            room = await session.get(Room, room_id)  # type: ignore[assignment]
            report = await reconcile_room(transport, session, room)  # type: ignore[arg-type]

        assert report.clean
        assert report.compared == 2
        assert report.agreed == 2

    async def test_history_older_than_the_recorder_is_not_reported_missing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The room existed before recording started. Reporting its whole
        back-catalogue as drift would bury the row that really went astray."""
        now = datetime.now(UTC)
        recording_began = now - timedelta(minutes=5)
        async with session_factory() as session:
            room = await _make_room(session)
            session.add(_row(room.id, "$new", recording_began))
            await session.commit()
            room_id = room.id

        transport = PagingTransport(
            [
                HistoryPage(
                    events=[
                        _event("$new", recording_began),
                        _event("$ancient", now - timedelta(days=30)),
                        _event("$older-still", now - timedelta(days=60)),
                    ],
                    next_token=None,
                )
            ]
        )

        async with session_factory() as session:
            room = await session.get(Room, room_id)  # type: ignore[assignment]
            report = await reconcile_room(transport, session, room)  # type: ignore[arg-type]

        assert report.clean
        assert report.compared == 1
        assert report.missing_rows == []

    async def test_events_that_were_never_sends_are_counted_not_flagged(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        now = datetime.now(UTC)
        async with session_factory() as session:
            room = await _make_room(session)
            session.add(_row(room.id, "$a", now))
            await session.commit()
            room_id = room.id

        transport = PagingTransport(
            [
                HistoryPage(
                    events=[
                        _event("$a", now),
                        InboundMembership(
                            room_id="!room:test",
                            event_id="$join",
                            sender="@someone:test",
                            timestamp=_ms(now),
                            state_key="@someone:test",
                            membership="join",
                        ),
                    ],
                    next_token=None,
                )
            ]
        )

        async with session_factory() as session:
            room = await session.get(Room, room_id)  # type: ignore[assignment]
            report = await reconcile_room(transport, session, room)  # type: ignore[arg-type]

        assert report.clean
        assert report.ignored_by_type == {"InboundMembership": 1}

    async def test_a_room_with_nothing_recorded_reports_that_plainly(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Not the same as agreeing, and not the same as total drift."""
        async with session_factory() as session:
            room = await _make_room(session)
            await session.commit()
            room_id = room.id

        transport = PagingTransport([])

        async with session_factory() as session:
            room = await session.get(Room, room_id)  # type: ignore[assignment]
            report = await reconcile_room(transport, session, room)  # type: ignore[arg-type]

        assert report.compared_nothing
        assert transport.reads == 0
        assert "nothing to compare" in report.summary()


class TestDrift:
    async def test_a_delivered_message_with_no_row_is_reported(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The failure mode recording was designed to tolerate: the send
        succeeded and the write after it did not."""
        now = datetime.now(UTC)
        async with session_factory() as session:
            room = await _make_room(session)
            session.add(_row(room.id, "$a", now))
            await session.commit()
            room_id = room.id

        transport = PagingTransport(
            [
                HistoryPage(
                    events=[
                        _event("$lost", now + timedelta(seconds=1)),
                        _event("$a", now),
                    ],
                    next_token=None,
                )
            ]
        )

        async with session_factory() as session:
            room = await session.get(Room, room_id)  # type: ignore[assignment]
            report = await reconcile_room(transport, session, room)  # type: ignore[arg-type]

        assert not report.clean
        assert report.missing_rows == ["$lost"]
        assert "DRIFT" in report.summary()

    async def test_a_row_the_bus_does_not_have_is_reported(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        now = datetime.now(UTC)
        async with session_factory() as session:
            room = await _make_room(session)
            session.add(_row(room.id, "$a", now))
            session.add(_row(room.id, "$phantom", now))
            await session.commit()
            room_id = room.id

        transport = PagingTransport(
            [HistoryPage(events=[_event("$a", now)], next_token=None)]
        )

        async with session_factory() as session:
            room = await session.get(Room, room_id)  # type: ignore[assignment]
            report = await reconcile_room(transport, session, room)  # type: ignore[arg-type]

        assert report.unsent_rows == ["$phantom"]

    async def test_a_field_that_disagrees_is_named(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        now = datetime.now(UTC)
        async with session_factory() as session:
            room = await _make_room(session)
            session.add(_row(room.id, "$a", now, body="what was recorded"))
            await session.commit()
            room_id = room.id

        transport = PagingTransport(
            [
                HistoryPage(
                    events=[_event("$a", now, body="what the bus holds")],
                    next_token=None,
                )
            ]
        )

        async with session_factory() as session:
            room = await session.get(Room, room_id)  # type: ignore[assignment]
            report = await reconcile_room(transport, session, room)  # type: ignore[arg-type]

        assert [m.field_name for m in report.mismatches] == ["body"]
        assert "what the bus holds" in report.mismatches[0].describe()
        assert report.agreed == 0

    async def test_a_custom_event_is_compared_on_its_type(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        now = datetime.now(UTC)
        async with session_factory() as session:
            room = await _make_room(session)
            session.add(
                _row(
                    room.id,
                    "$cmd",
                    now,
                    event_type="com.switch.command",
                    msgtype=None,
                    body=None,
                    content={"command": "reset"},
                )
            )
            await session.commit()
            room_id = room.id

        transport = PagingTransport(
            [
                HistoryPage(
                    events=[
                        InboundCustomEvent(
                            room_id="!room:test",
                            event_id="$cmd",
                            sender="@agent:test",
                            timestamp=_ms(now),
                            content={"command": "reset"},
                            event_type="com.switch.command",
                        )
                    ],
                    next_token=None,
                )
            ]
        )

        async with session_factory() as session:
            room = await session.get(Room, room_id)  # type: ignore[assignment]
            report = await reconcile_room(transport, session, room)  # type: ignore[arg-type]

        assert report.clean
        assert report.agreed == 1

    async def test_a_media_event_is_compared_on_its_uri(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        now = datetime.now(UTC)
        async with session_factory() as session:
            room = await _make_room(session)
            session.add(
                _row(
                    room.id,
                    "$img",
                    now,
                    msgtype="m.image",
                    body="chart.png",
                    content={
                        "msgtype": "m.image",
                        "body": "chart.png",
                        "url": "mxc://a",
                    },
                )
            )
            await session.commit()
            room_id = room.id

        transport = PagingTransport(
            [
                HistoryPage(
                    events=[
                        InboundMedia(
                            room_id="!room:test",
                            event_id="$img",
                            sender="@agent:test",
                            timestamp=_ms(now),
                            content={},
                            body="chart.png",
                            msgtype="m.image",
                            uri="mxc://somewhere-else",
                        )
                    ],
                    next_token=None,
                )
            ]
        )

        async with session_factory() as session:
            room = await session.get(Room, room_id)  # type: ignore[assignment]
            report = await reconcile_room(transport, session, room)  # type: ignore[arg-type]

        assert [m.field_name for m in report.mismatches] == ["uri"]

    async def test_an_event_the_recorder_does_not_keep_is_counted_not_reported(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Bus traffic is absent by design. Reporting it as a missing row would
        drown the one row that really went astray."""
        now = datetime.now(UTC)
        async with session_factory() as session:
            room = await _make_room(session)
            session.add(_row(room.id, "$msg", now))
            await session.commit()
            room_id = room.id

        transport = PagingTransport(
            [
                HistoryPage(
                    events=[
                        _event("$msg", now),
                        InboundCustomEvent(
                            room_id="!room:test",
                            event_id="$state",
                            sender="@agent:test",
                            timestamp=_ms(now),
                            content={"state": "busy"},
                            event_type="com.switch.agent.runtime_state",
                        ),
                    ],
                    next_token=None,
                )
            ]
        )

        async with session_factory() as session:
            room = await session.get(Room, room_id)  # type: ignore[assignment]
            report = await reconcile_room(transport, session, room)  # type: ignore[arg-type]

        assert report.clean
        assert report.compared == 1
        assert report.ignored_by_type == {"com.switch.agent.runtime_state": 1}


class TestPaging:
    async def test_it_keeps_paging_until_the_window_is_covered(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The read path gives up after a page budget. This must not: an event
        it never looked at would otherwise be reported as agreeing."""
        now = datetime.now(UTC)
        async with session_factory() as session:
            room = await _make_room(session)
            for n in range(3):
                session.add(_row(room.id, f"$p{n}", now - timedelta(minutes=n)))
            await session.commit()
            room_id = room.id

        transport = PagingTransport(
            [
                HistoryPage(events=[_event("$p0", now)], next_token="t1"),
                HistoryPage(
                    events=[_event("$p1", now - timedelta(minutes=1))],
                    next_token="t2",
                ),
                HistoryPage(
                    events=[_event("$p2", now - timedelta(minutes=2))],
                    next_token=None,
                ),
            ]
        )

        async with session_factory() as session:
            room = await session.get(Room, room_id)  # type: ignore[assignment]
            report = await reconcile_room(transport, session, room)  # type: ignore[arg-type]

        assert transport.reads == 3
        assert report.compared == 3
        assert report.clean

    async def test_it_stops_at_a_token_that_does_not_advance(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A server that returns the cursor it was given would otherwise loop
        forever."""
        now = datetime.now(UTC)
        async with session_factory() as session:
            room = await _make_room(session)
            session.add(_row(room.id, "$a", now))
            await session.commit()
            room_id = room.id

        transport = PagingTransport(
            [
                HistoryPage(events=[_event("$a", now)], next_token="stuck"),
                HistoryPage(events=[], next_token="stuck"),
            ]
        )

        async with session_factory() as session:
            room = await session.get(Room, room_id)  # type: ignore[assignment]
            report = await reconcile_room(transport, session, room)  # type: ignore[arg-type]

        assert transport.reads == 2
        assert report.clean
