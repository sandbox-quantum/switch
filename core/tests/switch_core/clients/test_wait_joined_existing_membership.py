from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from nio import JoinedRoomsError

from switch_core.clients.client_base import ClientBase

MATRIX_ROOM_ID = "!matrix:switch.local"


class _FakeNioClient:
    def __init__(self, rooms: list[str] | None) -> None:
        self._rooms = rooms
        self.calls = 0

    async def joined_rooms(self) -> object:
        self.calls += 1
        if self._rooms is None:
            return JoinedRoomsError(message="boom")
        return SimpleNamespace(rooms=list(self._rooms))


def _client(nio_client: _FakeNioClient) -> ClientBase:
    client = ClientBase.__new__(ClientBase)
    client.matrix_user_id = "@ext_alice:switch.local"
    client.nio_client = nio_client
    client.room_join_times = {}
    client._room_joined_events = {}
    client._startup_ts = 1000
    return client


async def test_wait_joined_accepts_membership_that_predates_this_process() -> None:
    """A puppet joined in an earlier run replays no member event: the client
    resumes from a stored next_batch token, and re-inviting an existing member
    is a no-op. Waiting on sync alone times out and the message is dropped."""
    nio_client = _FakeNioClient([MATRIX_ROOM_ID])
    client = _client(nio_client)

    assert await client.wait_joined(MATRIX_ROOM_ID, 0.05) is True
    assert nio_client.calls == 1
    # The join predates startup, so it must not shift the ignore cutoff forward
    # and suppress events already in flight.
    assert client.room_join_times[MATRIX_ROOM_ID] == client._startup_ts

    # Membership is cached — no second round trip.
    assert await client.wait_joined(MATRIX_ROOM_ID, 0.05) is True
    assert nio_client.calls == 1


async def test_wait_joined_still_waits_for_a_pending_join() -> None:
    nio_client = _FakeNioClient([])
    client = _client(nio_client)

    async def join_late() -> None:
        await asyncio.sleep(0.01)
        client._mark_joined(MATRIX_ROOM_ID, 2000)

    task = asyncio.create_task(join_late())
    assert await client.wait_joined(MATRIX_ROOM_ID, 1.0) is True
    await task


async def test_wait_joined_times_out_when_the_join_never_lands() -> None:
    client = _client(_FakeNioClient([]))
    assert await client.wait_joined(MATRIX_ROOM_ID, 0.05) is False


async def test_wait_joined_falls_back_to_waiting_when_the_lookup_fails() -> None:
    nio_client = _FakeNioClient(None)
    client = _client(nio_client)

    assert await client.wait_joined(MATRIX_ROOM_ID, 0.05) is False
    assert nio_client.calls == 1
    assert MATRIX_ROOM_ID not in client.room_join_times


if __name__ == "__main__":
    pytest.main([__file__])
