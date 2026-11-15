"""`create_room` says whether the calling agent ended up in the room: only
when it listed itself in `agent_names`."""

from __future__ import annotations

from typing import Any

import pytest

from switch_core.bridges.agent.operations.callctx import (
    CallContext,
    reset_call_context,
    set_call_context,
)
from switch_core.bridges.agent.operations.definitions import create_room
from switch_core.room_service import RoomCreateConfig, RoomCreateResult


@pytest.mark.asyncio
async def test_caller_is_member_follows_agent_names(env) -> None:
    protocol = env["protocol"]

    async def create_moderation_room(
        *, agent_id: str, name: str, description: str, agent_names: list[str], **_: Any
    ) -> RoomCreateResult:
        return await protocol.room_service.create_room(
            RoomCreateConfig(
                name=name, description=description, agent_names=agent_names
            )
        )

    protocol.create_moderation_room = create_moderation_room
    token = set_call_context(
        CallContext(agent_id=env["agent_id"], session_key=None, session=None)
    )
    try:
        joined = await create_room(
            name="with me", description="", agent_names=["claude-code.alice"]
        )
        others = await create_room(
            name="for bob", description="", agent_names=["claude-code.bob"]
        )
    finally:
        reset_call_context(token)
    assert joined["caller_is_member"] is True
    assert others["caller_is_member"] is False
