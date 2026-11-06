"""Adding an agent to a room asks whether the inviter may talk to it there.

`RoomService.add_agents_to_room` and `create_room` take the inviter and ask it
about every agent before anything is written, so a refused invite leaves no
membership and makes no call to the platform.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import (
    ANY,
    AddressingPolicy,
    AddressingRule,
    default_agent_policy,
    owner_only_policy,
)
from switch_core.db.models import Agent, ApiKey, Client, Room, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.delivery.addressing import AddressingDecision
from switch_core.room_invites import (
    AgentInviter,
    ChatInviter,
    InviteRefused,
    SystemInviter,
    UserInviter,
)
from switch_core.room_service import RoomCreateConfig, RoomService


class _Provisioning:
    def __init__(self) -> None:
        self.invited: list[str] = []

    async def invite_to_room(
        self, transport_room_id: str, transport_user_id: str
    ) -> None:
        self.invited.append(transport_user_id)


class _Clients:
    def __init__(self) -> None:
        self.by_agent: dict[str, Any] = {}

    def get_by_agent_id(self, agent_id: str) -> Any:
        return self.by_agent.get(agent_id)

    def get(self, client_id: str) -> Any:
        return None

    def get_by_type(self, client_type: str, tenant_id: str) -> list[Any]:
        return []


class _World:
    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        clients: _Clients,
        provisioning: _Provisioning,
    ) -> None:
        self.session_factory = session_factory
        self.clients = clients
        self.provisioning = provisioning
        self.room_id = ""
        self.users: dict[str, str] = {}
        self.agents: dict[str, Agent] = {}

    def service(self) -> RoomService:
        svc = object.__new__(RoomService)
        svc._session_factory = self.session_factory  # type: ignore[assignment]
        svc._room_store = RoomStore()  # type: ignore[assignment]
        svc._agent_store = AgentStore()  # type: ignore[assignment]
        svc._provisioning = self.provisioning  # type: ignore[assignment]
        svc._client_lifecycle = self.clients  # type: ignore[assignment]
        svc._collab_lifecycle = _Clients()  # type: ignore[assignment]
        svc._room_cache = SimpleNamespace(  # type: ignore[assignment]
            invalidate=lambda tenant_id, room_id: None
        )
        return svc

    async def members(self) -> list[str]:
        async with self.session_factory() as session:
            return await RoomStore().get_agent_ids(session, self.room_id)

    async def add_agent(
        self,
        name: str,
        *,
        owner: str,
        policy: AddressingPolicy | None,
        parent: str | None = None,
        can_manage_agents: bool = False,
    ) -> Agent:
        async with self.session_factory() as session:
            key = ApiKey(
                user_id=self.users[owner],
                key_hash=f"hash-{name}",
                encrypted_key="enc",
                label=name,
                type="agent",
            )
            client = Client(
                transport_user_id=f"@{name}:test", display_name=name, type="agent"
            )
            session.add_all([key, client])
            await session.flush()
            agent = Agent(
                name=name,
                description="d",
                agent_type="session_addressable",
                connector_type="claude_code",
                integration_profile={},
                client_id=client.id,
                api_key_id=key.id,
                owner_id=self.users[owner],
                addressing_policy=policy.model_dump() if policy else None,
                parent_agent_id=self.agents[parent].id if parent else None,
                can_manage_agents=can_manage_agents,
            )
            session.add(agent)
            await session.flush()
            await session.commit()
            self.clients.by_agent[agent.id] = SimpleNamespace(
                client_id=client.id, transport_user_id=client.transport_user_id
            )
            self.agents[name] = agent
            return agent


@pytest_asyncio.fixture
async def world(
    session_factory: async_sessionmaker[AsyncSession],
) -> _World:
    world = _World(session_factory, _Clients(), _Provisioning())
    async with session_factory() as session:
        for name in ("owner", "stranger"):
            user = User(name=name, email=f"{name}@test", role="user", password_hash="x")
            session.add(user)
            await session.flush()
            world.users[name] = user.id
        room = Room(transport_room_id="!r:test", name="room", description="d")
        session.add(room)
        await session.flush()
        world.room_id = room.id
        await session.commit()
    return world


def _who(world: _World, name: str) -> str:
    return world.users[name]


class TestUsers:
    async def test_the_owner_may_add_their_owner_only_agent(
        self, world: _World
    ) -> None:
        agent = await world.add_agent(
            "mine", owner="owner", policy=owner_only_policy([])
        )

        await world.service().add_agents_to_room(
            world.room_id,
            agent_ids=[agent.id],
            invited_by=UserInviter(_who(world, "owner")),
        )

        assert await world.members() == [agent.id]
        assert world.provisioning.invited == ["@mine:test"]

    async def test_someone_else_may_not_and_nothing_is_written(
        self, world: _World
    ) -> None:
        agent = await world.add_agent(
            "mine", owner="owner", policy=owner_only_policy([])
        )

        with pytest.raises(InviteRefused) as refused:
            await world.service().add_agents_to_room(
                world.room_id,
                agent_ids=[agent.id],
                invited_by=UserInviter(_who(world, "stranger")),
            )

        assert [a.name for a in refused.value.agents] == ["mine"]
        assert "mine" in str(refused.value)
        assert "owner" in str(refused.value)
        assert await world.members() == []
        assert world.provisioning.invited == []

    async def test_an_open_agent_may_be_added_by_anyone(self, world: _World) -> None:
        agent = await world.add_agent("open", owner="owner", policy=None)

        await world.service().add_agents_to_room(
            world.room_id,
            agent_ids=[agent.id],
            invited_by=UserInviter(_who(world, "stranger")),
        )

        assert await world.members() == [agent.id]

    async def test_an_agent_that_admits_everyone_may_be_added_by_anyone(
        self, world: _World
    ) -> None:
        agent = await world.add_agent(
            "everyone",
            owner="owner",
            policy=AddressingPolicy(rules=[AddressingRule(users=ANY)]),
        )

        await world.service().add_agents_to_room(
            world.room_id,
            agent_ids=[agent.id],
            invited_by=UserInviter(_who(world, "stranger")),
        )

        assert await world.members() == [agent.id]

    async def test_a_rule_for_other_rooms_does_not_admit_this_one(
        self, world: _World
    ) -> None:
        agent = await world.add_agent(
            "elsewhere",
            owner="owner",
            policy=AddressingPolicy(rules=[AddressingRule(rooms=["another-room"])]),
        )

        with pytest.raises(InviteRefused):
            await world.service().add_agents_to_room(
                world.room_id,
                agent_ids=[agent.id],
                invited_by=UserInviter(_who(world, "owner")),
            )

    async def test_the_system_may_add_any_agent(self, world: _World) -> None:
        agent = await world.add_agent(
            "mine", owner="owner", policy=owner_only_policy([])
        )

        await world.service().add_agents_to_room(
            world.room_id,
            agent_ids=[agent.id],
            invited_by=SystemInviter("test"),
        )

        assert await world.members() == [agent.id]


class TestSeveralAgents:
    async def test_one_refusal_adds_none_and_names_only_the_refused(
        self, world: _World
    ) -> None:
        open_agent = await world.add_agent("open", owner="owner", policy=None)
        closed = await world.add_agent(
            "closed", owner="owner", policy=owner_only_policy([])
        )

        with pytest.raises(InviteRefused) as refused:
            await world.service().add_agents_to_room(
                world.room_id,
                agent_ids=[open_agent.id, closed.id],
                invited_by=UserInviter(_who(world, "stranger")),
            )

        assert [a.name for a in refused.value.agents] == ["closed"]
        assert "open" not in str(refused.value)
        assert await world.members() == []

    async def test_an_agent_already_in_the_room_is_not_asked_about_or_removed(
        self, world: _World
    ) -> None:
        agent = await world.add_agent(
            "mine", owner="owner", policy=owner_only_policy([])
        )
        svc = world.service()
        await svc.add_agents_to_room(
            world.room_id, agent_ids=[agent.id], invited_by=SystemInviter("test")
        )

        await svc.add_agents_to_room(
            world.room_id,
            agent_ids=[agent.id],
            invited_by=UserInviter(_who(world, "stranger")),
        )

        assert await world.members() == [agent.id]

    async def test_the_subagents_added_with_an_agent_are_asked_about_too(
        self, world: _World
    ) -> None:
        parent = await world.add_agent("parent", owner="owner", policy=None)
        child = await world.add_agent(
            "child", owner="owner", policy=owner_only_policy([]), parent="parent"
        )

        with pytest.raises(InviteRefused) as refused:
            await world.service().add_agents_to_room(
                world.room_id,
                agent_ids=[parent.id],
                include_subagents_for=[parent.id],
                invited_by=UserInviter(_who(world, "stranger")),
            )

        assert [a.id for a in refused.value.agents] == [child.id]
        assert await world.members() == []


class TestAgents:
    async def test_an_owners_agent_may_add_another_of_the_same_owner_by_default(
        self, world: _World
    ) -> None:
        manager = await world.add_agent(
            "manager", owner="owner", policy=default_agent_policy()
        )
        worker = await world.add_agent(
            "worker", owner="owner", policy=default_agent_policy()
        )

        await world.service().add_agents_to_room(
            world.room_id,
            agent_ids=[worker.id],
            invited_by=AgentInviter(manager.id, manager.owner_id, False),
        )

        assert await world.members() == [worker.id]

    async def test_another_owners_agent_may_not(self, world: _World) -> None:
        theirs = await world.add_agent(
            "theirs", owner="stranger", policy=default_agent_policy()
        )
        mine = await world.add_agent(
            "mine", owner="owner", policy=default_agent_policy()
        )

        with pytest.raises(InviteRefused):
            await world.service().add_agents_to_room(
                world.room_id,
                agent_ids=[mine.id],
                invited_by=AgentInviter(theirs.id, theirs.owner_id, False),
            )

        assert await world.members() == []

    async def test_an_agent_the_policy_names_may(self, world: _World) -> None:
        theirs = await world.add_agent(
            "theirs", owner="stranger", policy=default_agent_policy()
        )
        mine = await world.add_agent(
            "mine", owner="owner", policy=owner_only_policy([theirs.id])
        )

        await world.service().add_agents_to_room(
            world.room_id,
            agent_ids=[mine.id],
            invited_by=AgentInviter(theirs.id, theirs.owner_id, False),
        )

        assert await world.members() == [mine.id]

    async def test_an_agent_that_manages_agents_for_the_owner_may(
        self, world: _World
    ) -> None:
        manager = await world.add_agent(
            "manager",
            owner="owner",
            policy=owner_only_policy([]),
            can_manage_agents=True,
        )
        worker = await world.add_agent(
            "worker", owner="owner", policy=owner_only_policy([])
        )

        await world.service().add_agents_to_room(
            world.room_id,
            agent_ids=[worker.id],
            invited_by=AgentInviter(manager.id, manager.owner_id, True),
        )

        assert await world.members() == [worker.id]

    async def test_managing_agents_for_someone_else_is_no_help(
        self, world: _World
    ) -> None:
        manager = await world.add_agent(
            "manager",
            owner="stranger",
            policy=owner_only_policy([]),
            can_manage_agents=True,
        )
        worker = await world.add_agent(
            "worker", owner="owner", policy=owner_only_policy([])
        )

        with pytest.raises(InviteRefused):
            await world.service().add_agents_to_room(
                world.room_id,
                agent_ids=[worker.id],
                invited_by=AgentInviter(manager.id, manager.owner_id, True),
            )


class _Resolver:
    def __init__(self, allowed: bool) -> None:
        self.allowed = allowed
        self.asked: list[dict[str, Any]] = []

    async def permitted(self, session: Any, **kw: Any) -> AddressingDecision:
        self.asked.append(kw)
        return AddressingDecision(allowed=self.allowed, refusal="no")


class TestChatSender:
    async def test_is_judged_as_the_sender_addressing_the_agent_in_that_room(
        self, world: _World
    ) -> None:
        agent = await world.add_agent(
            "mine", owner="owner", policy=owner_only_policy([])
        )
        resolver = _Resolver(allowed=True)

        await world.service().add_agents_to_room(
            world.room_id,
            agent_ids=[agent.id],
            invited_by=ChatInviter(resolver, "@alice:test"),  # type: ignore[arg-type]
        )

        assert await world.members() == [agent.id]
        assert len(resolver.asked) == 1
        assert resolver.asked[0]["sender"] == "@alice:test"
        assert resolver.asked[0]["room_id"] == world.room_id
        assert resolver.asked[0]["agent"].id == agent.id

    async def test_a_sender_the_resolver_refuses_adds_nothing(
        self, world: _World
    ) -> None:
        agent = await world.add_agent(
            "mine", owner="owner", policy=owner_only_policy([])
        )

        with pytest.raises(InviteRefused):
            await world.service().add_agents_to_room(
                world.room_id,
                agent_ids=[agent.id],
                invited_by=ChatInviter(_Resolver(allowed=False), "@mallory:test"),  # type: ignore[arg-type]
            )

        assert await world.members() == []
        assert world.provisioning.invited == []


class TestCreateRoom:
    async def test_a_room_is_not_made_around_an_agent_its_creator_may_not_add(
        self, world: _World
    ) -> None:
        agent = await world.add_agent(
            "mine", owner="owner", policy=owner_only_policy([])
        )
        svc = world.service()

        with pytest.raises(InviteRefused) as refused:
            await svc.create_room(
                RoomCreateConfig(
                    name="new",
                    description="d",
                    agent_names=[agent.name],
                    internal_only=True,
                ),
                invited_by=UserInviter(_who(world, "stranger")),
            )

        assert [a.name for a in refused.value.agents] == ["mine"]
        assert world.provisioning.invited == []


class TestRefusal:
    def test_names_who_to_ask_for_one_agent_and_for_several(self) -> None:
        one = InviteRefused([SimpleNamespace(name="a")])  # type: ignore[list-item]
        assert str(one) == (
            "Not permitted to add a to this room: it does not take instructions "
            "from you here. Ask its owner to add it, or to change who may talk "
            "to it."
        )
        several = InviteRefused(
            [SimpleNamespace(name="a"), SimpleNamespace(name="b")]  # type: ignore[list-item]
        )
        assert "a, b" in str(several)
        assert "Ask their owners" in str(several)

    def test_is_a_value_error_so_a_generic_handler_still_reports_it(self) -> None:
        assert issubclass(InviteRefused, ValueError)
