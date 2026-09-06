"""End-to-end test for the room_join event over the real transport.

Drives the genuine path: RoomService adds an agent to a room → the invite reaches
the joiner → the watcher's AgentClient receive loop sees the arrival →
on_member_event enqueues a `room_join` AgentEvent → it is read off the event
buffer. No mocks, no HTTP layer.
"""

from __future__ import annotations

import asyncio

import pytest

from switch_core.room_service import RoomCreateConfig
from tests.integration.conftest import Harness

# Session-scoped event loop: the background clients are created and torn down
# across tests; sharing one loop lets their connections finalize cleanly instead
# of being stranded when a per-test loop is destroyed.
pytestmark = [pytest.mark.integration, pytest.mark.asyncio(loop_scope="session")]


async def _wait_joined(
    client: object, matrix_room_id: str, timeout: float = 30
) -> None:
    """Block until the agent's own client has joined the room."""
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if matrix_room_id in client.room_join_times:  # type: ignore[attr-defined]
            return
        await asyncio.sleep(0.25)
    raise AssertionError(f"client never joined {matrix_room_id} within {timeout}s")


async def _drain_room_join(
    harness: Harness, agent_id: str, room_id: str, timeout: float = 30
):
    """Poll the watcher's queue until a room_join arrives or time runs out."""
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        remaining = deadline - asyncio.get_event_loop().time()
        events = await harness.event_buffer.poll_room(
            agent_id, room_id, timeout=min(5, max(0.1, remaining))
        )
        for ev in events:
            if ev.type == "room_join":
                return ev
    return None


async def test_join_emits_room_join_event(harness: Harness) -> None:
    watcher = await harness.register_agent("e2e-watcher")
    joiner = await harness.register_agent("e2e-joiner")
    await harness.start_clients()

    watcher_client = harness.client_for(watcher.agent_id)
    await watcher_client.wait_ready()
    await harness.client_for(joiner.agent_id).wait_ready()

    # Room with only the watcher, so the joiner's join is strictly later than the
    # watcher's own join-time (the AgentClient filters out events predating it).
    result = await harness.room_service.create_room(
        RoomCreateConfig(
            name="e2e-room-join",
            description="integration room_join test",
            agent_ids=[watcher.agent_id],
            # Opt the watcher in so `listening` comes back True.
            join_event_listeners=[watcher.agent_id],
        )
    )
    room_id = result.room.id
    matrix_room_id = result.room.matrix_room_id

    await _wait_joined(watcher_client, matrix_room_id)

    # Trigger the observed join.
    await harness.room_service.add_agents_to_room(room_id, agent_ids=[joiner.agent_id])

    event = await _drain_room_join(harness, watcher.agent_id, room_id)

    assert event is not None, "watcher never received a room_join event"
    assert event.room_id == room_id
    assert event.payload.member.startswith("@")
    assert "e2e-joiner" in event.payload.member_name
    assert event.payload.listening is True


async def test_self_join_does_not_emit_room_join(harness: Harness) -> None:
    """An agent's own join produces a greeting, not a room_join for itself."""
    watcher = await harness.register_agent("e2e-solo")
    await harness.start_clients()
    watcher_client = harness.client_for(watcher.agent_id)
    await watcher_client.wait_ready()

    result = await harness.room_service.create_room(
        RoomCreateConfig(
            name="e2e-room-solo",
            description="integration self-join test",
            agent_ids=[watcher.agent_id],
        )
    )
    await _wait_joined(watcher_client, result.room.matrix_room_id)

    # Give the receive loop time to deliver any (erroneous) self-join event.
    event = await _drain_room_join(harness, watcher.agent_id, result.room.id, timeout=8)
    assert event is None, "self-join should not produce a room_join event"
