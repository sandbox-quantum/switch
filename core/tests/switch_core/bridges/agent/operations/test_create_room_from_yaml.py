"""Behavioural tests for the create_room_from_yaml operation.

The full operation path: YAML in, room or group provisioned as the calling
agent's owner, with the error cases for missing inputs and an ownerless agent.
Same FakeRoomService pattern as test_rooms_yaml.py: real PostgreSQL, no Matrix.
"""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import select

from switch_core.bridges.agent.operations.callctx import (
    CallContext,
    reset_call_context,
    set_call_context,
)
from switch_core.bridges.agent.operations.definitions import create_room_from_yaml
from switch_core.db.models import (
    Room,
    RoomGroup,
    RoomLink,
)

SINGLE_ROOM_YAML = """\
version: 0
room:
  name: "Test Room"
  description: "A test room"
  agents: ["claude-code.alice"]
"""

PARAMETERIZED_YAML = """\
version: 0
params:
  project:
    type: string
room:
  name: "{project} room"
  description: "Room for {project}, made by {$creator}"
  agents: ["claude-code.alice"]
"""

GROUP_YAML = """\
version: 0
params:
  team:
    type: string
group:
  name: "{team} group"
rooms:
  - name: "{team} main"
    description: "Main room"
    agents: ["claude-code.alice"]
  - name: "{team} support"
    description: "Support room"
    agents: ["claude-code.bob"]
links:
  - from: "{team} main"
    to: "{team} support"
    label: support
"""


async def _call(agent_id: str, **kwargs: Any) -> dict[str, Any]:
    token = set_call_context(
        CallContext(agent_id=agent_id, session_key=None, session=None)
    )
    try:
        return await create_room_from_yaml(**kwargs)
    finally:
        reset_call_context(token)


@pytest.mark.asyncio
async def test_single_room_provisioned(env):
    result = await _call(env["agent_id"], yaml=SINGLE_ROOM_YAML)
    assert result["room_name"] == "Test Room"
    async with env["session_factory"]() as session:
        room = await session.get(Room, result["room_id"])
        assert room is not None
        assert room.owner_id == env["user_id"]


@pytest.mark.asyncio
async def test_single_room_with_params_and_creator_builtin(env):
    result = await _call(
        env["agent_id"], yaml=PARAMETERIZED_YAML, inputs={"project": "Atlas"}
    )
    assert result["room_name"] == "Atlas room"
    async with env["session_factory"]() as session:
        room = await session.get(Room, result["room_id"])
        assert room is not None
        assert room.description == "Room for Atlas, made by alice"


@pytest.mark.asyncio
async def test_group_provisioned_with_links(env):
    result = await _call(env["agent_id"], yaml=GROUP_YAML, inputs={"team": "alpha"})
    assert result["group_name"] == "alpha group"
    assert {r["room_name"] for r in result["rooms"]} == {"alpha main", "alpha support"}
    assert result["errors"] == []
    async with env["session_factory"]() as session:
        group = await session.get(RoomGroup, result["group_id"])
        assert group is not None
        links = (await session.execute(select(RoomLink))).scalars().all()
        assert [link.label for link in links] == ["support"]


KICKOFF_YAML = """\
version: 0
room:
  name: "Kickoff Room"
  description: "A room with a kickoff"
  agents: ["claude-code.alice"]
kickoff: "Start on the brief."
"""


@pytest.mark.asyncio
async def test_kickoff_is_posted_on_behalf_of_the_agent(env):
    result = await _call(env["agent_id"], yaml=KICKOFF_YAML)

    assert result["failed_attachments"] == []
    sent = env["admin"].sent
    assert [m["body"] for m in sent][-1] == "Start on the brief."
    assert all(m["on_behalf_of"].agent_id == env["agent_id"] for m in sent)


@pytest.mark.asyncio
async def test_missing_required_input_creates_nothing(env):
    with pytest.raises(ValueError, match="project"):
        await _call(env["agent_id"], yaml=PARAMETERIZED_YAML)
    async with env["session_factory"]() as session:
        assert (await session.execute(select(Room))).scalars().all() == []


@pytest.mark.asyncio
async def test_ownerless_agent_cannot_provision(env):
    with pytest.raises(ValueError, match="no owner"):
        await _call(env["orphan_id"], yaml=SINGLE_ROOM_YAML)
