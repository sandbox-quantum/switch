"""A message in a room with many members' Console streams open costs each
stream only the read of what its person may see: the room's new rows are read
once and shared. The streams' passes hold at most the process's stream slots
of connections at once, however many are woken together, and a stream woken
by a row a shared read may have missed reads the room itself."""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.chats.stream_reads import Page, StreamReads
from switch_core.db.models import User
from switch_core.gateway.chats import _ChatStream
from tests.switch_core.gateway.conftest import _Harness
from tests.switch_core.statement_counts import StatementCounts

TENANT = "00000000-0000-0000-0000-000000000000"


async def _room(chats: _Harness) -> str:
    created = await chats.client.post(
        "/chats",
        json={"agentIds": [], "memberUserIds": [chats.bob.id], "requestId": "fanout"},
        headers=chats.as_user(chats.alice),
    )
    assert created.status_code == 200, created.text
    return str(created.json()["chat"]["roomId"])


async def _streams(chats: _Harness, users: list[User]) -> list[_ChatStream]:
    streams = [_ChatStream(chats.service, TENANT, user, {}) for user in users]
    for stream in streams:
        await stream.refresh(None, initial=True)
    return streams


async def _pass_all(streams: list[_ChatStream]) -> list[list[bytes]]:
    """One pass of every stream at once, as a ring of their room starts."""
    results = await asyncio.gather(
        *(stream.refresh(stream.take_rung(), initial=False) for stream in streams)
    )
    assert all(alive for _, alive in results)
    return [frames for frames, _ in results]


def _people(chats: _Harness, count: int) -> list[User]:
    # Several Console windows per person, as many streams as the test needs.
    people = [chats.alice, chats.bob]
    return [people[index % len(people)] for index in range(count)]


async def test_a_message_reads_the_rooms_rows_once_for_all_its_streams(
    chats: _Harness, statement_counts: StatementCounts
) -> None:
    room_id = await _room(chats)
    measured: dict[int, int] = {}
    for count in (1, 12):
        streams = await _streams(chats, _people(chats, count))
        await chats.listener.ring(room_id)
        with statement_counts.scope(f"quiet-{count}") as quiet:
            # Rung with nothing new: what a pass costs its own person alone.
            await _pass_all(streams)
        sent = await chats.send(chats.bob, room_id, f"m{count}", f"hello {count}")
        assert sent.status_code == 200
        await chats.listener.ring(room_id)
        with statement_counts.scope(f"message-{count}") as message:
            frames = await _pass_all(streams)
        for stream in streams:
            stream.close()
        for own in frames:
            assert len(own) == 1 and f"hello {count}" in own[0].decode()
        per_stream = quiet.count // count
        assert quiet.count == per_stream * count, quiet.statements
        # What the message costs beyond each stream's own reads: the room's
        # page, read once, whether one stream wants it or twelve.
        measured[count] = message.count - quiet.count

    assert measured[12] == measured[1], measured
    assert measured[1] > 0, measured


async def test_a_stream_rung_after_a_shared_read_began_reads_the_room_itself(
    chats: _Harness,
) -> None:
    room_id = await _room(chats)
    first, second = await _streams(chats, [chats.alice, chats.bob])
    assert (await chats.send(chats.bob, room_id, "m1", "one")).status_code == 200
    await chats.listener.ring(room_id)
    frames, _ = await first.refresh(first.take_rung(), initial=False)
    assert ["one" in frame.decode() for frame in frames] == [True]

    # A second row, rung after the first stream's read: the page it read
    # does not hold it, so the second stream must not take that page.
    assert (await chats.send(chats.bob, room_id, "m2", "two")).status_code == 200
    await chats.listener.ring(room_id)
    frames, _ = await second.refresh(second.take_rung(), initial=False)
    first.close()
    second.close()
    bodies = [frame.decode() for frame in frames]
    assert len(bodies) == 2, bodies
    assert "one" in bodies[0] and "two" in bodies[1]


class _LiveSessions:
    """The session factory, counting the sessions open at once."""

    def __init__(self, factory: async_sessionmaker[AsyncSession]) -> None:
        self._factory = factory
        self.open = 0
        self.most = 0

    def __call__(self, **kwargs: Any) -> Any:
        return self._session(**kwargs)

    @asynccontextmanager
    async def _session(self, **kwargs: Any) -> AsyncIterator[AsyncSession]:
        async with self._factory(**kwargs) as session:
            self.open += 1
            self.most = max(self.most, self.open)
            try:
                # Lets every other pass reach its own session first, as passes
                # woken together do when the database is slow to answer.
                await asyncio.sleep(0)
                yield session
            finally:
                self.open -= 1


async def _most_sessions_at_once(chats: _Harness, slots: int | None) -> int:
    room_id = await _room(chats)
    streams = await _streams(chats, _people(chats, 10))
    live = _LiveSessions(chats.service.session_factory)
    chats.service.stream_reads = StreamReads(slots)
    chats.service.session_factory = live  # type: ignore[assignment]
    try:
        sent = await chats.send(chats.bob, room_id, f"slots-{slots}", "hi")
        assert sent.status_code == 200
        live.most = 0
        await chats.listener.ring(room_id)
        frames = await _pass_all(streams)
    finally:
        chats.service.session_factory = live._factory
        for stream in streams:
            stream.close()
    assert all(len(own) == 1 for own in frames), frames
    return live.most


async def test_passes_woken_together_hold_at_most_the_slots(chats: _Harness) -> None:
    assert await _most_sessions_at_once(chats, slots=2) == 2


async def test_without_slots_every_pass_woken_together_holds_one(
    chats: _Harness,
) -> None:
    assert await _most_sessions_at_once(chats, slots=None) == 10


async def test_a_read_that_fails_leaves_the_waiting_streams_to_read_for_themselves() -> (
    None
):
    reads = StreamReads(None)
    started = asyncio.Event()
    release = asyncio.Event()
    woken_at = time.monotonic() - 1.0

    async def failing() -> Page:
        started.set()
        await release.wait()
        raise RuntimeError("the stream that read went away")

    async def own() -> Page:
        return Page(frames=(b"x",), last_seq=7, full=False)

    leader = asyncio.create_task(reads.page(TENANT, "room", 3, None, failing))
    await started.wait()
    follower = asyncio.create_task(reads.page(TENANT, "room", 3, woken_at, own))
    await asyncio.sleep(0)
    release.set()
    try:
        await leader
    except RuntimeError:
        pass
    assert await follower == Page(frames=(b"x",), last_seq=7, full=False)
