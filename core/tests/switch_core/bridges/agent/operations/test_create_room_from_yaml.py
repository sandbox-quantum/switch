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
from switch_core.clients.admin_client import AdminClient
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
from switch_core.db.stores.user_store import UserStore
from switch_core.room_service import RoomCreateConfig, RoomCreateResult
from switch_core.rooms_yaml import RoomYamlService


class FakeRoomService:
    """DB-only stand-in, the same as test_rooms_yaml.py's."""

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


async def _make_agent(
    session: AsyncSession, name: str, user_id: str, owner_id: str | None
) -> Agent:
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
        owner_id=owner_id,
    )
    session.add(agent)
    await session.flush()
    return agent


class RecordingAdminClient(AdminClient):
    """Records the platform messages a kickoff sends; has no transport."""

    def __init__(self) -> None:  # noqa: D107 - test double, no super().__init__
        self.sent: list[dict[str, Any]] = []

    async def wait_joined(self, room_id: str, timeout: float) -> bool:
        return True

    async def send_platform_message(  # type: ignore[override]
        self,
        room_id: str,
        body: str,
        *,
        thread_root_id=None,
        on_behalf_of=None,
        reply_in_channel=False,
    ) -> str | None:
        self.sent.append({"body": body, "on_behalf_of": on_behalf_of})
        return "$kickoff"


class FakeLifecycle:
    def __init__(self, admin: AdminClient) -> None:
        self.admin = admin

    def get_by_type(self, client_type: str, tenant_id: str) -> list[Any]:
        return [self.admin] if client_type == "admin" else []

    def get_by_agent_id(self, agent_id: str) -> None:
        return None


@pytest_asyncio.fixture
async def env(session_factory: async_sessionmaker[AsyncSession]):
    """Seed a user and two agents, and wire a fake protocol for the operation."""
    agent_store = AgentStore()
    resource_service = ResourceService(
        reference_store=ReferenceStore(),
        reference_type_store=ReferenceTypeStore(),
        document_store=DocumentStore(),
        package_store=PackageStore(),
        room_link_store=RoomLinkStore(),
        session_factory=session_factory,
    )
    admin = RecordingAdminClient()
    fake_protocol = SimpleNamespace(
        client_lifecycle=FakeLifecycle(admin),
        session_factory=session_factory,
        agent_store=agent_store,
        user_store=UserStore(),
        room_service=FakeRoomService(session_factory, agent_store),
        resource_service=resource_service,
        room_store=RoomStore(),
        bridge_store=CollaborationBridgeStore(),
        external_user_store=ExternalUserStore(),
        room_group_store=RoomGroupStore(),
        room_role_store=RoomRoleStore(),
    )
    # The same wiring `ProtocolService.room_yaml_service` does, over the fakes.
    fake_protocol.room_yaml_service = lambda: RoomYamlService(
        room_service=fake_protocol.room_service,
        resource_service=fake_protocol.resource_service,
        room_store=fake_protocol.room_store,
        agent_store=fake_protocol.agent_store,
        bridge_store=fake_protocol.bridge_store,
        external_user_store=fake_protocol.external_user_store,
        room_role_store=fake_protocol.room_role_store,
        session_factory=fake_protocol.session_factory,
        room_group_store=fake_protocol.room_group_store,
        client_lifecycle=fake_protocol.client_lifecycle,
    )

    async with session_factory() as session:
        user = User(name="alice", email="alice@example.com", role="member")
        session.add(user)
        await session.flush()
        user_id = user.id
        agent = await _make_agent(session, "claude-code.alice", user_id, user_id)
        await _make_agent(session, "claude-code.bob", user_id, user_id)
        orphan = await _make_agent(session, "orphan", user_id, None)
        await session.commit()
        agent_id = agent.id
        orphan_id = orphan.id

    old_protocol = op_context._protocol
    op_context.init_operations_protocol(fake_protocol)  # type: ignore[arg-type]
    try:
        yield {
            "agent_id": agent_id,
            "orphan_id": orphan_id,
            "user_id": user_id,
            "session_factory": session_factory,
            "admin": admin,
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
async def test_kickoff_is_posted_on_behalf_of_the_owner(env):
    result = await _call(env["agent_id"], yaml=KICKOFF_YAML)

    assert result["failed_attachments"] == []
    sent = env["admin"].sent
    assert [m["body"] for m in sent][-1] == "Start on the brief."
    assert all(m["on_behalf_of"].name == "alice" for m in sent)


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
