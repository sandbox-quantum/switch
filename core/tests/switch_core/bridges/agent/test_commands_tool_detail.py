"""`!tool-detail`: turning a room's tool detail on or off from its chat.

Run against real Postgres with real stores for everything that decides who
may change it: the sender is a person on a chat platform, known to Switch
only through the Switch user who linked that account, and only the room's
owner or a workspace admin may change it. Anyone in the room may ask which
it is.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.commands import COMMANDS_BY_NAME, _cmd_tool_detail
from switch_core.clients.command_consumer import CommandConsumer
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Client,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    Room,
    TenantMember,
    User,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore

_ROOM = SimpleNamespace(room_id="!room:test")


@dataclass
class _World:
    host: CommandConsumer
    replies: list[str]
    room_id: str
    owner_chat: str
    stranger_chat: str
    admin_chat: str
    session_factory: async_sessionmaker[AsyncSession]


async def _user(session: AsyncSession, name: str, *, role: str) -> str:
    user = User(name=name, email=f"{name}@test", role="user", password_hash="x")
    session.add(user)
    await session.flush()
    session.add(TenantMember(tenant_id=TENANT_ZERO_ID, user_id=user.id, role=role))
    return user.id


async def _person(
    session: AsyncSession, bridge_id: str, name: str, *, claimed_by: str
) -> str:
    """A person on the chat platform, linked to a Switch user; their transport id."""
    client = Client(
        transport_user_id=f"@chat-{name}:test", display_name=name, type="user"
    )
    session.add(client)
    await session.flush()
    external = ExternalUser(
        bridge_id=bridge_id,
        external_user_id=f"U-{name}",
        external_username=name,
        client_id=client.id,
    )
    session.add(external)
    await session.flush()
    session.add(ExternalUserClaim(external_user_id=external.id, user_id=claimed_by))
    return client.transport_user_id


@pytest.fixture
async def world(session_factory: async_sessionmaker[AsyncSession]) -> _World:
    async with session_factory() as session:
        owner = await _user(session, "owner", role="member")
        stranger = await _user(session, "stranger", role="member")
        admin = await _user(session, "admin", role="admin")
        bridge_client = Client(
            transport_user_id="@bridge:test", display_name="bridge", type="bridge"
        )
        session.add(bridge_client)
        await session.flush()
        bridge = CollaborationBridge(
            type="mattermost",
            display_name="MM",
            client_id=bridge_client.id,
            status="active",
        )
        session.add(bridge)
        await session.flush()
        owner_chat = await _person(session, bridge.id, "owner", claimed_by=owner)
        stranger_chat = await _person(
            session, bridge.id, "stranger", claimed_by=stranger
        )
        admin_chat = await _person(session, bridge.id, "admin", claimed_by=admin)
        room = Room(
            transport_room_id=f"!r-{uuid.uuid4().hex[:8]}:test",
            name="room",
            description="d",
            owner_id=owner,
        )
        session.add(room)
        await session.commit()
        room_id = room.id

    replies: list[str] = []

    async def reply_command(_room_id: str, body: str, **_kw: Any) -> None:
        replies.append(body)

    async def resolve_room_meta(_transport_room_id: str) -> Any:
        return SimpleNamespace(room_id=room_id)

    host = object.__new__(CommandConsumer)
    host.actor = SimpleNamespace(  # type: ignore[assignment]
        session_factory=session_factory, client_store=ClientStore()
    )
    host._room_store = RoomStore()
    host._room_role_store = RoomRoleStore()
    host._agent_store = AgentStore()
    host._external_user_store = ExternalUserStore()
    host._user_store = UserStore()
    host._connections = SimpleNamespace(live_connection_ids=lambda: set())  # type: ignore[assignment]
    host._resolve_room_meta = resolve_room_meta  # type: ignore[method-assign]
    host.reply_command = reply_command  # type: ignore[method-assign]
    return _World(
        host=host,
        replies=replies,
        room_id=room_id,
        owner_chat=owner_chat,
        stranger_chat=stranger_chat,
        admin_chat=admin_chat,
        session_factory=session_factory,
    )


async def _run(world: _World, args: str, sender: str) -> None:
    event = SimpleNamespace(
        command="tool-detail", args=args, user_id=sender, thread_id="t1"
    )
    await _cmd_tool_detail(world.host, _ROOM, event, False)  # type: ignore[arg-type]


async def _shown(world: _World) -> bool:
    async with world.session_factory() as session:
        return await RoomStore().shows_tool_detail(session, world.room_id)


def test_is_a_room_command_the_switch_app_runs() -> None:
    command = COMMANDS_BY_NAME["tool-detail"]
    assert command.admin_owned
    assert [a.name for a in command.args_spec] == ["state"]


async def test_off_until_turned_on_and_anyone_may_ask(world: _World) -> None:
    await _run(world, "", world.stranger_chat)

    assert "Tool detail is off in this room" in world.replies[-1]
    assert not await _shown(world)


async def test_the_owner_turns_it_on_and_off(world: _World) -> None:
    await _run(world, "on", world.owner_chat)
    assert "Tool detail is on in this room" in world.replies[-1]
    assert await _shown(world)

    await _run(world, " OFF ", world.owner_chat)
    assert "Tool detail is off in this room" in world.replies[-1]
    assert not await _shown(world)


async def test_a_workspace_admin_may_turn_it_on(world: _World) -> None:
    await _run(world, "on", world.admin_chat)

    assert "Tool detail is on in this room" in world.replies[-1]
    assert await _shown(world)


async def test_someone_else_is_refused_and_nothing_changes(world: _World) -> None:
    await _run(world, "on", world.stranger_chat)

    assert world.replies[-1] == (
        "Only the room's owner or a workspace admin can turn tool detail on or off."
    )
    assert not await _shown(world)


async def test_anything_else_shows_usage_and_changes_nothing(world: _World) -> None:
    await _run(world, "maybe", world.owner_chat)

    assert world.replies[-1].startswith("Usage: `!tool-detail on`")
    assert not await _shown(world)
