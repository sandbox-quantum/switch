"""Chat commands apply the target agent's stored invitation policy."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.commands import _cmd_invite
from switch_core.db.models import Client, Room
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_store import RoomStore
from tests.switch_core.test_room_service_invites import (
    OWNER_ONLY,
    _agent,
    _members,
    _user,
)
from tests.switch_core.test_room_service_invites import (
    _service as _room_service,
)


async def test_invite_command_judges_the_actual_chat_sender(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    running: dict[str, Any] = {}
    async with session_factory() as session:
        owner = await _user(session, "owner")
        stranger = await _user(session, "stranger")
        target = await _agent(
            session,
            "target.bot",
            owner_id=owner.id,
            policy=OWNER_ONLY,
            running=running,
        )
        room = Room(
            transport_room_id="!command-invite:test", name="room", description="d"
        )
        owner_sender = Client(
            transport_user_id="@owner:test",
            display_name="owner",
            type="member",
            user_id=owner.id,
        )
        stranger_sender = Client(
            transport_user_id="@stranger:test",
            display_name="stranger",
            type="member",
            user_id=stranger.id,
        )
        session.add_all([room, owner_sender, stranger_sender])
        await session.commit()
        room_id, target_id = room.id, target.id

    replies: list[str] = []

    async def resolve_room(_transport_room_id: str) -> Any:
        return SimpleNamespace(room_id=room_id)

    async def reply(_room_id: str, body: str, **_kwargs: Any) -> None:
        replies.append(body)

    client = SimpleNamespace(
        session_factory=session_factory,
        _resolve_room_meta=resolve_room,
        reply_command=reply,
        _agent_store=AgentStore(),
        _room_store=RoomStore(),
        _room_service=_room_service(session_factory, running),
    )
    room_ref = SimpleNamespace(room_id="!command-invite:test")

    def event(sender: str) -> Any:
        return SimpleNamespace(args="@target.bot", user_id=sender, thread_id=None)

    await _cmd_invite(client, room_ref, event("@stranger:test"), False)
    assert len(replies) == 1
    assert "doesn't take instructions from you" in replies[0]
    assert await _members(session_factory, room_id) == []

    await _cmd_invite(client, room_ref, event("@owner:test"), False)
    assert len(replies) == 2
    assert "Added" in replies[1]
    assert await _members(session_factory, room_id) == [target_id]
