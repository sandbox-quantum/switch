"""A bot is added to a channel Switch has never seen, as its owner changes their mind.

The adder the platform named passes the first check, and the owner tightens the
policy before the room is written. That person must still be judged at commit, and
only for the bot they added: another bot already in the channel keeps its own
story. Real Postgres, real `RoomService`; only the platform and transport are fakes.
"""

from __future__ import annotations

from functools import partial
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import AddressingPolicy, owner_only_policy
from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import InboundAgentJoin
from switch_core.db.models import Agent
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_store import RoomStore
from tests.switch_core.test_invites import _service, _World, _world

CHANNEL = "chan-race"


async def _returns(value: Any = None, *_args: Any, **_kw: Any) -> Any:
    return value


def _rooms_and_platform(
    service: Any,
    session_factory: async_sessionmaker[AsyncSession],
    world: _World,
    *,
    before_writing_the_room: Any,
) -> list[str]:
    """Wire the real service to a fake platform, and return its notices."""
    notices: list[str] = []
    clients = {
        agent.id: SimpleNamespace(
            client_id=agent.client_id, transport_user_id=f"@{agent.name}:test"
        )
        for agent in (world.target, world.other_agent)
    }

    async def admin_message(
        _channel: str, content: str, *_args: Any, **_kw: Any
    ) -> str:
        notices.append(content)
        return "ref"

    adapter = SimpleNamespace(
        admin_message=admin_message,
        slash_invite_hint=lambda: None,
        add_agents_to_channel=partial(_returns, None),
        get_channel_type=partial(_returns, "channel_public"),
        add_users_to_channel=partial(_returns, None),
        ensure_channel_subscriptions=partial(_returns, None),
    )
    core = SimpleNamespace(
        adapter=adapter,
        begin_provisioning=lambda _channel: None,
        end_provisioning=lambda _channel: None,
        add_room_mapping=lambda *_args: None,
        _workspace_consumer_transport_user_id="@workspace:test",
        ensure_users_in_room=partial(_returns, None),
    )

    async def create_room(_name: str, _description: str) -> str:
        await before_writing_the_room()
        return f"!race-{len(service.provisioned)}:test"

    service.provisioned = []
    service._provisioning = SimpleNamespace(
        create_room=create_room, invite_to_room=partial(_returns, None)
    )
    service._client_lifecycle = SimpleNamespace(
        get_by_agent_id=clients.get,
        get_by_type=lambda *_args: [],
        get=lambda _client_id: None,
    )
    service._collab_lifecycle = SimpleNamespace(
        get=lambda _bridge_id: core, rooms_changed=lambda _bridge_id: None
    )
    service._require_tenant_bridge = partial(_returns, None)
    service._bridge_platform = partial(_returns, "mattermost")
    service.bridge_adapter = adapter
    return notices


def _bridge(
    service: Any,
    session_factory: async_sessionmaker[AsyncSession],
    world: _World,
    notices: list[str],
) -> SimpleNamespace:
    async def admin_message(
        _channel: str, content: str, *_args: Any, **_kw: Any
    ) -> str:
        notices.append(content)
        return "ref"

    async def resolve_agents(_channel: str, _channel_type: str) -> list[str]:
        return [world.target.id, world.other_agent.id]

    async def adopt_existing(channel: str) -> tuple[str, str] | None:
        return bridge._channel_to_room.get(channel)

    def add_room_mapping(
        room_id: str, transport_room_id: str, channel: str, _tenant_id: str
    ) -> None:
        bridge._channel_to_room[channel] = (room_id, transport_room_id)

    bridge = SimpleNamespace(
        _session_factory=session_factory,
        _agent_store=AgentStore(),
        _room_store=RoomStore(),
        _external_user_store=ExternalUserStore(),
        _room_service=service,
        _adapter=SimpleNamespace(
            admin_message=admin_message, slash_invite_hint=lambda: None
        ),
        _resolve_agents_for_channel=resolve_agents,
        _adopt_existing_room=adopt_existing,
        add_room_mapping=add_room_mapping,
        _provisioning_channels=set(),
        _channel_to_room={},
        _room_tenants={},
        _bridge_display_name="Mattermost",
        _bridge_id=world.bridge.id,
    )
    bridge._owner_handle = partial(CollaborationCore._owner_handle, bridge)
    bridge._disclose_unverified_joins = partial(
        CollaborationCore._disclose_unverified_joins, bridge
    )
    bridge._create_room_for_channel = partial(
        CollaborationCore._create_room_for_channel, bridge
    )
    return bridge


def _join(agent: Agent, added_by: str | None) -> InboundAgentJoin:
    return InboundAgentJoin(
        channel_id=CHANNEL,
        channel_type="channel_public",
        agent_name=agent.name,
        channel_name="war-room",
        added_by_external_user_id=added_by,
    )


@pytest.fixture
async def world(session_factory: async_sessionmaker[AsyncSession]) -> _World:
    async with session_factory() as session:
        world = await _world(session)
        # The bot being added admits its adder for now. The bot already in the
        # channel is private, and nobody can say who put it there.
        world.target.addressing_policy = AddressingPolicy().model_dump()
        world.other_agent.addressing_policy = owner_only_policy([]).model_dump()
        await session.commit()
    return world


async def _roster(
    session_factory: async_sessionmaker[AsyncSession], room_id: str
) -> set[str]:
    async with session_factory() as session:
        return set(await RoomStore().get_agent_ids(session, room_id))


async def _tighten(
    session_factory: async_sessionmaker[AsyncSession], agent_id: str
) -> None:
    async with session_factory() as session:
        agent = await session.get(Agent, agent_id)
        assert agent is not None
        agent.addressing_policy = owner_only_policy([]).model_dump()
        await session.commit()


async def test_an_owner_who_changes_their_mind_mid_join_is_obeyed_at_commit(
    session_factory: async_sessionmaker[AsyncSession], world: _World
) -> None:
    """The policy tightens after both early checks, at the last possible moment."""
    service = _service(session_factory)

    async def tighten() -> None:
        await _tighten(session_factory, world.target.id)

    notices = _rooms_and_platform(
        service, session_factory, world, before_writing_the_room=tighten
    )
    bridge = _bridge(service, session_factory, world, notices)

    await CollaborationCore._handle_agent_joined_channel_locked(
        bridge, _join(world.target, "U-unclaimed")
    )

    room_id, _ = bridge._channel_to_room[CHANNEL]
    # The channel has a room, without the refused agent. The other bot's adder is
    # unknown, so it is let in and disclosed, whoever added the first one.
    assert await _roster(session_factory, room_id) == {world.other_agent.id}
    assert any("only takes instructions" in notice for notice in notices)
    assert any(
        "didn't say who added" in notice and world.other_agent.name in notice
        for notice in notices
    )


async def test_replaying_the_join_does_not_slip_the_refused_agent_back_in(
    session_factory: async_sessionmaker[AsyncSession], world: _World
) -> None:
    service = _service(session_factory)

    async def tighten() -> None:
        await _tighten(session_factory, world.target.id)

    notices = _rooms_and_platform(
        service, session_factory, world, before_writing_the_room=tighten
    )
    bridge = _bridge(service, session_factory, world, notices)
    join = _join(world.target, "U-unclaimed")
    await CollaborationCore._handle_agent_joined_channel_locked(bridge, join)
    room_id, _ = bridge._channel_to_room[CHANNEL]
    notices.clear()

    await CollaborationCore._handle_agent_joined_channel_locked(bridge, join)

    assert await _roster(session_factory, room_id) == {world.other_agent.id}
    assert len(notices) == 1
    assert "only takes instructions" in notices[0]


async def test_an_adder_who_still_passes_answers_only_for_their_own_bot(
    session_factory: async_sessionmaker[AsyncSession], world: _World
) -> None:
    """Being refused by a private bot you didn't add must not cost the room the
    bot you did."""
    service = _service(session_factory)
    notices = _rooms_and_platform(
        service,
        session_factory,
        world,
        before_writing_the_room=partial(_returns, None),
    )
    bridge = _bridge(service, session_factory, world, notices)

    await CollaborationCore._handle_agent_joined_channel_locked(
        bridge, _join(world.target, "U-unclaimed")
    )

    room_id, _ = bridge._channel_to_room[CHANNEL]
    assert await _roster(session_factory, room_id) == {
        world.target.id,
        world.other_agent.id,
    }
    assert not any("only takes instructions" in notice for notice in notices)
    assert len(notices) == 1
    assert world.other_agent.name in notices[0]
