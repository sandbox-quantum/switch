"""End-to-end: removing an agent from a room stops delivering that room to it.

Drives the genuine path, no mocks and no stubs. `RoomService` removes the agent
the way the gateway's `DELETE /rooms/{id}/agents/{id}` does → the kick is rung
over the invite bus → the transport drops the subscription and tells its client
→ the client empties the event buffer of that room → every reader stops serving
it.

The unit tests cover each of those links. What only this can show is that they
are joined: severing the one line in `ClientBase.setup` that wires the removal
handler to the transport left the whole unit suite green while a kick reached
nothing.

Two readers rather than one, because they fail differently. `poll_events`
applies membership from the database on every poll, so it is right even if the
signal never arrives. The notification stream and the SSE reader have only the
eviction — an SSE stream holds no session to re-derive membership with — so
they are the ones that show whether the removal was really acted on.
"""

from __future__ import annotations

import asyncio

import pytest

from switch_core.room_service import RoomCreateConfig
from tests.integration.conftest import Harness

pytestmark = [pytest.mark.integration, pytest.mark.asyncio(loop_scope="session")]


async def _wait_joined(
    client: object, matrix_room_id: str, timeout: float = 30
) -> None:
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if matrix_room_id in client.room_join_times:  # type: ignore[attr-defined]
            return
        await asyncio.sleep(0.25)
    raise AssertionError(f"client never joined {matrix_room_id} within {timeout}s")


async def _wait_buffered(
    harness: Harness, agent_id: str, room_id: str, body: str, timeout: float = 30
) -> None:
    """Block until the message is in the agent's buffer, addressed to it.

    Addressed matters: an unaddressed message is not notifiable, and the
    notification half of this test would then pass whatever the code did.
    """
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        for item in harness.event_buffer.read_from(agent_id, 0):
            if (
                item.room_id == room_id
                and getattr(item.event.payload, "body", None) == body
            ):
                assert item.notifiable, (
                    f"{body!r} was buffered but not as an addressed message, so "
                    "the notification assertions below would be vacuous"
                )
                return
        await asyncio.sleep(0.25)
    raise AssertionError(f"{body!r} never reached the buffer for room {room_id}")


def _rooms_in_buffer(harness: Harness, agent_id: str) -> set[str]:
    return {item.room_id for item in harness.event_buffer.read_from(agent_id, 0)}


async def test_removal_stops_every_reader_serving_the_room(harness: Harness) -> None:
    watcher = await harness.register_agent("e2e-removed-watcher")
    talker = await harness.register_agent("e2e-removed-talker")
    await harness.start_clients()
    watcher_client = harness.client_for(watcher.agent_id)
    await watcher_client.wait_ready()
    await harness.client_for(talker.agent_id).wait_ready()

    rooms = {}
    for label in ("left", "kept"):
        result = await harness.room_service.create_room(
            RoomCreateConfig(
                name=f"e2e-removal-{label}",
                description=f"integration removal test ({label})",
                agent_ids=[watcher.agent_id, talker.agent_id],
            )
        )
        rooms[label] = result.room
        await _wait_joined(watcher_client, result.room.matrix_room_id)

    talker_client = harness.client_for(talker.agent_id)
    bodies = {}
    for label, room in rooms.items():
        bodies[label] = f"@e2e-removed-watcher please look at the {label} room"
        await talker_client.send_message(room.matrix_room_id, bodies[label])
        await _wait_buffered(harness, watcher.agent_id, room.id, bodies[label])

    # Both rooms are in the buffer and addressed, so every assertion after the
    # removal is about the removal rather than about nothing being there.
    assert _rooms_in_buffer(harness, watcher.agent_id) == {
        rooms["left"].id,
        rooms["kept"].id,
    }

    await harness.room_service.remove_agents_from_room(
        rooms["left"].id, [watcher.agent_id]
    )

    # The buffer is what the SSE reader reads, and it has no membership of its
    # own to apply — this is the whole of its defence.
    deadline = asyncio.get_event_loop().time() + 15
    while asyncio.get_event_loop().time() < deadline:
        if rooms["left"].id not in _rooms_in_buffer(harness, watcher.agent_id):
            break
        await asyncio.sleep(0.25)
    assert _rooms_in_buffer(harness, watcher.agent_id) == {rooms["kept"].id}, (
        "the removed room's events are still retained for the agent, so an SSE "
        "reader resuming from an older cursor would be handed them"
    )

    notifications = await harness.protocol.poll_notifications(
        watcher.agent_id, timeout=0
    )
    assert [e.room_id for e in notifications] == [rooms["kept"].id]
    assert [getattr(e.payload, "body", None) for e in notifications] == [bodies["kept"]]

    events = await harness.protocol.poll_events(watcher.agent_id, timeout=0)
    assert rooms["left"].id not in {e.room_id for e in events}
    assert rooms["kept"].id in {e.room_id for e in events}


async def test_a_room_the_agent_is_still_in_is_untouched(harness: Harness) -> None:
    """The removal empties one room, not the agent.

    `EventBuffer.remove` exists and drops everything; reaching for it on a
    removal would take the agent's other rooms with it, which is the same
    silence arrived at from the opposite direction.
    """
    watcher = await harness.register_agent("e2e-still-in-watcher")
    talker = await harness.register_agent("e2e-still-in-talker")
    await harness.start_clients()
    watcher_client = harness.client_for(watcher.agent_id)
    await watcher_client.wait_ready()
    await harness.client_for(talker.agent_id).wait_ready()

    kept = await harness.room_service.create_room(
        RoomCreateConfig(
            name="e2e-removal-untouched",
            description="integration removal test (untouched)",
            agent_ids=[watcher.agent_id, talker.agent_id],
        )
    )
    left = await harness.room_service.create_room(
        RoomCreateConfig(
            name="e2e-removal-departed",
            description="integration removal test (departed)",
            agent_ids=[watcher.agent_id, talker.agent_id],
        )
    )
    await _wait_joined(watcher_client, kept.room.matrix_room_id)
    await _wait_joined(watcher_client, left.room.matrix_room_id)

    body = "@e2e-still-in-watcher this one still applies"
    await harness.client_for(talker.agent_id).send_message(
        kept.room.matrix_room_id, body
    )
    await _wait_buffered(harness, watcher.agent_id, kept.room.id, body)

    await harness.room_service.remove_agents_from_room(left.room.id, [watcher.agent_id])

    notifications = await harness.protocol.poll_notifications(
        watcher.agent_id, timeout=0
    )
    assert [getattr(e.payload, "body", None) for e in notifications] == [body], (
        "being removed from one room took the agent's other room with it"
    )
