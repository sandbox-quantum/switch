"""read_context, now that history comes from the message log.

The homeserver page-walk is gone, and with it the seek budget, the read budget
and the per-thread root refetch. What replaces them is a single windowed query,
so these tests write rows and read them back rather than feeding pages to a
fake transport.

Two behaviours are worth naming because they changed rather than moved:
`truncated` is exact — the query asks for one row more than the caller wanted
and reports whether it exists — and an arrival is stored with no body, so the
sentence a reader sees is composed here and can be reworded without rewriting
history.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.attachments import ATTACHMENT_GROUP_KEY
from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.db.models import Client, Message, MessageAttachment, Room
from switch_core.db.stores.message_store import MessageStore

BASE = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)


def _at(seconds: int) -> datetime:
    return BASE + timedelta(seconds=seconds)


def _ms(seconds: int) -> int:
    return int(_at(seconds).timestamp() * 1000)


async def _make_room(session: AsyncSession) -> tuple[str, str]:
    """Insert the Room and Client a recorded row depends on."""
    suffix = uuid.uuid4().hex[:8]
    client = Client(
        matrix_user_id=f"@agent-{suffix}:test",
        display_name="agent one",
        type="agent",
        password="x",
    )
    session.add(client)
    await session.flush()
    room = Room(
        matrix_room_id=f"!room-{suffix}:test",
        name="a room",
        description="",
    )
    session.add(room)
    await session.flush()
    return room.id, client.id


async def _write(
    session: AsyncSession,
    room_id: str,
    client_id: str,
    event_id: str,
    *,
    body: str | None = "hello",
    at: int = 0,
    sender: str = "@alice:s",
    sender_name: str | None = "Alice",
    thread_root: str | None = None,
    event_type: str = "m.room.message",
    msgtype: str | None = "m.text",
    attachments: list[MessageAttachment] | None = None,
    content: dict[str, object] | None = None,
) -> Message:
    message = Message(
        room_id=room_id,
        transport_event_id=event_id,
        sender_matrix_id=sender,
        sender_client_id=client_id,
        sender_name=sender_name,
        event_type=event_type,
        msgtype=msgtype,
        body=body,
        formatted_body=None,
        thread_root_event_id=thread_root,
        content=content if content is not None else ({"body": body} if body else {}),
        sent_at=_at(at),
    )
    return await MessageStore().create(session, message, attachments or [])


def _service(session_factory: async_sessionmaker[AsyncSession]) -> ProtocolService:
    async def _require(agent_id: str, room_id: str):
        return SimpleNamespace(id=room_id)

    svc = object.__new__(ProtocolService)
    svc.connections = ConnectionRegistry()
    svc.session_factory = session_factory
    svc.message_store = MessageStore()
    svc.require_room_member = _require  # type: ignore[assignment]
    return svc


class TestEntries:
    async def test_a_message_is_its_own_thread(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room_id, client_id = await _make_room(session)
            await _write(session, room_id, client_id, "$txt", body="hello")
            await session.commit()

        result = await _service(session_factory).read_context("agent-1", room_id)

        assert len(result["threads"]) == 1
        root = result["threads"][0]["root"]
        assert root["id"] == "$txt"
        assert root["kind"] == "message"
        assert root["body"] == "hello"
        assert root["sender"] == "@alice:s"
        assert root["sender_name"] == "Alice"
        assert root["timestamp"] == _ms(0)
        assert root["attachments"] == []

    async def test_a_file_comes_back_with_the_message(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room_id, client_id = await _make_room(session)
            await _write(
                session,
                room_id,
                client_id,
                "$img",
                body="what's this?",
                msgtype="m.image",
                attachments=[
                    MessageAttachment(
                        uri="mxc://s/abc",
                        filename="cat.png",
                        mimetype="image/png",
                        size=1234,
                        position=0,
                    )
                ],
            )
            await session.commit()

        result = await _service(session_factory).read_context("agent-1", room_id)

        assert result["threads"][0]["root"]["attachments"] == [
            {
                "filename": "cat.png",
                "mimetype": "image/png",
                "size": 1234,
                "mxc": "mxc://s/abc",
                "msgtype": "m.image",
            }
        ]

    async def test_several_files_come_back_on_one_message(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """In the order they were sent, which is what `position` records."""
        async with session_factory() as session:
            room_id, client_id = await _make_room(session)
            await _write(
                session,
                room_id,
                client_id,
                "$multi",
                body="two files",
                msgtype="m.file",
                attachments=[
                    MessageAttachment(uri="mxc://s/one", filename="one.pdf"),
                    MessageAttachment(uri="mxc://s/two", filename="two.pdf"),
                ],
            )
            await session.commit()

        result = await _service(session_factory).read_context("agent-1", room_id)

        names = [a["filename"] for a in result["threads"][0]["root"]["attachments"]]
        assert names == ["one.pdf", "two.pdf"]

    async def test_a_multi_file_message_is_reassembled_from_its_parts(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The bus has no event that carries two files, so a two-file message
        is two events sharing a group marker and two rows. History has to put
        them back together the way a live receiver does — otherwise it reads as
        two messages, the second captioned with a filename."""
        async with session_factory() as session:
            room_id, client_id = await _make_room(session)
            for index, (event_id, body, name) in enumerate(
                [("$part0", "two files", "one.pdf"), ("$part1", "two.pdf", "two.pdf")]
            ):
                await _write(
                    session,
                    room_id,
                    client_id,
                    event_id,
                    body=body,
                    at=index,
                    msgtype="m.file",
                    attachments=[
                        MessageAttachment(uri=f"mxc://s/{name}", filename=name)
                    ],
                    content={
                        "body": body,
                        ATTACHMENT_GROUP_KEY: {"id": "g1", "index": index, "total": 2},
                    },
                )
            await session.commit()

        result = await _service(session_factory).read_context("agent-1", room_id)

        assert len(result["threads"]) == 1
        root = result["threads"][0]["root"]
        assert root["id"] == "$part0"
        assert root["body"] == "two files"
        assert [a["filename"] for a in root["attachments"]] == ["one.pdf", "two.pdf"]

    async def test_a_group_cut_off_by_the_window_returns_what_is_there(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A page ending mid-group shows the parts it read rather than dropping
        them: the lowest index present leads."""
        async with session_factory() as session:
            room_id, client_id = await _make_room(session)
            await _write(
                session,
                room_id,
                client_id,
                "$part1",
                body="two.pdf",
                at=1,
                msgtype="m.file",
                attachments=[MessageAttachment(uri="mxc://s/two", filename="two.pdf")],
                content={
                    "body": "two.pdf",
                    ATTACHMENT_GROUP_KEY: {"id": "g1", "index": 1, "total": 2},
                },
            )
            await session.commit()

        result = await _service(session_factory).read_context("agent-1", room_id)

        root = result["threads"][0]["root"]
        assert root["id"] == "$part1"
        assert [a["filename"] for a in root["attachments"]] == ["two.pdf"]

    async def test_an_arrival_is_labelled_and_phrased_on_read(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The row holds no sentence; this is where one is composed."""
        async with session_factory() as session:
            room_id, client_id = await _make_room(session)
            await _write(
                session,
                room_id,
                client_id,
                "$join",
                body=None,
                msgtype=None,
                event_type="m.room.member",
                sender="@bob:s",
                sender_name="Bob",
            )
            await session.commit()

        result = await _service(session_factory).read_context("agent-1", room_id)

        root = result["threads"][0]["root"]
        assert root["kind"] == "room_join"
        assert root["body"] == "Bob joined the room"
        assert root["sender"] == "@bob:s"

    async def test_an_unnamed_sender_falls_back_to_their_address(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room_id, client_id = await _make_room(session)
            await _write(
                session, room_id, client_id, "$anon", sender_name=None, sender="@x:s"
            )
            await session.commit()

        result = await _service(session_factory).read_context("agent-1", room_id)

        assert result["threads"][0]["root"]["sender_name"] == "@x:s"


class TestTruncation:
    """`truncated` is now exact rather than conservative.

    The old walk could not tell "the page cap stopped me" from "the room ended
    there", so it reported truncated whenever it ended on the limit. One extra
    row answers the question outright.
    """

    async def test_a_room_shorter_than_the_limit_is_not_truncated(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room_id, client_id = await _make_room(session)
            for n in range(3):
                await _write(session, room_id, client_id, f"$m{n}", at=n)
            await session.commit()

        result = await _service(session_factory).read_context(
            "agent-1", room_id, limit=10
        )

        assert result["truncated"] is False
        assert len(result["threads"]) == 3

    async def test_a_room_exactly_the_limit_is_not_truncated(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The case the old walk had to guess at, and always guessed wrong."""
        async with session_factory() as session:
            room_id, client_id = await _make_room(session)
            for n in range(3):
                await _write(session, room_id, client_id, f"$m{n}", at=n)
            await session.commit()

        result = await _service(session_factory).read_context(
            "agent-1", room_id, limit=3
        )

        assert result["truncated"] is False
        assert len(result["threads"]) == 3

    async def test_older_history_beyond_the_limit_is_reported(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room_id, client_id = await _make_room(session)
            for n in range(5):
                await _write(session, room_id, client_id, f"$m{n}", at=n)
            await session.commit()

        result = await _service(session_factory).read_context(
            "agent-1", room_id, limit=3
        )

        assert result["truncated"] is True
        assert len(result["threads"]) == 3

    async def test_the_newest_entries_are_the_ones_kept(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room_id, client_id = await _make_room(session)
            for n in range(5):
                await _write(session, room_id, client_id, f"$m{n}", at=n)
            await session.commit()

        result = await _service(session_factory).read_context(
            "agent-1", room_id, limit=2
        )

        assert [t["root"]["id"] for t in result["threads"]] == ["$m3", "$m4"]
        assert result["oldest_timestamp"] == _ms(3)

    async def test_an_empty_room_reads_as_empty_not_truncated(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room_id, _ = await _make_room(session)
            await session.commit()

        result = await _service(session_factory).read_context("agent-1", room_id)

        assert result == {
            "threads": [],
            "truncated": False,
            "oldest_timestamp": None,
        }


class TestWindowing:
    async def test_before_excludes_the_boundary(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room_id, client_id = await _make_room(session)
            for n in range(4):
                await _write(session, room_id, client_id, f"$m{n}", at=n)
            await session.commit()

        result = await _service(session_factory).read_context(
            "agent-1", room_id, before_ms=_ms(2)
        )

        assert [t["root"]["id"] for t in result["threads"]] == ["$m0", "$m1"]

    async def test_since_includes_the_boundary(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room_id, client_id = await _make_room(session)
            for n in range(4):
                await _write(session, room_id, client_id, f"$m{n}", at=n)
            await session.commit()

        result = await _service(session_factory).read_context(
            "agent-1", room_id, since_ms=_ms(2)
        )

        assert [t["root"]["id"] for t in result["threads"]] == ["$m2", "$m3"]

    async def test_a_window_far_from_the_present_costs_one_query(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The old path had to page over everything newer to arrive here, and
        gave up loudly when the seek budget ran out."""
        async with session_factory() as session:
            room_id, client_id = await _make_room(session)
            for n in range(200):
                await _write(session, room_id, client_id, f"$m{n}", at=n)
            await session.commit()

        result = await _service(session_factory).read_context(
            "agent-1", room_id, limit=2, since_ms=_ms(3), before_ms=_ms(6)
        )

        assert [t["root"]["id"] for t in result["threads"]] == ["$m4", "$m5"]
        assert result["truncated"] is True

    async def test_other_rooms_are_not_visible(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room_id, client_id = await _make_room(session)
            other_id, other_client = await _make_room(session)
            await _write(session, room_id, client_id, "$mine")
            await _write(session, other_id, other_client, "$theirs")
            await session.commit()

        result = await _service(session_factory).read_context("agent-1", room_id)

        assert [t["root"]["id"] for t in result["threads"]] == ["$mine"]


class TestThreads:
    async def test_replies_group_under_their_root_oldest_first(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room_id, client_id = await _make_room(session)
            await _write(session, room_id, client_id, "$root", body="q", at=0)
            await _write(
                session, room_id, client_id, "$r1", body="a", at=1, thread_root="$root"
            )
            await _write(
                session, room_id, client_id, "$r2", body="b", at=2, thread_root="$root"
            )
            await session.commit()

        result = await _service(session_factory).read_context("agent-1", room_id)

        assert len(result["threads"]) == 1
        thread = result["threads"][0]
        assert thread["root"]["id"] == "$root"
        assert [r["id"] for r in thread["replies"]] == ["$r1", "$r2"]

    async def test_threads_are_ordered_by_latest_activity(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Freshest last, so the tail of the list is what just happened."""
        async with session_factory() as session:
            room_id, client_id = await _make_room(session)
            await _write(session, room_id, client_id, "$a", at=0)
            await _write(session, room_id, client_id, "$b", at=1)
            await _write(session, room_id, client_id, "$a1", at=5, thread_root="$a")
            await session.commit()

        result = await _service(session_factory).read_context("agent-1", room_id)

        assert [t["root"]["id"] for t in result["threads"]] == ["$b", "$a"]

    async def test_a_root_older_than_the_window_is_still_returned(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A reply whose root fell outside the window keeps its root, fetched
        for the whole page at once rather than one query per thread."""
        async with session_factory() as session:
            room_id, client_id = await _make_room(session)
            await _write(session, room_id, client_id, "$root", body="q", at=0)
            for n in range(3):
                await _write(session, room_id, client_id, f"$noise{n}", at=n + 1)
            await _write(
                session,
                room_id,
                client_id,
                "$late",
                body="a",
                at=9,
                thread_root="$root",
            )
            await session.commit()

        result = await _service(session_factory).read_context(
            "agent-1", room_id, limit=2
        )

        threads = {t["root"]["id"]: t for t in result["threads"]}
        assert "$root" in threads
        assert threads["$root"]["root"]["body"] == "q"
        assert [r["id"] for r in threads["$root"]["replies"]] == ["$late"]

    async def test_a_root_with_no_recorded_row_is_elided_not_dropped(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Losing the root must not take the replies with it."""
        async with session_factory() as session:
            room_id, client_id = await _make_room(session)
            await _write(
                session,
                room_id,
                client_id,
                "$orphan",
                body="a",
                thread_root="$vanished",
            )
            await session.commit()

        result = await _service(session_factory).read_context("agent-1", room_id)

        assert len(result["threads"]) == 1
        thread = result["threads"][0]
        assert thread["root"] == {
            "id": "$vanished",
            "kind": "message",
            "sender": None,
            "sender_name": None,
            "body": None,
            "timestamp": None,
            "elided": True,
        }
        assert [r["id"] for r in thread["replies"]] == ["$orphan"]

    async def test_a_root_in_another_room_is_not_borrowed(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Resolving roots is scoped to the room, so an id cannot be read
        across a room boundary by claiming it as a thread parent."""
        async with session_factory() as session:
            room_id, client_id = await _make_room(session)
            other_id, other_client = await _make_room(session)
            await _write(session, other_id, other_client, "$elsewhere", body="secret")
            await _write(
                session, room_id, client_id, "$reply", thread_root="$elsewhere"
            )
            await session.commit()

        result = await _service(session_factory).read_context("agent-1", room_id)

        assert result["threads"][0]["root"]["elided"] is True


class TestLimits:
    async def test_an_absurd_limit_is_clamped(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room_id, client_id = await _make_room(session)
            await _write(session, room_id, client_id, "$m")
            await session.commit()

        result = await _service(session_factory).read_context(
            "agent-1", room_id, limit=10_000
        )

        assert len(result["threads"]) == 1

    async def test_a_nonsense_limit_still_returns_something(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room_id, client_id = await _make_room(session)
            await _write(session, room_id, client_id, "$m")
            await session.commit()

        result = await _service(session_factory).read_context(
            "agent-1", room_id, limit=0
        )

        assert len(result["threads"]) == 1
