"""Authenticated entry points pass the inviter; the room service owns policy."""

from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.gateway import rooms
from switch_core.gateway.schemas import RoomAgentsRequest
from switch_core.invitations import InvitationActor, InvitationDenied


@asynccontextmanager
async def session_factory():  # type: ignore[no-untyped-def]
    yield SimpleNamespace()


async def test_agent_protocol_uses_inviting_agent_not_its_owner() -> None:
    protocol = object.__new__(AgentCore)
    protocol.session_factory = session_factory
    protocol._require_room_roster_change = AsyncMock()
    add = AsyncMock(side_effect=InvitationDenied("Ask the agent's owner."))
    protocol.room_service = SimpleNamespace(add_agents_to_room=add)
    with pytest.raises(ValueError, match="Ask the agent's owner"):
        await protocol.invite_agent_to_room("inviter-agent", "room", "target")
    assert add.call_args.kwargs["invited_by"] == InvitationActor(
        kind="agent", id="inviter-agent"
    )
    assert add.call_args.kwargs["added_by_kind"] == "agent"


async def test_gateway_add_uses_signed_in_user_without_admin_bypass(monkeypatch):  # type: ignore[no-untyped-def]
    monkeypatch.setattr(rooms, "_require_room_released", AsyncMock())
    add = AsyncMock(side_effect=InvitationDenied("Ask the agent's owner."))
    with pytest.raises(HTTPException) as refused:
        await rooms.post_room_agents(
            "room",
            RoomAgentsRequest(agent_ids=["target"]),
            SimpleNamespace(),
            SimpleNamespace(add_agents_to_room=add),
            SimpleNamespace(),
            SimpleNamespace(),
            SimpleNamespace(),
            SimpleNamespace(),
            SimpleNamespace(id="admin-user"),
            True,
        )
    assert refused.value.status_code == 400
    assert "owner" in refused.value.detail
    assert add.call_args.kwargs["invited_by"] == InvitationActor(
        kind="user", id="admin-user"
    )
