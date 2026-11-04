"""An agent's addressing policy decides who may put it in a room.

Against a real PostgreSQL, through `RoomService` — the one place every invite
path goes through, so what is pinned here is what each of those paths gets.
The per-path tests check that each door reaches this check and reports its
refusal; these check the answer itself.
"""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import (
    ANY,
    AddressingPolicy,
    AddressingRule,
    owner_and_owner_agents_policy,
    owner_only_policy,
)
from switch_core.db.models import Agent, ApiKey, Client, Room, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.invites import InviteNotPermitted, Inviter
from switch_core.room_service import RoomCreateConfig, RoomService


class _NoProvisioning:
    def __init__(self) -> None:
        self.invited: list[str] = []
        self.kicked: list[str] = []

    async def invite_to_room(
        self, transport_room_id: str, transport_user_id: str
    ) -> None:
        self.invited.append(transport_user_id)

    async def kick_user(self, transport_room_id: str, transport_user_id: str) -> None:
        self.kicked.append(transport_user_id)

    async def create_room(self, name: str, topic: str) -> str:
        return f"!{name}:test"


class _RunningClients:
    def __init__(self, by_agent: dict[str, object]) -> None:
        self._by_agent = by_agent
        self._by_id = {c.client_id: c for c in by_agent.values()}  # type: ignore[attr-defined]

    def get_by_agent_id(self, agent_id: str) -> object:
        return self._by_agent.get(agent_id)

    def get(self, client_id: str) -> object:
        return self._by_id.get(client_id)

    def get_by_type(self, client_type: str, tenant_id: str) -> list[object]:
        return []


class _RunningClient:
    def __init__(self, client_id: str, transport_user_id: str) -> None:
        self.client_id = client_id
        self.transport_user_id = transport_user_id


class _NoCache:
    def invalidate(self, tenant_id: str, room_id: str) -> None:
        return None


class _World:
    """A room, two people, and the agents they own."""

    def __init__(self) -> None:
        self.users: dict[str, str] = {}
        self.agents: dict[str, str] = {}
        self.room_id = ""
        self.running: dict[str, object] = {}


async def _world(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    agents_by_owner: dict[str, list[str]],
) -> _World:
    world = _World()
    async with session_factory() as session:
        for owner_name in agents_by_owner:
            user = User(
                name=owner_name,
                email=f"{owner_name}@test",
                role="user",
                password_hash="x",
            )
            session.add(user)
            await session.flush()
            world.users[owner_name] = user.id
        for owner_name, agent_names in agents_by_owner.items():
            for agent_name in agent_names:
                key = ApiKey(
                    user_id=world.users[owner_name],
                    key_hash=f"hash-{agent_name}",
                    encrypted_key="enc",
                    label=agent_name,
                    type="agent",
                )
                client = Client(
                    transport_user_id=f"@{agent_name}:test",
                    display_name=agent_name,
                    type="agent",
                )
                session.add_all([key, client])
                await session.flush()
                agent = Agent(
                    name=agent_name,
                    description="d",
                    agent_type="session_addressable",
                    connector_type="claude_code",
                    integration_profile={},
                    client_id=client.id,
                    api_key_id=key.id,
                    owner_id=world.users[owner_name],
                )
                session.add(agent)
                await session.flush()
                world.agents[agent_name] = agent.id
                world.running[agent.id] = _RunningClient(
                    client.id, client.transport_user_id
                )
        room = Room(transport_room_id="!work:test", name="work", description="d")
        session.add(room)
        await session.flush()
        world.room_id = room.id
        await session.commit()
    return world


def _service(
    session_factory: async_sessionmaker[AsyncSession], world: _World
) -> tuple[RoomService, _NoProvisioning]:
    provisioning = _NoProvisioning()
    svc = object.__new__(RoomService)
    svc._session_factory = session_factory  # type: ignore[assignment]
    svc._room_store = RoomStore()  # type: ignore[assignment]
    svc._agent_store = AgentStore()  # type: ignore[assignment]
    svc._provisioning = provisioning  # type: ignore[assignment]
    svc._client_lifecycle = _RunningClients(world.running)  # type: ignore[assignment]
    svc._collab_lifecycle = _RunningClients({})  # type: ignore[assignment]
    svc._room_cache = _NoCache()  # type: ignore[assignment]
    return svc, provisioning


async def _set_policy(
    session_factory: async_sessionmaker[AsyncSession],
    agent_id: str,
    policy: AddressingPolicy | None,
) -> None:
    async with session_factory() as session:
        agent = await session.get(Agent, agent_id)
        assert agent is not None
        agent.addressing_policy = policy.model_dump() if policy is not None else None
        await session.commit()


async def _agent_ids_in(
    session_factory: async_sessionmaker[AsyncSession], room_id: str
) -> list[str]:
    async with session_factory() as session:
        return await RoomStore().get_agent_ids(session, room_id)


class TestOwnerOnlyPolicy:
    async def test_the_owner_may_invite(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(session_factory, agents_by_owner={"alice": ["worker"]})
        await _set_policy(
            session_factory, world.agents["worker"], owner_only_policy([])
        )
        svc, _ = _service(session_factory, world)

        await svc.add_agents_to_room(
            world.room_id,
            agent_ids=[world.agents["worker"]],
            invited_by=Inviter.user(world.users["alice"]),
        )

        assert await _agent_ids_in(session_factory, world.room_id) == [
            world.agents["worker"]
        ]

    async def test_someone_else_is_refused_and_told_why(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(
            session_factory, agents_by_owner={"alice": ["worker"], "bob": []}
        )
        await _set_policy(
            session_factory, world.agents["worker"], owner_only_policy([])
        )
        svc, provisioning = _service(session_factory, world)

        with pytest.raises(InviteNotPermitted) as refused:
            await svc.add_agents_to_room(
                world.room_id,
                agent_ids=[world.agents["worker"]],
                invited_by=Inviter.user(world.users["bob"]),
            )

        message = str(refused.value)
        # What was refused, why, and who to ask.
        assert "worker" in message
        assert "restricts who can address it" in message
        assert "alice" in message
        assert await _agent_ids_in(session_factory, world.room_id) == []
        assert provisioning.invited == []

    async def test_the_owners_own_agent_is_refused_too(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # Owner-only means the person. An agent is not the person, even the
        # owner's own: `owner_only_policy([])` grants no agent at all.
        world = await _world(
            session_factory, agents_by_owner={"alice": ["worker", "manager"]}
        )
        await _set_policy(
            session_factory, world.agents["worker"], owner_only_policy([])
        )
        svc, _ = _service(session_factory, world)

        with pytest.raises(InviteNotPermitted):
            await svc.add_agents_to_room(
                world.room_id,
                agent_ids=[world.agents["worker"]],
                invited_by=Inviter.agent(world.agents["manager"], world.users["alice"]),
            )


class TestOwnerAndOwnerAgentsPolicy:
    async def test_the_owners_agent_may_invite(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(
            session_factory, agents_by_owner={"alice": ["worker", "manager"]}
        )
        await _set_policy(
            session_factory,
            world.agents["worker"],
            owner_and_owner_agents_policy(),
        )
        svc, _ = _service(session_factory, world)

        await svc.add_agents_to_room(
            world.room_id,
            agent_ids=[world.agents["worker"]],
            invited_by=Inviter.agent(world.agents["manager"], world.users["alice"]),
        )

        assert await _agent_ids_in(session_factory, world.room_id) == [
            world.agents["worker"]
        ]

    async def test_another_owners_agent_may_not(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(
            session_factory,
            agents_by_owner={"alice": ["worker"], "bob": ["intruder"]},
        )
        await _set_policy(
            session_factory,
            world.agents["worker"],
            owner_and_owner_agents_policy(),
        )
        svc, _ = _service(session_factory, world)

        with pytest.raises(InviteNotPermitted):
            await svc.add_agents_to_room(
                world.room_id,
                agent_ids=[world.agents["worker"]],
                invited_by=Inviter.agent(world.agents["intruder"], world.users["bob"]),
            )


class TestNamedAgentsPolicy:
    async def test_an_agent_named_by_id_may_invite(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(
            session_factory,
            agents_by_owner={"alice": ["worker"], "bob": ["dispatcher", "other"]},
        )
        await _set_policy(
            session_factory,
            world.agents["worker"],
            owner_only_policy([world.agents["dispatcher"]]),
        )
        svc, _ = _service(session_factory, world)

        await svc.add_agents_to_room(
            world.room_id,
            agent_ids=[world.agents["worker"]],
            invited_by=Inviter.agent(world.agents["dispatcher"], world.users["bob"]),
        )

        assert await _agent_ids_in(session_factory, world.room_id) == [
            world.agents["worker"]
        ]

    async def test_an_agent_not_named_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(
            session_factory,
            agents_by_owner={"alice": ["worker"], "bob": ["dispatcher", "other"]},
        )
        await _set_policy(
            session_factory,
            world.agents["worker"],
            owner_only_policy([world.agents["dispatcher"]]),
        )
        svc, _ = _service(session_factory, world)

        with pytest.raises(InviteNotPermitted):
            await svc.add_agents_to_room(
                world.room_id,
                agent_ids=[world.agents["worker"]],
                invited_by=Inviter.agent(world.agents["other"], world.users["bob"]),
            )


class TestOpenPolicy:
    async def test_anyone_may_invite_an_open_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(
            session_factory, agents_by_owner={"alice": ["worker"], "bob": []}
        )
        await _set_policy(session_factory, world.agents["worker"], None)
        svc, _ = _service(session_factory, world)

        await svc.add_agents_to_room(
            world.room_id,
            agent_ids=[world.agents["worker"]],
            invited_by=Inviter.user(world.users["bob"]),
        )

        assert await _agent_ids_in(session_factory, world.room_id) == [
            world.agents["worker"]
        ]

    async def test_a_room_scoped_rule_admits_only_that_room(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(
            session_factory, agents_by_owner={"alice": ["worker"], "bob": []}
        )
        await _set_policy(
            session_factory,
            world.agents["worker"],
            AddressingPolicy(
                rules=[
                    AddressingRule(
                        rooms=["some-other-room"], room_groups=ANY, users=ANY, agents=[]
                    )
                ]
            ),
        )
        svc, _ = _service(session_factory, world)

        with pytest.raises(InviteNotPermitted):
            await svc.add_agents_to_room(
                world.room_id,
                agent_ids=[world.agents["worker"]],
                invited_by=Inviter.user(world.users["bob"]),
            )


class TestExistingMembershipIsUntouched:
    async def test_tightening_a_policy_does_not_eject_an_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(
            session_factory, agents_by_owner={"alice": ["worker"], "bob": []}
        )
        await _set_policy(session_factory, world.agents["worker"], None)
        svc, provisioning = _service(session_factory, world)
        await svc.add_agents_to_room(
            world.room_id,
            agent_ids=[world.agents["worker"]],
            invited_by=Inviter.user(world.users["bob"]),
        )

        # The owner locks it down afterwards. Bob could not invite it now.
        await _set_policy(
            session_factory, world.agents["worker"], owner_only_policy([])
        )

        # Re-inviting it is a no-op, not a refusal: nothing is being added.
        await svc.add_agents_to_room(
            world.room_id,
            agent_ids=[world.agents["worker"]],
            invited_by=Inviter.user(world.users["bob"]),
        )

        assert await _agent_ids_in(session_factory, world.room_id) == [
            world.agents["worker"]
        ]
        assert provisioning.kicked == []

    async def test_a_refused_agent_does_not_take_a_permitted_one_with_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # The refusal is all-or-nothing, and it happens before anything is
        # written: a half-applied roster change is worse than none.
        world = await _world(
            session_factory,
            agents_by_owner={"alice": ["locked"], "bob": ["open-one"]},
        )
        await _set_policy(
            session_factory, world.agents["locked"], owner_only_policy([])
        )
        await _set_policy(session_factory, world.agents["open-one"], None)
        svc, _ = _service(session_factory, world)

        with pytest.raises(InviteNotPermitted):
            await svc.add_agents_to_room(
                world.room_id,
                agent_ids=[world.agents["open-one"], world.agents["locked"]],
                invited_by=Inviter.user(world.users["bob"]),
            )

        assert await _agent_ids_in(session_factory, world.room_id) == []


class TestSystemInvites:
    async def test_switch_machinery_is_not_judged(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(session_factory, agents_by_owner={"alice": ["worker"]})
        await _set_policy(
            session_factory, world.agents["worker"], owner_only_policy([])
        )
        svc, _ = _service(session_factory, world)

        await svc.add_agents_to_room(
            world.room_id,
            agent_ids=[world.agents["worker"]],
            invited_by=Inviter.system(),
        )

        assert await _agent_ids_in(session_factory, world.room_id) == [
            world.agents["worker"]
        ]


class TestRoomCreation:
    async def test_a_room_cannot_be_created_with_an_agent_you_may_not_invite(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(
            session_factory, agents_by_owner={"alice": ["worker"], "bob": []}
        )
        await _set_policy(
            session_factory, world.agents["worker"], owner_only_policy([])
        )
        svc, provisioning = _service(session_factory, world)

        with pytest.raises(InviteNotPermitted) as refused:
            await svc.create_room(
                RoomCreateConfig(
                    name="bobs-room",
                    description="",
                    agent_ids=[world.agents["worker"]],
                    internal_only=True,
                    created_by=world.users["bob"],
                    acting_user_id=world.users["bob"],
                    owner_id=world.users["bob"],
                    created_by_kind="user",
                )
            )

        assert "worker" in str(refused.value)
        # Nothing was provisioned: no room exists to clean up.
        assert provisioning.invited == []

    async def test_the_owner_can_create_a_room_with_their_own_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(session_factory, agents_by_owner={"alice": ["worker"]})
        await _set_policy(
            session_factory, world.agents["worker"], owner_only_policy([])
        )
        svc, _ = _service(session_factory, world)

        result = await svc.create_room(
            RoomCreateConfig(
                name="alices-room",
                description="",
                agent_ids=[world.agents["worker"]],
                internal_only=True,
                created_by=world.users["alice"],
                acting_user_id=world.users["alice"],
                owner_id=world.users["alice"],
                created_by_kind="user",
            )
        )

        assert await _agent_ids_in(session_factory, result.room.id) == [
            world.agents["worker"]
        ]

    async def test_an_agent_creating_a_room_is_judged_as_an_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(
            session_factory, agents_by_owner={"alice": ["worker", "manager"]}
        )
        await _set_policy(
            session_factory, world.agents["worker"], owner_only_policy([])
        )
        svc, _ = _service(session_factory, world)

        with pytest.raises(InviteNotPermitted):
            await svc.create_room(
                RoomCreateConfig(
                    name="managers-room",
                    description="",
                    agent_ids=[world.agents["worker"]],
                    internal_only=True,
                    created_by=world.users["alice"],
                    created_by_agent_id=world.agents["manager"],
                    owner_id=world.users["alice"],
                    created_by_kind="agent",
                )
            )
