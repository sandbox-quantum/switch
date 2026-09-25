"""Behavioural tests for the create_room_from_yaml operation.

The full operation path: YAML in, room or group provisioned as the calling
agent's owner, with the error cases for missing inputs and an ownerless agent.
Same FakeRoomService pattern as test_rooms_yaml.py: real PostgreSQL, no Matrix.
"""

from __future__ import annotations

import uuid
from functools import partial
from types import SimpleNamespace
from typing import Any

import pytest
import pytest_asyncio
from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import owner_only_policy
from switch_core.agent_runs import RunRefused
from switch_core.bridges.agent.operations import context as op_context
from switch_core.bridges.agent.operations.callctx import (
    CallContext,
    reset_call_context,
    set_call_context,
)
from switch_core.bridges.agent.operations.definitions import create_room_from_yaml
from switch_core.bridges.agent.protocol.service import ProtocolService
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
                created_by_agent_id=config.created_by_agent_id,
                parent_room_id=config.parent_room_id,
                run_id=config.run_id,
                kickoff_hash=config.kickoff_hash,
                template_name=config.template_name,
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
        self.notices: list[dict[str, Any]] = []

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

    async def send_notice(self, room_id: str, body: str) -> None:
        self.notices.append({"room": room_id, "body": body})


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
        connections={},
    )
    # Runs are the real service's; only its collaborators are fakes.
    fake_protocol.run_service = partial(ProtocolService.run_service, fake_protocol)
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
            "protocol": fake_protocol,
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
    assert (room.parent_room_id, room.run_id) == (lobby, lobby)
    assert room.kickoff_hash is not None
    deeper = await _room(env, second["room_id"])
    assert (deeper.parent_room_id, deeper.run_id) == (first["room_id"], lobby)
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

    root = await _room(env, lobby)
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
async def test_continue_allows_one_more_round(env):
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
    await runs.set_state(lobby, "running", user_id=env["user_id"], user_name="alice")

    again = await _call(
        env["agent_id"],
        session_key=_working_in(env, first["room_id"]),
        yaml=KICKOFF_YAML,
    )
    assert "let this run continue" in env["admin"].notices[-1]["body"]
    with pytest.raises(RunRefused, match="the run is paused"):
        await _call(
            env["agent_id"],
            session_key=_working_in(env, again["room_id"]),
            yaml=KICKOFF_YAML,
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

    assert (await _room(env, lobby)).run_control is None


@pytest.mark.asyncio
async def test_a_stopped_run_refuses_rooms_and_says_so_in_each(env):
    lobby = await _person_room(env)
    first = await _call(
        env["agent_id"], session_key=_working_in(env, lobby), yaml=SINGLE_ROOM_YAML
    )
    runs = env["protocol"].run_service()
    await runs.set_state(lobby, "stopped", user_id=env["user_id"], user_name="alice")

    with pytest.raises(RunRefused, match="stopped by alice"):
        await _call(
            env["agent_id"],
            session_key=_working_in(env, first["room_id"]),
            yaml=SINGLE_ROOM_YAML,
        )
    noted = {n["room"] for n in env["admin"].notices}
    assert noted == {
        (await _room(env, lobby)).matrix_room_id,
        (await _room(env, first["room_id"])).matrix_room_id,
    }
    with pytest.raises(RunRefused, match="already stopped"):
        await runs.set_state(
            lobby, "running", user_id=env["user_id"], user_name="alice"
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
    await _call(
        env["agent_id"], session_key=_working_in(env, lobby), yaml=SINGLE_ROOM_YAML
    )
    async with env["session_factory"]() as session:
        stranger = User(name="mallory", email="m@example.com", role="member")
        session.add(stranger)
        await session.flush()
        runs = env["protocol"].run_service()
        assert await runs.may_control(
            session, lobby, user_id=env["user_id"], is_admin=False
        )
        assert not await runs.may_control(
            session, lobby, user_id=stranger.id, is_admin=False
        )
        assert await runs.may_control(
            session, lobby, user_id=stranger.id, is_admin=True
        )
        roots = await RoomStore().recent_run_roots(
            session, user_id=env["user_id"], limit=20
        )
        assert roots == [lobby]
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
