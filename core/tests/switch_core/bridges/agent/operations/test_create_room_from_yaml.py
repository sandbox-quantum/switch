"""Behavioural tests for the create_room_from_yaml operation.

The full operation path: YAML in, room or group provisioned as the calling
agent's owner, with the error cases for missing inputs and an ownerless agent.
Same FakeRoomService pattern as test_rooms_yaml.py: real PostgreSQL, no Matrix.
"""

from __future__ import annotations

import time
from typing import Any

import pytest
from sqlalchemy import select

from switch_core.addressing import owner_only_policy
from switch_core.bridges.agent.operations.callctx import (
    CallContext,
    reset_call_context,
    set_call_context,
)
from switch_core.bridges.agent.operations.definitions import create_room_from_yaml
from switch_core.db.models import (
    Agent,
    Room,
    RoomGroup,
    User,
)
from switch_core.room_invites import InviteRefused
from tests.switch_core.bridges.agent.operations.conftest import _make_agent
from tests.switch_core.test_template_yaml import alias_bomb

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
async def test_a_group_document_is_refused_and_makes_nothing(env):
    """An agent acts without its owner's admin reach, and only a workspace
    admin puts rooms in a group."""
    with pytest.raises(PermissionError, match="workspace admin"):
        await _call(env["agent_id"], yaml=GROUP_YAML, inputs={"team": "alpha"})
    async with env["session_factory"]() as session:
        assert (await session.execute(select(RoomGroup))).scalars().all() == []
        assert (await session.execute(select(Room))).scalars().all() == []


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
async def test_an_alias_bomb_is_refused_at_once_and_creates_nothing(env):
    started = time.monotonic()
    with pytest.raises(ValueError, match="anchors or aliases"):
        await _call(env["agent_id"], yaml=alias_bomb(depth=10, width=6))
    assert time.monotonic() - started < 1
    async with env["session_factory"]() as session:
        assert (await session.execute(select(Room))).scalars().all() == []


@pytest.mark.asyncio
async def test_ownerless_agent_cannot_provision(env):
    with pytest.raises(ValueError, match="no owner"):
        await _call(env["orphan_id"], yaml=SINGLE_ROOM_YAML)


@pytest.mark.asyncio
async def test_a_room_holding_an_agent_its_owner_may_not_address_is_refused(env):
    """The invite rule, judged as for `create_room`: as the calling agent's
    owner, who owns the room, or as the agent where the target trusts it."""
    async with env["session_factory"]() as session:
        mallory = User(name="mallory", email="m@example.com", role="member")
        session.add(mallory)
        await session.flush()
        private = await _make_agent(session, "mallorys-agent", mallory.id, mallory.id)
        private.addressing_policy = owner_only_policy([]).model_dump()
        await session.commit()
    document = SINGLE_ROOM_YAML.replace(
        '["claude-code.alice"]', '["claude-code.alice", "mallorys-agent"]'
    )

    with pytest.raises(InviteRefused, match="mallorys-agent"):
        await _call(env["agent_id"], yaml=document)
    async with env["session_factory"]() as session:
        assert (await session.execute(select(Room))).scalars().all() == []

    async with env["session_factory"]() as session:
        trusting = await session.get(Agent, private.id)
        assert trusting is not None
        trusting.addressing_policy = owner_only_policy([env["agent_id"]]).model_dump()
        await session.commit()
    result = await _call(env["agent_id"], yaml=document)
    assert result["room_name"] == "Test Room"
