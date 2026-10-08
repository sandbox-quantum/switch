from __future__ import annotations

import asyncio

import pytest

from switch_core.clients.actor import Actor
from tests.switch_core.transport.fake import FakeTransport

TRANSPORT_ROOM_ID = "!matrix:switch.local"


class _CountingTransport(FakeTransport):
    """Counts membership lookups so the caching assertions stay meaningful."""

    def __init__(self, joined: list[str]) -> None:
        super().__init__(joined=joined)
        self.calls = 0

    async def joined_rooms(self) -> list[str]:
        self.calls += 1
        return await super().joined_rooms()


def _client(transport: FakeTransport) -> Actor:
    client = Actor.__new__(Actor)
    client.transport_user_id = "@ext_alice:switch.local"
    client.transport = transport
    client.room_join_times = {}
    client._room_joined_events = {}
    client._connected_at = 1000
    return client


async def test_wait_joined_accepts_membership_that_predates_this_process() -> None:
    """A human actor joined in an earlier run replays no member event: the client
    resumes from a stored next_batch token, and re-inviting an existing member
    is a no-op. Waiting on sync alone times out and the message is dropped."""
    transport = _CountingTransport([TRANSPORT_ROOM_ID])
    client = _client(transport)

    assert await client.wait_joined(TRANSPORT_ROOM_ID, 0.05) is True
    assert transport.calls == 1
    # The join predates startup, so it must not shift the ignore cutoff forward
    # and suppress events already in flight.
    assert client.room_join_times[TRANSPORT_ROOM_ID] == client._connected_at

    # Membership is cached — no second round trip.
    assert await client.wait_joined(TRANSPORT_ROOM_ID, 0.05) is True
    assert transport.calls == 1


async def test_wait_joined_still_waits_for_a_pending_join() -> None:
    client = _client(_CountingTransport([]))

    async def join_late() -> None:
        await asyncio.sleep(0.01)
        client.mark_joined(TRANSPORT_ROOM_ID, 2000)

    task = asyncio.create_task(join_late())
    assert await client.wait_joined(TRANSPORT_ROOM_ID, 1.0) is True
    await task


async def test_wait_joined_times_out_when_the_join_never_lands() -> None:
    client = _client(_CountingTransport([]))
    assert await client.wait_joined(TRANSPORT_ROOM_ID, 0.05) is False


async def test_wait_joined_falls_back_to_waiting_when_the_lookup_reports_nothing() -> (
    None
):
    """A failed membership lookup degrades to "no rooms" at the transport, so
    the client must wait rather than record a join it never observed."""
    transport = _CountingTransport([])
    client = _client(transport)

    assert await client.wait_joined(TRANSPORT_ROOM_ID, 0.05) is False
    assert transport.calls == 1
    assert TRANSPORT_ROOM_ID not in client.room_join_times


async def test_an_actor_with_no_consumer_sees_a_join_that_lands_later() -> None:
    """A HumanActor runs no read loop, so no member event ever reaches it.
    Membership written by someone else after the wait began is found by
    re-reading, not by an event."""
    transport = _CountingTransport([])
    client = _client(transport)

    async def joined_by_someone_else() -> None:
        await asyncio.sleep(0.05)
        transport._joined.append(TRANSPORT_ROOM_ID)

    task = asyncio.create_task(joined_by_someone_else())
    assert await client.wait_joined(TRANSPORT_ROOM_ID, 1.0) is True
    assert transport.calls >= 2
    await task


if __name__ == "__main__":
    pytest.main([__file__])
