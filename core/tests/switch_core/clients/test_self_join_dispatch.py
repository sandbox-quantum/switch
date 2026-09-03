"""The self-join hook must still fire when the client joined the room itself.

`join_room` records membership as soon as the join returns so `wait_joined` and
the `_should_ignore` cutoff are accurate (CHOO-1781). Auto-accepting an invite
goes through it, so by the time the join arrives over sync the room is already
in `room_join_times` — CHOO-2170: gating the hook on that made the agent
greeting unreachable on every room an agent is invited to, which is all of them.
"""

from __future__ import annotations

import pytest

from switch_core.clients.client_base import ClientBase
from switch_core.transport import InboundMembership, RoomRef

MATRIX_ROOM_ID = "!matrix:switch.local"
SELF = "@switch-agent-1:switch.local"


class _Recorder:
    """Stands in for MessageRecorder, collecting the arrivals written."""

    def __init__(self) -> None:
        self.joins: list[str] = []

    async def record_join(self, *, transport_room_id, event, client_id) -> None:
        self.joins.append(event.event_id)


class _Client(ClientBase):
    def __init__(self) -> None:
        self.matrix_user_id = SELF
        self.client_id = "client-1"
        self.room_join_times = {}
        self._room_joined_events = {}
        self._self_join_dispatched = set()
        self._startup_ts = 1000
        self.self_joins: list[str] = []
        self.member_events: list[str] = []
        self.message_recorder = _Recorder()

    async def on_self_join(self, room, event) -> None:
        self.self_joins.append(room.room_id)

    async def on_member_event(self, room, event) -> None:
        self.member_events.append(event.state_key)


def _room() -> RoomRef:
    return RoomRef(room_id=MATRIX_ROOM_ID)


def _member_event(
    *,
    state_key: str = SELF,
    membership: str = "join",
    prev_membership: str | None = "invite",
    timestamp: int = 2000,
) -> InboundMembership:
    return InboundMembership(
        room_id=MATRIX_ROOM_ID,
        event_id="$member",
        sender=state_key,
        timestamp=timestamp,
        state_key=state_key,
        membership=membership,
        prev_membership=prev_membership,
    )


@pytest.mark.asyncio
async def test_self_join_fires_after_the_client_joined_itself() -> None:
    client = _Client()
    # Auto-accepting the invite records membership before sync reports the join.
    client._mark_joined(MATRIX_ROOM_ID, 1500)

    await client._handle_member_event(_room(), _member_event())

    assert client.self_joins == [MATRIX_ROOM_ID]


@pytest.mark.asyncio
async def test_self_join_fires_only_once_for_the_same_join() -> None:
    client = _Client()
    event = _member_event()

    await client._handle_member_event(_room(), event)
    await client._handle_member_event(_room(), event)

    assert client.self_joins == [MATRIX_ROOM_ID]


@pytest.mark.asyncio
async def test_profile_update_is_not_an_arrival() -> None:
    """A display-name change re-fires m.room.member with membership == join."""
    client = _Client()

    await client._handle_member_event(
        _room(), _member_event(prev_membership="join", timestamp=3000)
    )

    assert client.self_joins == []


@pytest.mark.asyncio
async def test_join_predating_this_process_is_not_announced() -> None:
    client = _Client()

    await client._handle_member_event(_room(), _member_event(timestamp=500))

    assert client.self_joins == []


@pytest.mark.asyncio
async def test_rejoining_after_leaving_is_a_fresh_arrival() -> None:
    client = _Client()

    await client._handle_member_event(_room(), _member_event())
    await client._handle_member_event(
        _room(),
        _member_event(membership="leave", prev_membership="join", timestamp=3000),
    )
    await client._handle_member_event(
        _room(), _member_event(prev_membership="leave", timestamp=4000)
    )

    assert client.self_joins == [MATRIX_ROOM_ID, MATRIX_ROOM_ID]


@pytest.mark.asyncio
async def test_another_member_joining_is_not_a_self_join() -> None:
    client = _Client()
    other = "@switch-agent-2:switch.local"

    await client._handle_member_event(_room(), _member_event(state_key=other))

    assert client.self_joins == []
    assert client.member_events == [other]


@pytest.mark.asyncio
async def test_an_arrival_is_logged_even_when_it_is_not_announced() -> None:
    """Announcing and logging answer different questions.

    A join older than this process is nobody's news, so it is not announced.
    It is still how that participant got into the room, so it is still history.
    """
    client = _Client()

    await client._handle_member_event(_room(), _member_event(timestamp=500))

    assert client.self_joins == []
    assert client.message_recorder.joins == ["$member"]


@pytest.mark.asyncio
async def test_a_profile_update_is_not_logged_as_an_arrival() -> None:
    client = _Client()

    await client._handle_member_event(
        _room(), _member_event(prev_membership="join", timestamp=3000)
    )

    assert client.message_recorder.joins == []


@pytest.mark.asyncio
async def test_another_member_arriving_is_not_this_client_to_log() -> None:
    """Each client logs its own arrival, which is what makes it one row."""
    client = _Client()

    await client._handle_member_event(
        _room(), _member_event(state_key="@switch-agent-2:switch.local")
    )

    assert client.message_recorder.joins == []
