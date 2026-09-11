"""Behavioral tests for the create_room_from_yaml operation (CHOO-2666).

Exercises the full operation path: YAML in → room/group provisioned, with
error cases for missing inputs and (separately) authorization. Uses the same
FakeRoomService pattern as test_rooms_yaml.py — real PostgreSQL, no Matrix.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from typing import Any

import pytest
import pytest_asyncio
from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.operations import context as op_context
from switch_core.bridges.agent.operations.callctx import (
    CallContext,
    reset_call_context,
    set_call_context,
)
from switch_core.bridges.agent.operations.definitions import create_room_from_yaml
from switch_core.bridges.resource.service import ResourceService
from switch_core.db.models import (
    Agent,
    ApiKey,
    Client,
    Room,
    RoomGroup,
    RoomLink,
    User,
    room_agents,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.reference_type_store import ReferenceTypeStore
from switch_core.db.stores.room_group_store import RoomGroupStore
from switch_core.db.stores.room_link_store import RoomLinkStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.room_service import RoomCreateConfig, RoomCreateResult


class FakeRoomService:
    """DB-only stand-in — same as test_rooms_yaml.py."""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        agent_store: AgentStore,
    ) -> None:
        self._sf = session_factory
        self._agents = agent_store

    async def create_room(self, config: RoomCreateConfig) -> RoomCreateResult:
        async with self._sf() as session:
            agent_ids: list[str] = []
            if config.agent_names:
                agents = await self._agents.get_by_names(session, config.agent_names)
                name_to_id = {a.name: a.id for a in agents}
                missing = [n for n in config.agent_names if n not in name_to_id]
                if missing:
                    raise ValueError(f"Unknown agents: {', '.join(missing)}")
                agent_ids = [name_to_id[n] for n in config.agent_names]

            room = Room(
                matrix_room_id=f"!{uuid.uuid4().hex}:test.local",
                name=config.name,
                description=config.description,
                channel_type=config.channel_type or "channel_public",
                bridge_id=config.bridge_id,
                instructions=config.instructions,
                created_by=config.created_by,
                owner_id=config.owner_id,
                read_visibility=config.read_visibility,
                write_visibility=config.write_visibility,
                group_id=config.group_id,
            )
            session.add(room)
            await session.flush()
            for aid in agent_ids:
                await session.execute(
                    insert(room_agents).values(room_id=room.id, agent_id=aid)
                )
            await session.commit()
            return RoomCreateResult(room=room, failed_attachments=[])


async def _make_agent(session: AsyncSession, name: str, user_id: str) -> Agent:
    api_key = ApiKey(
        user_id=user_id,
        key_hash=f"hash-{name}",
        encrypted_key="enc",
        label=name,
        type="agent",
    )
    client = Client(
        matrix_user_id=f"@{name}:test.local",
        display_name=name,
        type="agent",
    )
    session.add_all([api_key, client])
    await session.flush()
    agent = Agent(
        name=name,
        description=f"{name} desc",
        agent_type="always_on",
        connector_type="claude_code",
        integration_profile={"connection_model": "always_on"},
        client_id=client.id,
        api_key_id=api_key.id,
        owner_id=user_id,
    )
    session.add(agent)
    await session.flush()
    return agent


@pytest_asyncio.fixture
async def env(session_factory: async_sessionmaker[AsyncSession]):
    """Seed a user + agent and wire up a fake protocol for the operation."""
    agent_store = AgentStore()
    resource_service = ResourceService(
        reference_store=ReferenceStore(),
        reference_type_store=ReferenceTypeStore(),
        document_store=DocumentStore(),
        package_store=PackageStore(),
        room_link_store=RoomLinkStore(),
        session_factory=session_factory,
    )

    fake_protocol = SimpleNamespace(
        session_factory=session_factory,
        agent_store=agent_store,
        room_service=FakeRoomService(session_factory, agent_store),
        resource_service=resource_service,
        room_store=RoomStore(),
        bridge_store=CollaborationBridgeStore(),
        external_user_store=ExternalUserStore(),
        room_group_store=RoomGroupStore(),
        room_role_store=RoomRoleStore(),
    )

    async with session_factory() as session:
        user = User(name="alice", email="alice@example.com", role="member")
        session.add(user)
        await session.flush()
        user_id = user.id
        agent = await _make_agent(session, "claude-code.alice", user_id)
        await _make_agent(session, "claude-code.bob", user_id)
        await session.commit()
        agent_id = agent.id

    old_protocol = op_context._protocol
    op_context.init_operations_protocol(fake_protocol)  # type: ignore[arg-type]
    try:
        yield {
            "agent_id": agent_id,
            "user_id": user_id,
            "session_factory": session_factory,
        }
    finally:
        op_context._protocol = old_protocol


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
  description: "Room for {project}"
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

MISSING_REQUIRED_YAML = """\
version: 0
params:
  project:
    type: string
room:
  name: "{project} room"
  description: "Room for {project}"
  agents: ["claude-code.alice"]
"""


def _with_agent(env: dict[str, Any]):
    """Set call context for the agent and return a cleanup token."""
    return set_call_context(CallContext(agent_id=env["agent_id"], session_key=None))


@pytest.mark.asyncio
async def test_single_room_provisioned(env):
    """A minimal room: YAML → room created with the right name and agent."""
    token = _with_agent(env)
    try:
        result = await create_room_from_yaml(yaml=SINGLE_ROOM_YAML)
    finally:
        reset_call_context(token)

    assert result["room_name"] == "Test Room"
    assert result["room_id"]

    async with env["session_factory"]() as session:
        room = await session.get(Room, result["room_id"])
        assert room is not None
        assert room.name == "Test Room"


@pytest.mark.asyncio
async def test_single_room_with_params(env):
    """A parameterized template: inputs are interpolated into the room."""
    token = _with_agent(env)
    try:
        result = await create_room_from_yaml(
            yaml=PARAMETERIZED_YAML, inputs={"project": "Atlas"}
        )
    finally:
        reset_call_context(token)

    assert result["room_name"] == "Atlas room"


@pytest.mark.asyncio
async def test_group_provisioned_with_links(env):
    """A group template: rooms + links created."""
    token = _with_agent(env)
    try:
        result = await create_room_from_yaml(yaml=GROUP_YAML, inputs={"team": "alpha"})
    finally:
        reset_call_context(token)

    assert result["group_name"] == "alpha group"
    assert len(result["rooms"]) == 2
    room_names = {r["room_name"] for r in result["rooms"]}
    assert room_names == {"alpha main", "alpha support"}

    async with env["session_factory"]() as session:
        group = await session.get(RoomGroup, result["group_id"])
        assert group is not None
        assert group.name == "alpha group"

        links = (await session.execute(select(RoomLink))).scalars().all()
        assert len(links) == 1
        assert links[0].label == "support"


@pytest.mark.asyncio
async def test_missing_required_input_raises_nothing_created(env):
    """Missing a required param → ValueError, no room created."""
    token = _with_agent(env)
    try:
        with pytest.raises(ValueError, match="project"):
            await create_room_from_yaml(yaml=MISSING_REQUIRED_YAML)
    finally:
        reset_call_context(token)

    async with env["session_factory"]() as session:
        rooms = (await session.execute(select(Room))).scalars().all()
        assert len(rooms) == 0


@pytest.mark.asyncio
async def test_no_owner_raises(env):
    """An agent with no owner_id cannot provision."""
    sf = env["session_factory"]
    async with sf() as session:
        # Create an ownerless agent
        api_key = ApiKey(
            user_id=env["user_id"],
            key_hash="hash-orphan",
            encrypted_key="enc",
            label="orphan",
            type="agent",
        )
        client = Client(
            matrix_user_id="@orphan:test.local",
            display_name="orphan",
            type="agent",
        )
        session.add_all([api_key, client])
        await session.flush()
        agent = Agent(
            name="orphan",
            description="no owner",
            agent_type="always_on",
            connector_type="claude_code",
            integration_profile={"connection_model": "always_on"},
            client_id=client.id,
            api_key_id=api_key.id,
            owner_id=None,
        )
        session.add(agent)
        await session.flush()
        orphan_id = agent.id
        await session.commit()

    token = set_call_context(CallContext(agent_id=orphan_id, session_key=None))
    try:
        with pytest.raises(ValueError, match="no owner"):
            await create_room_from_yaml(yaml=SINGLE_ROOM_YAML)
    finally:
        reset_call_context(token)
