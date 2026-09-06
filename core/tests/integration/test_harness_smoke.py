"""Smoke test for the integration harness.

Proves the testcontainers stack boots and the in-process wiring works end-to-end:
register agents, start their clients, create a room via RoomService, and confirm
each agent's client actually joined the room. No feature under test — this only
exercises the harness itself.
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


async def test_harness_boots_and_agents_join_room(harness: Harness) -> None:
    alice = await harness.register_agent("smoke-alice")
    bob = await harness.register_agent("smoke-bob")
    await harness.start_clients()

    alice_client = harness.client_for(alice.agent_id)
    bob_client = harness.client_for(bob.agent_id)
    await alice_client.wait_ready()
    await bob_client.wait_ready()

    result = await harness.room_service.create_room(
        RoomCreateConfig(
            name="smoke-room",
            description="integration harness smoke test",
            agent_ids=[alice.agent_id, bob.agent_id],
        )
    )
    matrix_room_id = result.room.matrix_room_id

    await _wait_joined(alice_client, matrix_room_id)
    await _wait_joined(bob_client, matrix_room_id)

    assert matrix_room_id in alice_client.room_join_times
    assert matrix_room_id in bob_client.room_join_times
