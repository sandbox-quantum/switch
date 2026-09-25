"""Behavioural tests for the create_room_from_yaml operation.

The full operation path: YAML in, room or group provisioned as the calling
agent's owner, with the error cases for missing inputs and an ownerless agent.
Same FakeRoomService pattern as test_rooms_yaml.py: real PostgreSQL, no Matrix.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from typing import Any

import pytest
import yaml
from sqlalchemy import select

from switch_core.addressing import owner_only_policy
from switch_core.agent_runs import RunRefused
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
    User,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_store import RoomStore

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


async def _call(
    agent_id: str, session_key: str | None = None, **kwargs: Any
) -> dict[str, Any]:
    token = set_call_context(
        CallContext(agent_id=agent_id, session_key=session_key, session=None)
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


HANDOFF_YAML = """\
version: 0
room:
  name: "Handoff Room"
  description: "Alice hands the brief to Bob"
  agents: ["claude-code.alice", "claude-code.bob"]
kickoff: "@claude-code.bob start on the brief."
"""


async def _person_room(env: dict[str, Any], name: str = "lobby") -> str:
    """A room a person made, where a run starts."""
    async with env["session_factory"]() as session:
        room = Room(
            matrix_room_id=f"!{uuid.uuid4().hex}:test.local",
            name=name,
            description="",
            channel_type="channel_public",
            created_by=env["user_id"],
            owner_id=env["user_id"],
        )
        session.add(room)
        await session.commit()
        return room.id


def _working_in(env: dict[str, Any], room_id: str) -> str:
    """A session key whose connection is in `room_id`, as a woken agent's is."""
    key = f"s-{room_id}"
    env["protocol"].connections[key] = SimpleNamespace(rooms={room_id})
    return key


async def _room(env: dict[str, Any], room_id: str) -> Room:
    async with env["session_factory"]() as session:
        room = await session.get(Room, room_id)
    assert room is not None
    return room


@pytest.mark.asyncio
async def test_kickoff_speaks_for_the_agent_and_names_its_owner(env):
    result = await _call(env["agent_id"], yaml=KICKOFF_YAML)

    assert result["failed_attachments"] == []
    sent = env["admin"].sent
    assert [m["body"] for m in sent][-1] == "Start on the brief."
    # The kickoff speaks for the agent that created the room, so the agents
    # it mentions wake only if their addressing admits that agent.
    assert {(m["on_behalf_of"].name, m["on_behalf_of"].agent_id) for m in sent} == {
        ("claude-code.alice", env["agent_id"])
    }
    # Named without a mention, which would wake the agent in its own room.
    assert sent[0]["body"] == "Kickoff from claude-code.alice, alice's agent"


@pytest.mark.asyncio
async def test_rooms_record_their_place_in_the_run(env):
    lobby = await _person_room(env)
    first = await _call(
        env["agent_id"], session_key=_working_in(env, lobby), yaml=KICKOFF_YAML
    )
    second = await _call(
        env["agent_id"],
        session_key=_working_in(env, first["room_id"]),
        yaml=SINGLE_ROOM_YAML,
    )

    room = await _room(env, first["room_id"])
    assert room.created_by_agent_id == env["agent_id"]
    assert room.created_by == env["user_id"]
    # Made from an ordinary room a person made, so it roots a run of its own.
    assert (room.parent_room_id, room.run_id) == (lobby, None)
    assert room.kickoff_hash is not None
    deeper = await _room(env, second["room_id"])
    assert (deeper.parent_room_id, deeper.run_id) == (
        first["room_id"],
        first["room_id"],
    )
    assert deeper.kickoff_hash is None


@pytest.mark.asyncio
async def test_an_agent_in_no_room_starts_a_run_of_its_own(env):
    result = await _call(env["agent_id"], yaml=SINGLE_ROOM_YAML)

    room = await _room(env, result["room_id"])
    assert (room.parent_room_id, room.run_id) == (None, None)


@pytest.mark.asyncio
async def test_kickoff_carries_the_run_so_far(env):
    lobby = await _person_room(env)
    first = await _call(
        env["agent_id"], session_key=_working_in(env, lobby), yaml=SINGLE_ROOM_YAML
    )

    await _call(
        env["agent_id"],
        session_key=_working_in(env, first["room_id"]),
        yaml=KICKOFF_YAML,
    )

    body = env["admin"].sent[-1]["body"]
    assert body.startswith("Start on the brief.")
    assert "part of a run that started in lobby" in body
    assert "1. lobby (a person's room)" in body
    assert "2. Test Room (created by claude-code.alice): A test room" in body
    assert "3. this room (created by claude-code.alice)" in body
    assert "repeat a step that already ran" in body


@pytest.mark.asyncio
async def test_the_same_kickoff_again_on_one_path_pauses_the_run(env):
    lobby = await _person_room(env)
    first = await _call(
        env["agent_id"], session_key=_working_in(env, lobby), yaml=KICKOFF_YAML
    )
    inside = _working_in(env, first["room_id"])

    with pytest.raises(RunRefused, match="the run is paused"):
        await _call(env["agent_id"], session_key=inside, yaml=KICKOFF_YAML)

    root = await _room(env, first["room_id"])
    assert root.run_control is not None
    assert root.run_control["state"] == "paused"
    assert root.run_control["repeat_of"] == first["room_id"]
    async with env["session_factory"]() as session:
        count = len((await session.execute(select(Room))).scalars().all())
    assert count == 2
    # The room the agent was working in says why, without waking anyone.
    assert "Paused this run" in env["admin"].notices[-1]["body"]
    # Nothing else is created in the run while it is paused.
    with pytest.raises(RunRefused, match="this run is paused"):
        await _call(env["agent_id"], session_key=inside, yaml=SINGLE_ROOM_YAML)


@pytest.mark.asyncio
async def test_continue_wakes_the_agent_where_it_paused_and_allows_one_more_round(
    env,
):
    lobby = await _person_room(env)
    first = await _call(
        env["agent_id"], session_key=_working_in(env, lobby), yaml=KICKOFF_YAML
    )
    with pytest.raises(RunRefused):
        await _call(
            env["agent_id"],
            session_key=_working_in(env, first["room_id"]),
            yaml=KICKOFF_YAML,
        )
    runs = env["protocol"].run_service()
    await runs.set_state(
        first["room_id"], "running", user_id=env["user_id"], user_name="alice"
    )

    # The agent is addressed with the authority of whoever let it continue,
    # so it picks the sequence back up without being asked again.
    wake = env["admin"].sent[-1]
    assert wake["body"].startswith("@claude-code.alice alice let this run continue")
    assert (wake["on_behalf_of"].user_id, wake["on_behalf_of"].agent_id) == (
        env["user_id"],
        None,
    )
    again = await _call(
        env["agent_id"],
        session_key=_working_in(env, first["room_id"]),
        yaml=KICKOFF_YAML,
    )
    with pytest.raises(RunRefused, match="the run is paused"):
        await _call(
            env["agent_id"],
            session_key=_working_in(env, again["room_id"]),
            yaml=KICKOFF_YAML,
        )


@pytest.mark.asyncio
async def test_a_kickoff_copied_with_its_run_history_is_still_a_repeat(env):
    lobby = await _person_room(env)
    first = await _call(
        env["agent_id"], session_key=_working_in(env, lobby), yaml=KICKOFF_YAML
    )
    # What the woken agent read: the kickoff with the run so far appended.
    received = env["admin"].sent[-1]["body"]
    assert "This room is part of a run" in received
    copied = yaml.safe_dump(
        {
            **yaml.safe_load(KICKOFF_YAML),
            "kickoff": received,
        }
    )

    with pytest.raises(RunRefused, match="the run is paused"):
        await _call(
            env["agent_id"],
            session_key=_working_in(env, first["room_id"]),
            yaml=copied,
        )


@pytest.mark.asyncio
async def test_a_new_step_on_the_same_path_is_not_a_repeat(env):
    lobby = await _person_room(env)
    first = await _call(
        env["agent_id"], session_key=_working_in(env, lobby), yaml=KICKOFF_YAML
    )

    await _call(
        env["agent_id"],
        session_key=_working_in(env, first["room_id"]),
        yaml=KICKOFF_YAML.replace("Start on the brief.", "Now grow the trees."),
    )

    assert (await _room(env, first["room_id"])).run_control is None


@pytest.mark.asyncio
async def test_a_stopped_run_refuses_rooms_and_says_so_in_each(env):
    lobby = await _person_room(env)
    first = await _call(
        env["agent_id"], session_key=_working_in(env, lobby), yaml=SINGLE_ROOM_YAML
    )
    runs = env["protocol"].run_service()
    await runs.set_state(
        first["room_id"], "stopped", user_id=env["user_id"], user_name="alice"
    )

    with pytest.raises(RunRefused, match="stopped by alice"):
        await _call(
            env["agent_id"],
            session_key=_working_in(env, first["room_id"]),
            yaml=SINGLE_ROOM_YAML,
        )
    noted = {n["room"] for n in env["admin"].notices}
    assert noted == {(await _room(env, first["room_id"])).matrix_room_id}
    with pytest.raises(RunRefused, match="already stopped"):
        await runs.set_state(
            first["room_id"], "running", user_id=env["user_id"], user_name="alice"
        )
    # The lobby it started from is not part of the run, so agents can still
    # create rooms from it.
    await _call(
        env["agent_id"], session_key=_working_in(env, lobby), yaml=SINGLE_ROOM_YAML
    )


@pytest.mark.asyncio
async def test_kickoff_to_an_agent_that_would_ignore_it_creates_nothing(env):
    async with env["session_factory"]() as session:
        bob = await AgentStore().get_by_name(session, "claude-code.bob")
        assert bob is not None
        bob.addressing_policy = owner_only_policy([]).model_dump()
        await session.commit()

    with pytest.raises(RunRefused, match="mentions claude-code.bob"):
        await _call(env["agent_id"], yaml=HANDOFF_YAML)

    async with env["session_factory"]() as session:
        assert (await session.execute(select(Room))).scalars().all() == []
    assert env["admin"].sent == []


@pytest.mark.asyncio
async def test_kickoff_to_an_agent_that_admits_its_owners_agents_goes_ahead(env):
    async with env["session_factory"]() as session:
        bob = await AgentStore().get_by_name(session, "claude-code.bob")
        assert bob is not None
        bob.addressing_policy = {
            "rules": [{"users": [], "agents": [], "owner": True, "owner_agents": True}]
        }
        await session.commit()

    result = await _call(env["agent_id"], yaml=HANDOFF_YAML)

    assert result["failed_attachments"] == []


@pytest.mark.asyncio
async def test_one_room_at_a_time(env):
    runs = env["protocol"].run_service()
    async with runs._one_at_a_time(env["agent_id"]):
        with pytest.raises(RunRefused, match="already creating a room"):
            await _call(env["agent_id"], yaml=SINGLE_ROOM_YAML)
    # Released with the creation that held it.
    await _call(env["agent_id"], yaml=SINGLE_ROOM_YAML)


@pytest.mark.asyncio
async def test_who_may_control_a_run(env):
    lobby = await _person_room(env)
    made = await _call(
        env["agent_id"], session_key=_working_in(env, lobby), yaml=SINGLE_ROOM_YAML
    )
    root = made["room_id"]
    async with env["session_factory"]() as session:
        stranger = User(name="mallory", email="m@example.com", role="member")
        session.add(stranger)
        await session.flush()
        runs = env["protocol"].run_service()
        assert await runs.may_control(
            session, root, user_id=env["user_id"], is_admin=False
        )
        assert not await runs.may_control(
            session, root, user_id=stranger.id, is_admin=False
        )
        assert await runs.may_control(session, root, user_id=stranger.id, is_admin=True)
        roots = await RoomStore().recent_run_roots(
            session, user_id=env["user_id"], limit=20
        )
        assert roots == [root]
        assert (
            await RoomStore().recent_run_roots(session, user_id=stranger.id, limit=20)
            == []
        )


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
