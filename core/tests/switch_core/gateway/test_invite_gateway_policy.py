"""The gateway's add-agent route applies the stored invitation policy."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Room
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway import rooms
from switch_core.gateway.schemas import RoomAgentsRequest
from tests.switch_core.test_room_service_invites import (
    OWNER_ONLY,
    _agent,
    _members,
    _user,
)
from tests.switch_core.test_room_service_invites import (
    _service as _room_service,
)


async def test_gateway_add_agent_judges_the_signed_in_user(
    session_factory: async_sessionmaker[AsyncSession], monkeypatch: pytest.MonkeyPatch
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
        # Both can write to the room, so any refusal must come from the
        # invited agent's addressing policy rather than room authorization.
        room = Room(
            transport_room_id="!gateway-invite:test",
            name="room",
            description="d",
            owner_id=owner.id,
            read_visibility="public",
            write_visibility="public",
        )
        session.add(room)
        await session.commit()
        room_id, target_id = room.id, target.id

        # Response rendering is outside the invitation decision being tested.
        async def _detail(*args: Any, **kwargs: Any) -> Any:
            return object()

        monkeypatch.setattr(rooms, "_build_room_detail", _detail)
        service = _room_service(session_factory, running)
        request = RoomAgentsRequest(agent_ids=[target_id])
        kwargs = {
            "room_id": room_id,
            "req": request,
            "session": session,
            "room_service": service,
            "room_store": RoomStore(),
            "bridge_store": None,
            "external_user_store": None,
            "protocol": None,
            "decisions": None,
            "is_admin": False,
        }

        with pytest.raises(HTTPException) as refused:
            await rooms.post_room_agents(user=stranger, **kwargs)  # type: ignore[arg-type]
        assert refused.value.status_code == 403
        assert "doesn't take instructions from you" in refused.value.detail
        assert await _members(session_factory, room_id) == []

        await rooms.post_room_agents(user=owner, **kwargs)  # type: ignore[arg-type]
        assert await _members(session_factory, room_id) == [target_id]
