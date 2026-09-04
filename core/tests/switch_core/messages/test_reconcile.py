"""Reconciliation reports the differences it is supposed to, and no others.

The whole value of this check is that its verdict can be trusted. So the tests
that matter most are the ones proving it does not cry drift over things that
are legitimately different — history predating the recorder, membership
changes that were never arrivals, arrivals predating the path that records
them — and the one proving it does not report a room it could not fully read
as clean.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from itertools import count

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


_seq = count(1)


def _row(
    room_id: str, event_id: str, sent_at: datetime, **overrides: object
) -> Message:
    """`seq` is assigned by MessageStore.create; these rows bypass it, so the
    helper numbers them. Reconciliation matches on event id and never reads
    `seq`, so only distinctness matters here."""
    fields: dict[str, object] = {
        "seq": next(_seq),
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


def _join_row(room_id: str, event_id: str, sent_at: datetime) -> Message:
    return _row(
        room_id,
        event_id,
        sent_at,
        event_type="m.room.member",
        msgtype=None,
        body=None,
        content={"membership": "join"},
    )


def _join_event(event_id: str, at: datetime, **overrides: object) -> InboundMembership:
    fields: dict[str, object] = {
        "room_id": "!room:test",
        "event_id": event_id,
        "sender": "@agent:test",
        "timestamp": _ms(at),
        "content": {"membership": "join"},
        "state_key": "@agent:test",
        "membership": "join",
        "prev_membership": "invite",
    }
    fields.update(overrides)
    return InboundMembership(**fields)  # type: ignore[arg-type]


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
                        InboundMembership(
                            room_id="!room:test",
                            event_id="$join",
                            sender="@someone:test",
                            timestamp=_ms(now + timedelta(seconds=1)),
                            state_key="@someone:test",
                            membership="join",
                        ),
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
        assert report.ignored_by_type == {
            "m.room.member (before arrivals were recorded)": 1
        }

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


class TestTheWindowBoundary:
    """The oldest recorded message is the one most likely to be misjudged.

    Its row is written after its send is accepted, so the row's `sent_at` is
    always a little later than the event's own timestamp. A window that began
    at the row would exclude the event that produced it, and every room would
    report its first message as drift for as long as it existed.
    """

    async def test_the_first_recorded_message_is_not_reported_as_drift(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        sent = datetime.now(UTC)
        recorded_at = sent + timedelta(milliseconds=40)
        async with session_factory() as session:
            room = await _make_room(session)
            session.add(_row(room.id, "$first", recorded_at))
            await session.commit()
            room_id = room.id

        transport = PagingTransport(
            [HistoryPage(events=[_event("$first", sent)], next_token=None)]
        )

        async with session_factory() as session:
            room = await session.get(Room, room_id)  # type: ignore[assignment]
            report = await reconcile_room(transport, session, room)  # type: ignore[arg-type]

        assert report.clean
        assert report.agreed == 1
        assert report.anchored

    async def test_history_before_the_anchor_is_still_left_alone(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Admitting the anchor from before the window must not admit its
        neighbours: the walk stops at it, it does not step over it."""
        sent = datetime.now(UTC)
        async with session_factory() as session:
            room = await _make_room(session)
            session.add(_row(room.id, "$first", sent + timedelta(milliseconds=40)))
            await session.commit()
            room_id = room.id

        transport = PagingTransport(
            [
                HistoryPage(
                    events=[
                        _event("$first", sent),
                        _event("$older", sent - timedelta(seconds=1)),
                    ],
                    next_token=None,
                )
            ]
        )

        async with session_factory() as session:
            room = await session.get(Room, room_id)  # type: ignore[assignment]
            report = await reconcile_room(transport, session, room)  # type: ignore[arg-type]

        assert report.clean
        assert report.missing_rows == []

    async def test_an_anchor_the_bus_has_lost_is_declared_not_hidden(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        now = datetime.now(UTC)
        async with session_factory() as session:
            room = await _make_room(session)
            session.add(_row(room.id, "$gone", now))
            await session.commit()
            room_id = room.id

        transport = PagingTransport(
            [HistoryPage(events=[_event("$other", now)], next_token=None)]
        )

        async with session_factory() as session:
            room = await session.get(Room, room_id)  # type: ignore[assignment]
            report = await reconcile_room(transport, session, room)  # type: ignore[arg-type]

        assert not report.anchored
        assert "WINDOW UNANCHORED" in report.summary()


class TestArrivalsAndRowsWithNothingToCompareAgainst:
    """Arrivals are compared from the point the log holds one; the categories
    the bus walk still discards have no counterpart by construction, and
    calling those "recorded but never sent" would report the same rows as
    drift on every run."""

    async def test_an_arrival_the_bus_agrees_with_is_checked_not_skipped(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Recording arrivals is the newest write path there is, so leaving it
        out of the check made the least proven part the unchecked part."""
        now = datetime.now(UTC)
        async with session_factory() as session:
            room = await _make_room(session)
            session.add(_row(room.id, "$a", now))
            session.add(_join_row(room.id, "$join", now + timedelta(seconds=2)))
            await session.commit()
            room_id = room.id

        transport = PagingTransport(
            [
                HistoryPage(
                    events=[
                        _join_event("$join", now + timedelta(seconds=1)),
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
        assert report.unverifiable_by_type == {}

    async def test_an_arrival_the_log_missed_is_drift(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        now = datetime.now(UTC)
        async with session_factory() as session:
            room = await _make_room(session)
            session.add(_row(room.id, "$a", now))
            session.add(_join_row(room.id, "$join", now + timedelta(seconds=2)))
            await session.commit()
            room_id = room.id

        transport = PagingTransport(
            [
                HistoryPage(
                    events=[
                        _join_event("$later", now + timedelta(seconds=3)),
                        _join_event("$join", now + timedelta(seconds=1)),
                        _event("$a", now),
                    ],
                    next_token=None,
                )
            ]
        )

        async with session_factory() as session:
            room = await session.get(Room, room_id)  # type: ignore[assignment]
            report = await reconcile_room(transport, session, room)  # type: ignore[arg-type]

        assert report.missing_rows == ["$later"]

    async def test_an_arrival_older_than_the_log_is_counted_not_reported(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Every room was joined long before arrivals were recorded, so a join
        from before the log's first one cannot have a row."""
        now = datetime.now(UTC)
        async with session_factory() as session:
            room = await _make_room(session)
            session.add(_row(room.id, "$a", now))
            session.add(_join_row(room.id, "$join", now + timedelta(seconds=3)))
            await session.commit()
            room_id = room.id

        transport = PagingTransport(
            [
                HistoryPage(
                    events=[
                        _join_event("$join", now + timedelta(seconds=2)),
                        _join_event("$ancient", now + timedelta(seconds=1)),
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
        assert report.ignored_by_type == {
            "m.room.member (before arrivals were recorded)": 1
        }

    async def test_a_leave_is_never_compared(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        now = datetime.now(UTC)
        async with session_factory() as session:
            room = await _make_room(session)
            session.add(_row(room.id, "$a", now))
            session.add(_join_row(room.id, "$join", now + timedelta(seconds=2)))
            await session.commit()
            room_id = room.id

        transport = PagingTransport(
            [
                HistoryPage(
                    events=[
                        _join_event(
                            "$leave",
                            now + timedelta(seconds=3),
                            membership="leave",
                            prev_membership="join",
                        ),
                        _join_event("$join", now + timedelta(seconds=1)),
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
        assert report.ignored_by_type == {"m.room.member": 1}

    async def test_a_row_written_before_its_type_was_denied_is_not_drift(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """These exist on real deployments: the recorder kept every type before
        the log was scoped, and those rows outlive the change."""
        now = datetime.now(UTC)
        async with session_factory() as session:
            room = await _make_room(session)
            session.add(_row(room.id, "$a", now))
            session.add(
                _row(
                    room.id,
                    "$legacy",
                    now + timedelta(seconds=1),
                    event_type="com.switch.agent.runtime_state",
                    msgtype=None,
                    body=None,
                    content={"state": "busy"},
                )
            )
            await session.commit()
            room_id = room.id

        transport = PagingTransport(
            [HistoryPage(events=[_event("$a", now)], next_token=None)]
        )

        async with session_factory() as session:
            room = await session.get(Room, room_id)  # type: ignore[assignment]
            report = await reconcile_room(transport, session, room)  # type: ignore[arg-type]

        assert report.clean
        assert report.unverifiable_by_type == {"com.switch.agent.runtime_state": 1}


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
                        InboundCustomEvent(
                            room_id="!room:test",
                            event_id="$state",
                            sender="@agent:test",
                            timestamp=_ms(now + timedelta(seconds=1)),
                            content={"state": "busy"},
                            event_type="com.switch.agent.runtime_state",
                        ),
                        _event("$msg", now),
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
            # Oldest first, so `seq` runs the same way the recorder assigns it:
            # the anchor is the room's first message, not its last.
            for n in (2, 1, 0):
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
        forever.

        The anchor is deliberately absent from the bus, since a walk that finds
        it stops there and never reaches a second page.
        """
        now = datetime.now(UTC)
        async with session_factory() as session:
            room = await _make_room(session)
            session.add(_row(room.id, "$vanished", now))
            await session.commit()
            room_id = room.id

        transport = PagingTransport(
            [
                HistoryPage(events=[], next_token="stuck"),
                HistoryPage(events=[], next_token="stuck"),
            ]
        )

        async with session_factory() as session:
            room = await session.get(Room, room_id)  # type: ignore[assignment]
            report = await reconcile_room(transport, session, room)  # type: ignore[arg-type]

        assert transport.reads == 2
        assert not report.anchored
