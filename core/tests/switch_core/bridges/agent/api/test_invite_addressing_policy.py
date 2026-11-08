"""Agent API invitations use the invited agent's stored addressing policy."""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import owner_and_owner_agents_policy
from switch_core.db.models import Room
from switch_core.db.stores.room_store import RoomStore
from tests.switch_core.bridges.agent.api.test_refusal_status_codes import _request
from tests.switch_core.bridges.agent.protocol.test_room_roster_authz import (
    _service as _agent_service,
)
from tests.switch_core.test_room_service_invites import (
    _agent,
    _members,
    _user,
)
from tests.switch_core.test_room_service_invites import (
    _service as _room_service,
)


async def test_agent_api_judges_the_inviting_agent(
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
            policy=owner_and_owner_agents_policy().model_dump(),
            running=running,
        )
        allowed = await _agent(
            session, "allowed.bot", owner_id=owner.id, policy=None, running=running
        )
        denied = await _agent(
            session, "denied.bot", owner_id=stranger.id, policy=None, running=running
        )
        room = Room(transport_room_id="!invite-api:test", name="room", description="d")
        session.add(room)
        await session.flush()
        await RoomStore().add_agents(session, room.id, [allowed.id, denied.id])
        await session.commit()
        room_id, target_id, allowed_id, denied_id = (
            room.id,
            target.id,
            allowed.id,
            denied.id,
        )

    svc = _agent_service(session_factory)
    svc.room_service = _room_service(session_factory, running)

    async def invite(caller_id: str):  # type: ignore[no-untyped-def]
        return await _request(
            svc,
            caller_id,
            "POST",
            f"/agents/{caller_id}/ops/invite_agent_to_room",
            json={"room_id": room_id, "agent_name": "target.bot"},
        )

    refused = await invite(denied_id)
    assert refused.status_code == 403
    assert "doesn't take instructions from you" in refused.json()["detail"]
    assert set(await _members(session_factory, room_id)) == {allowed_id, denied_id}

    accepted = await invite(allowed_id)
    assert accepted.status_code == 200
    assert set(await _members(session_factory, room_id)) == {
        allowed_id,
        denied_id,
        target_id,
    }
