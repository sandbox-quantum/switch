"""`create_room` starts the room with auto-route and a triage agent when
asked, refuses a triage agent that is not among the room's agents, and says
in `warnings` when auto-route could not be turned on. Through a real
`RoomService` against real Postgres."""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import select

from switch_core.bridges.agent.operations.callctx import (
    CallContext,
    reset_call_context,
    set_call_context,
)
from switch_core.bridges.agent.operations.definitions import create_room
from switch_core.db.models import Agent, Room
from switch_core.db.stores.room_store import auto_route_fallback_in, auto_route_on_in
from switch_core.decision.settings import DecisionAvailability
from switch_core.room_service import RoomCreateConfig, RoomCreateResult
from tests.switch_core.test_room_service_auto_route import (
    _CLIENT_OF,
    AVAILABLE,
    _service,
)


async def _create(
    env: dict[str, Any], decisions: DecisionAvailability, **asked: Any
) -> dict[str, Any]:
    """`create_room` as the calling agent, its room made by a real
    `RoomService` from what the operation passed on."""
    factory = env["session_factory"]
    async with factory() as session:
        for agent in (await session.execute(select(Agent))).scalars():
            _CLIENT_OF[agent.id] = agent.client_id
    rooms, _ = _service(factory, decisions)

    async def create_moderation_room(**passed: Any) -> RoomCreateResult:
        return await rooms.create_room(
            RoomCreateConfig(
                name=passed["name"],
                description=passed["description"],
                agent_names=passed["agent_names"],
                internal_only=True,
                auto_route=passed["auto_route"],
                triage_agent=passed["triage_agent"],
            )
        )

    env["protocol"].create_moderation_room = create_moderation_room
    token = set_call_context(
        CallContext(agent_id=env["agent_id"], session_key=None, session=None)
    )
    try:
        return await create_room(
            name="ops",
            description="",
            agent_names=["claude-code.alice", "claude-code.bob"],
            **asked,
        )
    finally:
        reset_call_context(token)


async def _state(env: dict[str, Any], room_id: str) -> tuple[bool, str | None]:
    async with env["session_factory"]() as session:
        room = await session.get(Room, room_id)
        assert room is not None
        triage = auto_route_fallback_in(room.metadata_)
        name = (await session.get(Agent, triage)).name if triage else None
    return auto_route_on_in(room.metadata_), name


@pytest.mark.asyncio
async def test_auto_route_and_a_triage_agent_are_set_together(env) -> None:
    result = await _create(
        env, AVAILABLE, auto_route=True, triage_agent="claude-code.bob"
    )
    assert await _state(env, result["id"]) == (True, "claude-code.bob")
    assert result["warnings"] == []


@pytest.mark.asyncio
async def test_a_triage_agent_alone_waits_for_auto_route(env) -> None:
    result = await _create(env, AVAILABLE, triage_agent="claude-code.alice")
    assert await _state(env, result["id"]) == (False, "claude-code.alice")


@pytest.mark.asyncio
async def test_a_triage_agent_not_in_the_room_is_refused(env) -> None:
    with pytest.raises(ValueError, match="triage agent orphan is not one"):
        await _create(env, AVAILABLE, auto_route=True, triage_agent="orphan")
    async with env["session_factory"]() as session:
        assert (await session.execute(select(Room))).scalars().all() == []


@pytest.mark.asyncio
async def test_without_a_decision_service_the_room_is_made_and_a_warning_says_why(
    env,
) -> None:
    result = await _create(env, DecisionAvailability.off(), auto_route=True)
    assert await _state(env, result["id"]) == (False, None)
    (warning,) = result["warnings"]
    assert warning.startswith("The room was created with auto-route off: ")
