"""End-to-end test for the agent self-join greeting over a real Matrix homeserver.

Drives the genuine path: RoomService creates a room and invites the agent →
the agent's AgentClient sync loop sees the invite → auto-joins → on_self_join
posts the greeting. The assertion reads the room timeline back off the
homeserver, so nothing is inferred from in-process state.
"""

from __future__ import annotations

import asyncio

import pytest

from switch_core.db.models import Agent, CollaborationBridge, Room
from switch_core.room_service import RoomCreateConfig
from tests.integration.conftest import Harness, SessionEnv

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


async def _timeline_messages(
    session_env: SessionEnv, matrix_room_id: str
) -> list[dict]:
    """Every m.room.message in the room, read back off the homeserver as admin."""
    admin = session_env.matrix_admin
    resp = await admin._http.get(
        f"/_matrix/client/r0/rooms/{matrix_room_id}/messages",
        params={"dir": "b", "limit": 100},
        headers={"Authorization": f"Bearer {admin.access_token}"},
    )
    resp.raise_for_status()
    return [
        event
        for event in resp.json().get("chunk", [])
        if event.get("type") == "m.room.message"
    ]


async def _wait_for_message_from(
    session_env: SessionEnv,
    matrix_room_id: str,
    sender_localpart: str,
    timeout: float = 20,
) -> dict | None:
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        for event in await _timeline_messages(session_env, matrix_room_id):
            if event.get("sender", "").startswith(f"@{sender_localpart}"):
                return event
        await asyncio.sleep(0.5)
    return None


async def test_agent_posts_greeting_on_join(
    harness: Harness, session_env: SessionEnv
) -> None:
    agent = await harness.register_agent("e2e-greeter")
    await harness.start_clients()
    client = harness.client_for(agent.agent_id)
    await client.wait_ready()

    result = await harness.room_service.create_room(
        RoomCreateConfig(
            name="e2e-greeting-room",
            description="integration self-join greeting test",
            agent_ids=[agent.agent_id],
        )
    )
    matrix_room_id = result.room.matrix_room_id
    await _wait_joined(client, matrix_room_id)

    greeting = await _wait_for_message_from(
        session_env, matrix_room_id, client.matrix_user_id.split(":")[0].lstrip("@")
    )

    assert greeting is not None, (
        "agent joined the room but never posted a self-join greeting"
    )
    assert "e2e-greeter" in greeting["content"]["body"]


async def test_no_greeting_when_the_bridge_has_them_disabled(
    harness: Harness, session_env: SessionEnv
) -> None:
    """The per-connection toggle still wins over the arrival."""
    host = await harness.register_agent("e2e-quiet-host")
    joiner = await harness.register_agent("e2e-quiet-joiner")
    await harness.start_clients()
    joiner_client = harness.client_for(joiner.agent_id)

    result = await harness.room_service.create_room(
        RoomCreateConfig(
            name="e2e-quiet-room",
            description="integration greeting-toggle test",
            agent_ids=[host.agent_id],
        )
    )
    matrix_room_id = result.room.matrix_room_id
    await _wait_joined(harness.client_for(host.agent_id), matrix_room_id)

    # Point the room at a connection with greetings turned off. Done after
    # creation because the harness runs no collaboration bridge — the join path
    # only ever reads the room's bridge row, which is what is under test.
    async with harness.session_factory() as session:
        host_agent = await session.get(Agent, host.agent_id)
        session.add(
            CollaborationBridge(
                id="quiet-bridge",
                type="mattermost",
                display_name="Quiet",
                client_id=host_agent.client_id,
                status="active",
                agent_greetings_enabled=False,
            )
        )
        room = await session.get(Room, result.room.id)
        room.bridge_id = "quiet-bridge"
        await session.commit()

    await harness.room_service.add_agents_to_room(
        result.room.id, agent_ids=[joiner.agent_id]
    )
    await _wait_joined(joiner_client, matrix_room_id)

    greeting = await _wait_for_message_from(
        session_env,
        matrix_room_id,
        joiner_client.matrix_user_id.split(":")[0].lstrip("@"),
        timeout=8,
    )

    assert greeting is None, (
        f"greeting posted despite the connection having them disabled: {greeting}"
    )
