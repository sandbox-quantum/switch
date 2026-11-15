"""Buddy onboarding acceptance tests: failure/retry paths for bridged direct
chats, against real Postgres."""

from __future__ import annotations

import uuid

import httpx
from sqlalchemy import func, select

from switch_core.db.models import (
    Agent,
    Client,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    Room,
    User,
)
from tests.switch_core.gateway.conftest import _Harness
from tests.switch_core.gateway.test_chats_bridged_direct import (
    _FakeCollabLifecycle,
    _FakeCore,
)
from tests.switch_core.gateway.test_chats_routes import _code

TENANT = "00000000-0000-0000-0000-000000000000"


async def _slack(
    chats: _Harness, *, link: User | None, channel_creation_enabled: bool = True
) -> tuple[str, _FakeCore]:
    """A running Slack bridge on which `link`, if given, has claimed `U-ALICE`."""
    tag = uuid.uuid4().hex[:8]
    bot_suffix = f"-{tag}"
    async with chats.factory() as session:
        bot = Client(
            transport_user_id=f"@slack-bot{bot_suffix}:switch.test",
            display_name=f"Slack Bot {tag}",
            type="bridge",
        )
        session.add(bot)
        await session.flush()
        bridge = CollaborationBridge(
            tenant_id=TENANT,
            type="slack",
            display_name=f"Acme Slack {tag}",
            connection_config={},
            client_id=bot.id,
            status="active",
            channel_creation_enabled=channel_creation_enabled,
        )
        session.add(bridge)
        await session.flush()
        if link is not None:
            person = Client(
                transport_user_id=f"@slack-alice{bot_suffix}:switch.test",
                display_name="alice.s",
                type="human",
            )
            session.add(person)
            await session.flush()
            external = ExternalUser(
                bridge_id=bridge.id,
                external_user_id="U-ALICE",
                external_username="alice.s",
                client_id=person.id,
            )
            session.add(external)
            await session.flush()
            session.add(
                ExternalUserClaim(external_user_id=external.id, user_id=link.id)
            )
        await session.commit()
        bridge_id = bridge.id
        bot_transport_id = bot.transport_user_id
    core = _FakeCore(bot_transport_id, {"alice.s": "U-ALICE"})
    if not hasattr(chats.room_service, "_collab_lifecycle") or not isinstance(
        chats.room_service._collab_lifecycle,
        _FakeCollabLifecycle,  # type: ignore[union-attr]
    ):
        chats.room_service._collab_lifecycle = _FakeCollabLifecycle({})  # type: ignore[assignment]
    chats.room_service._collab_lifecycle._bridges[bridge_id] = core  # type: ignore[union-attr]
    return bridge_id, core


async def _create(
    chats: _Harness,
    agents: list[Agent],
    bridge_id: str,
    request_id: str = "c1",
    resume_only: bool = False,
) -> httpx.Response:
    return await chats.client.post(
        "/chats",
        json={
            "agentIds": [agent.id for agent in agents],
            "requestId": request_id,
            "bridgeId": bridge_id,
            "resumeOnly": resume_only,
        },
        headers=chats.as_user(chats.alice),
    )


async def test_bridge_with_channel_creation_disabled_returns_422_chat_not_created(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    bridge_id, core = await _slack(
        chats, link=chats.alice, channel_creation_enabled=False
    )

    response = await _create(chats, [agent], bridge_id)

    assert response.status_code == 422
    assert _code(response) == "CHAT_NOT_CREATED"
    assert core.dm_calls == []
    async with chats.factory() as session:
        room_count = await session.scalar(
            select(func.count()).select_from(Room).where(Room.bridge_id == bridge_id)
        )
    assert room_count == 0


async def test_user_linked_on_two_slack_bridges_creates_on_specified_bridge(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    bridge_a_id, core_a = await _slack(chats, link=chats.alice)
    bridge_b_id, core_b = await _slack(chats, link=chats.alice)

    response = await _create(chats, [agent], bridge_b_id, request_id="c2")

    assert response.status_code == 200, response.text
    chat = response.json()["chat"]
    assert chat["bridgeType"] == "slack"
    assert chat["channelType"] == "direct"
    assert core_a.dm_calls == []
    assert core_b.dm_calls == [
        {"agent_name": "helper", "user_name": "alice.s", "user_external_id": "U-ALICE"}
    ]
    async with chats.factory() as session:
        room = await session.get(Room, chat["roomId"])
        assert room is not None
        assert room.bridge_id == bridge_b_id
        assert room.external_channel_id == "C-DM-1"
