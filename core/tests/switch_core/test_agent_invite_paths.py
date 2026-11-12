from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from switch_core.agent_invites import AgentInviteDenied, AgentInviter
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import InboundAgentJoin
from switch_core.clients.admin_messages import ADMIN_MARKER
from switch_core.gateway import rooms
from switch_core.gateway.schemas import RoomAgentsRequest, RoomCreateRequest
from switch_core.room_service import RoomService


@asynccontextmanager
async def session():
    yield SimpleNamespace()


async def test_mcp_and_agent_api_invites_forward_the_inviting_agent():
    service = SimpleNamespace(
        add_agents_to_room=AsyncMock(side_effect=AgentInviteDenied("Ask its owner"))
    )
    core = SimpleNamespace(
        session_factory=session,
        _require_room_roster_change=AsyncMock(),
        room_service=service,
    )
    with pytest.raises(AgentInviteDenied):
        await AgentCore.invite_agent_to_room(core, "manager", "room", "worker")
    assert service.add_agents_to_room.await_args.kwargs["inviter"] == AgentInviter(
        kind="agent", subject="manager"
    )


async def test_gateway_add_uses_the_logged_in_person_even_for_admins(monkeypatch):
    monkeypatch.setattr(rooms, "_require_room_released", AsyncMock())
    service = SimpleNamespace(
        add_agents_to_room=AsyncMock(side_effect=AgentInviteDenied("Ask its owner"))
    )
    with pytest.raises(HTTPException) as error:
        await rooms.post_room_agents(
            "room",
            RoomAgentsRequest(agent_ids=["worker"]),
            session=SimpleNamespace(),
            room_service=service,
            room_store=None,
            bridge_store=None,
            external_user_store=None,
            protocol=None,
            decisions=None,
            user=SimpleNamespace(id="admin-user"),
            is_admin=True,
        )
    assert error.value.status_code == 403
    assert service.add_agents_to_room.await_args.kwargs["inviter"] == AgentInviter(
        kind="user", subject="admin-user"
    )


async def test_gateway_creation_forwards_the_person_and_returns_a_clear_refusal():
    service = SimpleNamespace(
        create_room=AsyncMock(side_effect=AgentInviteDenied("Ask its owner"))
    )
    with pytest.raises(HTTPException) as error:
        await rooms.create_room(
            RoomCreateRequest(name="room", description="", agent_ids=["worker"]),
            session=SimpleNamespace(),
            room_service=service,
            room_store=None,
            bridge_store=None,
            external_user_store=None,
            protocol=None,
            decisions=None,
            user=SimpleNamespace(id="person"),
            is_admin=False,
        )
    assert error.value.status_code == 403
    config = service.create_room.await_args.args[0]
    assert config.acting_user_id == config.created_by == "person"


@pytest.mark.parametrize("inviter", [None, "UINVITER"])
async def test_platform_joins_keep_the_reported_identity_or_explicitly_mark_it_unknown(
    inviter,
):
    service = SimpleNamespace(add_agents_to_room=AsyncMock())
    core = SimpleNamespace(
        _session_factory=session,
        _agent_store=SimpleNamespace(
            get_by_name=AsyncMock(return_value=SimpleNamespace(id="agent"))
        ),
        _channel_to_room={"channel": ("room", "!room:test")},
        _room_service=service,
        _bridge_id="bridge",
    )
    await CollaborationCore._handle_agent_joined_channel_locked(
        core,
        InboundAgentJoin(
            channel_id="channel",
            channel_type="channel_private",
            agent_name="worker",
            inviter_id=inviter,
        ),
    )
    assert service.add_agents_to_room.await_args.kwargs["inviter"] == AgentInviter(
        kind="platform", subject=inviter, bridge_id="bridge"
    )


async def test_unknown_join_notices_are_system_messages_not_agent_instructions():
    admin = SimpleNamespace(send_message=AsyncMock(return_value="event"))
    service = SimpleNamespace(
        _client_lifecycle=SimpleNamespace(get_by_type=lambda *args: [admin])
    )
    destination = SimpleNamespace(tenant_id="tenant", transport_room_id="!room:test")
    await RoomService.post_invite_notice(
        service, destination, "Who invited the agent is unknown"
    )
    kw = admin.send_message.await_args.kwargs
    assert kw["extra_content"][ADMIN_MARKER] == {"type": "invite_notice"}
    assert kw["metered"] is False
    admin.send_message.return_value = None
    with pytest.raises(RuntimeError, match="could not be posted"):
        await RoomService.post_invite_notice(service, destination, "Warning")
