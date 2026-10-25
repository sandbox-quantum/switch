"""Each way into a room says who is inviting, and turns a refusal into an answer.

`test_invites` decides the rule against real rows; these check the doors in
front of it: the agent's own tool (MCP and HTTP) and the gateway's room page
and room creation. Each must hand the right `Inviter` to the room service and
answer a refusal with a 403 carrying its sentence, not a 500 or a 400.
The chat command has its own tests in `test_commands_invite`.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException

from switch_core.bridges.agent.api.handlers import invite_agent
from switch_core.bridges.agent.api.schemas import InviteAgentRequest
from switch_core.bridges.agent.operations import context as op_context
from switch_core.bridges.agent.operations.callctx import (
    CallContext,
    reset_call_context,
    set_call_context,
)
from switch_core.bridges.agent.operations.definitions import invite_agent_to_room
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.gateway import rooms as gateway_rooms
from switch_core.gateway.schemas import RoomAgentsRequest, RoomCreateRequest
from switch_core.invites import Inviter, InviteRefused

_TARGET = SimpleNamespace(id="agent-private", name="private-helper", display_name=None)
_REFUSAL = InviteRefused(
    _TARGET,  # type: ignore[arg-type]
    "private-helper can only be added to a room by someone it takes instructions "
    "from, and its addressing policy doesn't include you. Ask its owner, Ada, to "
    "add it, or to change who it takes instructions from.",
)


class _RoomService:
    """Records who each call was made for; refuses when told to."""

    def __init__(self, refuse: bool) -> None:
        self.refuse = refuse
        self.inviters: list[Inviter] = []

    async def add_agents_to_room(
        self, room_id: str, *, invited_by: Inviter, **_: Any
    ) -> None:
        self.inviters.append(invited_by)
        if self.refuse:
            raise _REFUSAL

    async def create_room(self, config: Any, *, invited_by: Inviter) -> Any:
        self.inviters.append(invited_by)
        if self.refuse:
            raise _REFUSAL
        raise AssertionError("only the refusal is exercised here")


def _agent_core(room_service: _RoomService) -> AgentCore:
    @asynccontextmanager
    async def _session_factory():  # type: ignore[no-untyped-def]
        yield SimpleNamespace()

    async def _roster_change_allowed(_session, _agent_id, _room_id):  # type: ignore[no-untyped-def]
        return SimpleNamespace(id="room-1")

    core = object.__new__(AgentCore)
    core.session_factory = _session_factory  # type: ignore[assignment]
    core._require_room_roster_change = _roster_change_allowed  # type: ignore[method-assign]
    core.room_service = room_service  # type: ignore[assignment]
    return core


# ── The agent's own tool ─────────────────────────────────────────────────────


async def test_an_agent_invites_on_its_own_authority() -> None:
    service = _RoomService(refuse=False)
    await _agent_core(service).invite_agent_to_room(
        "agent-ada-bot", "room-1", "private-helper"
    )
    assert service.inviters == [Inviter.agent("agent-ada-bot")]


async def test_a_refusal_reaches_the_agent_as_a_permission_error() -> None:
    # Not folded into the "Failed to invite agent" ValueError: the agent gets
    # the sentence saying why and who can add it.
    with pytest.raises(InviteRefused) as refused:
        await _agent_core(_RoomService(refuse=True)).invite_agent_to_room(
            "agent-bo-bot", "room-1", "private-helper"
        )
    assert "Ask its owner, Ada," in str(refused.value)


async def test_the_mcp_tool_passes_the_refusal_on() -> None:
    old = op_context._protocol
    op_context.init_operations_protocol(_agent_core(_RoomService(refuse=True)))
    token = set_call_context(
        CallContext(agent_id="agent-bo-bot", session_key=None, session=None)
    )
    try:
        with pytest.raises(PermissionError, match="Ask its owner, Ada,"):
            await invite_agent_to_room(room_id="room-1", agent_name="private-helper")
    finally:
        reset_call_context(token)
        op_context._protocol = old


async def test_the_http_api_answers_403_with_the_reason() -> None:
    with pytest.raises(HTTPException) as answer:
        await invite_agent(
            agent_id="agent-bo-bot",
            room_id="room-1",
            req=InviteAgentRequest(agent_name="private-helper"),
            agent=SimpleNamespace(id="agent-bo-bot"),  # type: ignore[arg-type]
            protocol=_agent_core(_RoomService(refuse=True)),
        )
    assert answer.value.status_code == 403
    assert "Ask its owner, Ada," in answer.value.detail


# ── The gateway ──────────────────────────────────────────────────────────────

_BO = SimpleNamespace(id="user-bo", name="Bo")


async def test_the_room_page_invites_as_the_signed_in_person(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _may_write(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(gateway_rooms, "_require_room_released", _may_write)
    service = _RoomService(refuse=True)
    with pytest.raises(HTTPException) as answer:
        await gateway_rooms.post_room_agents(
            room_id="room-1",
            req=RoomAgentsRequest(agent_ids=["agent-private"]),
            session=None,  # type: ignore[arg-type]
            room_service=service,  # type: ignore[arg-type]
            room_store=None,  # type: ignore[arg-type]
            bridge_store=None,  # type: ignore[arg-type]
            external_user_store=None,  # type: ignore[arg-type]
            protocol=None,  # type: ignore[arg-type]
            user=_BO,  # type: ignore[arg-type]
            is_admin=False,
        )
    assert service.inviters == [Inviter.user("user-bo")]
    assert answer.value.status_code == 403
    assert "Ask its owner, Ada," in answer.value.detail


async def test_creating_a_room_with_agents_invites_as_the_signed_in_person() -> None:
    service = _RoomService(refuse=True)
    with pytest.raises(HTTPException) as answer:
        await gateway_rooms.create_room(
            req=RoomCreateRequest(
                name="r",
                description="d",
                channel_type="channel_public",
                agent_ids=["agent-private"],
                internal_only=True,
            ),
            session=None,  # type: ignore[arg-type]
            room_service=service,  # type: ignore[arg-type]
            room_store=None,  # type: ignore[arg-type]
            bridge_store=None,  # type: ignore[arg-type]
            external_user_store=None,  # type: ignore[arg-type]
            protocol=None,  # type: ignore[arg-type]
            user=_BO,  # type: ignore[arg-type]
        )
    assert service.inviters == [Inviter.user("user-bo")]
    assert answer.value.status_code == 403
    assert "Ask its owner, Ada," in answer.value.detail
