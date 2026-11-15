"""People who joined a room through Switch Console are room participants.

An agent finds who it can address with `list_participants`, and
`send_targeted_message` refuses any name that list does not hold. A Console
member is in the room by its member client's `client_rooms` row, not by a
platform account, so both are checked here against a real database.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.protocol.types import SentMessage
from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.db.models import Client, Room, User
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from tests.switch_core.test_room_wide_mention_wakes_no_agent import _make_agent


def _core(
    session_factory: async_sessionmaker[AsyncSession], sent: list[str]
) -> AgentCore:
    """The real roster and targeted send over real stores; only the send onto
    the bus is recorded instead of made."""
    core = object.__new__(AgentCore)
    core.connections = AgentConnectionRegistry()
    core.session_factory = session_factory
    core.room_store = RoomStore()
    core.room_role_store = RoomRoleStore()
    core.agent_store = AgentStore()
    core.agent_session_store = AgentSessionStore()
    core.external_user_store = ExternalUserStore()

    async def _send_message(
        _agent_id: str, _room_id: str, body: str, *_a: Any, **_kw: Any
    ) -> SentMessage:
        sent.append(body)
        return SentMessage(event_id=f"evt-{len(sent)}", trust=None)

    core.send_message = _send_message  # type: ignore[method-assign]
    return core


async def _room_with_member(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[str, str, str, str]:
    """A room holding one agent and one Console member, plus a member client
    of someone who is in no room. Returns (room, agent, member client, the
    outsider's client)."""
    room_store = RoomStore()
    async with session_factory() as session:
        room = Room(transport_room_id="!members:test", name="m", description="m")
        session.add(room)
        await session.flush()
        agent = await _make_agent(session, "helper")
        await room_store.add_agents(session, room.id, [agent.id])
        clients = []
        for name in ("Dana Reyes", "Outsider"):
            user = User(
                name=name,
                email=f"{name.split()[0].lower()}@test",
                role="user",
                password_hash="x",
            )
            session.add(user)
            await session.flush()
            client = Client(
                transport_user_id=f"@switch-member-{user.id}:test",
                display_name=name,
                type=MEMBER_CLIENT_TYPE,
                user_id=user.id,
            )
            session.add(client)
            await session.flush()
            clients.append(client)
        member, outsider = clients
        await room_store.add_client(session, member.id, room.id)
        await session.commit()
        return room.id, agent.id, member.id, outsider.id


async def test_a_console_member_is_listed_as_a_user(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    room_id, agent_id, member_id, outsider_id = await _room_with_member(session_factory)

    participants = await _core(session_factory, []).list_participants(room_id)

    by_id = {p.id: p for p in participants}
    assert by_id[agent_id].type == "agent"
    assert by_id[member_id].type == "user"
    assert by_id[member_id].name == "Dana Reyes"
    assert outsider_id not in by_id
    assert len(participants) == 2


async def test_an_agent_can_target_a_console_member(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    room_id, agent_id, _member_id, _outsider_id = await _room_with_member(
        session_factory
    )
    sent: list[str] = []

    result = await _core(session_factory, sent).send_targeted_message(
        agent_id, room_id, ["Dana Reyes"], "the build is green"
    )

    assert sent == ["@Dana Reyes the build is green"]
    assert result.target_statuses == {}
