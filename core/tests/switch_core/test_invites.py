"""Who may put an agent into a room (#805), against a real database.

The gate judges an invite by the agent's addressing policy, as whoever is
inviting. These tests give an agent a policy and ask it, once per kind of
inviter, and then check `RoomService` acts on the answer: a refusal changes
nothing, and an agent already in a room is never judged."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import (
    AddressingPolicy,
    owner_and_owner_agents_policy,
    owner_only_policy,
)
from switch_core.db.models import Agent, ApiKey, Client, ExternalUser, Room, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.invites import (
    AgentInviter,
    ChatSender,
    InviteGate,
    InviteRefused,
    PlatformInviter,
    UserInviter,
    actor_kind,
)
from switch_core.room_service import RoomCreateConfig, RoomService
from tests.switch_core.delivery.world import World, make_world


@pytest.fixture
async def world(session_factory: async_sessionmaker[AsyncSession]) -> World:
    return await make_world(session_factory)


@pytest.fixture
def gate() -> InviteGate:
    return InviteGate.build(room_store=RoomStore(), agent_store=AgentStore())


async def _restrict(world: World, name: str, policy: AddressingPolicy | None) -> Agent:
    """Give `name` the policy (None is open) and return the stored agent."""
    await _restrict_agent(world, world.agents[name].id, policy)
    async with world.session_factory() as session:
        agent = await AgentStore().get(session, world.agents[name].id)
    assert agent is not None
    return agent


async def _stranger(world: World) -> User:
    async with world.session_factory() as session:
        user = User(
            name="stranger",
            email=f"stranger-{uuid.uuid4().hex[:8]}@test",
            role="user",
            password_hash="x",
        )
        session.add(user)
        await session.commit()
        return user


async def _foreign_agent(world: World, owner: User | None) -> Agent:
    """An agent that is not the world owner's, with no policy of its own."""
    tag = uuid.uuid4().hex[:8]
    async with world.session_factory() as session:
        if owner is None:
            owner = User(
                name="other", email=f"other-{tag}@test", role="user", password_hash="x"
            )
            session.add(owner)
            await session.flush()
        key = ApiKey(
            user_id=owner.id,
            key_hash=f"hash-{tag}",
            encrypted_key="enc",
            label="foreign",
            type="agent",
        )
        client = Client(
            transport_user_id=f"@foreign-{tag}:test", display_name="f", type="agent"
        )
        session.add_all([key, client])
        await session.flush()
        agent = Agent(
            name=f"foreign-{tag}",
            description="d",
            agent_type="session_addressable",
            connector_type="claude_code",
            integration_profile={"connection_model": "session_addressable"},
            client_id=client.id,
            api_key_id=key.id,
            owner_id=owner.id,
        )
        session.add(agent)
        await session.commit()
        return agent


async def _refused(
    world: World, gate: InviteGate, inviter: object, agent: Agent
) -> list[str]:
    async with world.session_factory() as session:
        return [
            a.name
            for a in await gate.refused(
                session,
                inviter,  # type: ignore[arg-type]
                [agent],
                room_id=world.room_id,
                group_id=None,
            )
        ]


class TestAnOpenAgent:
    async def test_anyone_may_invite_it(self, world: World, gate: InviteGate) -> None:
        agent = await _restrict(world, "helper", None)
        stranger = await _stranger(world)
        for inviter in (
            UserInviter(stranger.id),
            ChatSender("@nobody:test"),
            AgentInviter(world.agents["reviewer"].id),
            PlatformInviter("b", "unknown-account"),
        ):
            assert await _refused(world, gate, inviter, agent) == []


class TestAnOwnerOnlyAgent:
    async def test_its_owner_may_invite_it(
        self, world: World, gate: InviteGate
    ) -> None:
        agent = await _restrict(world, "helper", owner_only_policy([]))
        assert await _refused(world, gate, UserInviter(world.owner_id), agent) == []

    async def test_another_user_may_not(self, world: World, gate: InviteGate) -> None:
        agent = await _restrict(world, "helper", owner_only_policy([]))
        stranger = await _stranger(world)
        assert await _refused(world, gate, UserInviter(stranger.id), agent) == [
            "helper"
        ]

    async def test_the_refusal_says_why_and_who_can_invite(
        self, world: World, gate: InviteGate
    ) -> None:
        agent = await _restrict(world, "helper", owner_only_policy([]))
        stranger = await _stranger(world)
        async with world.session_factory() as session:
            with pytest.raises(InviteRefused) as raised:
                await gate.require(
                    session,
                    UserInviter(stranger.id),
                    [agent.id],
                    room_id=world.room_id,
                    group_id=None,
                )
        assert str(raised.value) == (
            "helper doesn't take instructions from you, so it wasn't added. "
            "Its owner (o) can invite it, or can change who it takes "
            "instructions from."
        )
        assert raised.value.agent_names == ["helper"]
        assert raised.value.agent_ids == [agent.id]
        assert isinstance(raised.value, PermissionError)

    async def test_an_agent_without_an_owner_points_to_an_admin(
        self, world: World, gate: InviteGate
    ) -> None:
        agent = await _restrict(world, "helper", owner_only_policy([]))
        async with world.session_factory() as session:
            await session.execute(
                update(Agent).where(Agent.id == agent.id).values(owner_id=None)
            )
            await session.commit()
            with pytest.raises(InviteRefused, match="Only an admin can change"):
                await gate.require(
                    session,
                    UserInviter(world.owner_id),
                    [agent.id],
                    room_id=world.room_id,
                    group_id=None,
                )

    async def test_someone_typing_a_command_is_judged_as_the_account_they_use(
        self, world: World, gate: InviteGate
    ) -> None:
        # alice's chat account is claimed by the owner; bob's is nobody's.
        agent = await _restrict(world, "helper", owner_only_policy([]))
        assert await _refused(world, gate, ChatSender(world.mxid("alice")), agent) == []
        assert await _refused(world, gate, ChatSender(world.mxid("bob")), agent) == [
            "helper"
        ]

    async def test_an_account_the_system_does_not_know_is_refused(
        self, world: World, gate: InviteGate
    ) -> None:
        agent = await _restrict(world, "helper", owner_only_policy([]))
        assert await _refused(world, gate, ChatSender("@ghost:test"), agent) == [
            "helper"
        ]

    async def test_an_agent_is_judged_as_itself(
        self, world: World, gate: InviteGate
    ) -> None:
        agent = await _restrict(world, "helper", owner_only_policy([]))
        reviewer = world.agents["reviewer"]
        assert await _refused(world, gate, AgentInviter(reviewer.id), agent) == [
            "helper"
        ]

    async def test_an_agent_may_always_invite_itself(
        self, world: World, gate: InviteGate
    ) -> None:
        agent = await _restrict(world, "helper", owner_only_policy([]))
        assert await _refused(world, gate, AgentInviter(agent.id), agent) == []

    async def test_a_granted_agent_may_invite_it(
        self, world: World, gate: InviteGate
    ) -> None:
        reviewer = world.agents["reviewer"]
        agent = await _restrict(world, "helper", owner_only_policy([reviewer.id]))
        assert await _refused(world, gate, AgentInviter(reviewer.id), agent) == []

    async def test_a_person_on_the_platform_is_judged_as_their_account(
        self, world: World, gate: InviteGate
    ) -> None:
        agent = await _restrict(world, "helper", owner_only_policy([]))
        async with world.session_factory() as session:
            people = (await session.execute(select(ExternalUser))).scalars().all()
        by_name = {p.external_username: p for p in people}
        alice, bob = by_name["alice"], by_name["bob"]
        assert (
            await _refused(
                world,
                gate,
                PlatformInviter(alice.bridge_id, alice.external_user_id),
                agent,
            )
            == []
        )
        assert await _refused(
            world, gate, PlatformInviter(bob.bridge_id, bob.external_user_id), agent
        ) == ["helper"]
        assert await _refused(
            world, gate, PlatformInviter(bob.bridge_id, "never-seen"), agent
        ) == ["helper"]

    async def test_a_platform_that_does_not_say_who_added_the_bot_is_let_through(
        self, world: World, gate: InviteGate
    ) -> None:
        agent = await _restrict(world, "helper", owner_only_policy([]))
        assert await _refused(world, gate, PlatformInviter("b", None), agent) == []


class TestTheDefaultPolicy:
    async def test_the_owners_other_agents_may_invite_it(
        self, world: World, gate: InviteGate
    ) -> None:
        agent = await _restrict(world, "helper", owner_and_owner_agents_policy())
        reviewer = world.agents["reviewer"]
        assert await _refused(world, gate, AgentInviter(reviewer.id), agent) == []

    async def test_another_owners_agent_may_not(
        self, world: World, gate: InviteGate
    ) -> None:
        agent = await _restrict(world, "helper", owner_and_owner_agents_policy())
        foreign = await _foreign_agent(world, None)
        assert await _refused(world, gate, AgentInviter(foreign.id), agent) == [
            "helper"
        ]


class TestSeveralAgents:
    async def test_one_refusal_refuses_the_whole_invite_and_names_only_that_agent(
        self, world: World, gate: InviteGate
    ) -> None:
        strict = await _restrict(world, "helper", owner_only_policy([]))
        foreign = await _foreign_agent(world, None)
        stranger = await _stranger(world)
        async with world.session_factory() as session:
            with pytest.raises(InviteRefused) as raised:
                await gate.require(
                    session,
                    UserInviter(stranger.id),
                    [foreign.id, strict.id],
                    room_id=world.room_id,
                    group_id=None,
                )
        assert raised.value.agent_names == ["helper"]


def test_telemetry_counts_who_invited() -> None:
    assert actor_kind(UserInviter("u")) == "user"
    assert actor_kind(ChatSender("@u:t")) == "user"
    assert actor_kind(AgentInviter("a")) == "agent"
    assert actor_kind(PlatformInviter("b", None)) == "system"


def _service(world: World) -> RoomService:
    svc = object.__new__(RoomService)
    svc._session_factory = world.session_factory  # type: ignore[assignment]
    svc._room_store = RoomStore()  # type: ignore[assignment]
    svc._agent_store = AgentStore()  # type: ignore[assignment]
    svc._invites = InviteGate.build(room_store=RoomStore(), agent_store=AgentStore())
    return svc


async def _members(world: World) -> set[str]:
    async with world.session_factory() as session:
        return set(await RoomStore().get_agent_ids(session, world.room_id))


class TestRoomService:
    async def test_a_refused_invite_adds_nobody(self, world: World) -> None:
        strict = await _foreign_agent(world, None)
        await _restrict_agent(world, strict.id, owner_only_policy([]))
        stranger = await _stranger(world)
        before = await _members(world)
        with pytest.raises(InviteRefused, match="wasn't added"):
            await _service(world).add_agents_to_room(
                world.room_id,
                [strict.id, world.agents["helper"].id],
                invited_by=UserInviter(stranger.id),
            )
        assert await _members(world) == before

    async def test_agents_already_in_the_room_stay_when_their_policy_tightens(
        self, world: World
    ) -> None:
        await _restrict(world, "helper", owner_only_policy([]))
        stranger = await _stranger(world)
        before = await _members(world)
        await _service(world).add_agents_to_room(
            world.room_id,
            [world.agents["helper"].id],
            invited_by=UserInviter(stranger.id),
        )
        assert await _members(world) == before

    async def test_a_refused_room_is_not_created(self, world: World) -> None:
        strict = await _foreign_agent(world, None)
        await _restrict_agent(world, strict.id, owner_only_policy([]))
        stranger = await _stranger(world)

        async def rooms() -> int:
            async with world.session_factory() as session:
                return await session.scalar(select(func.count()).select_from(Room)) or 0

        before = await rooms()
        with pytest.raises(InviteRefused):
            await _service(world).create_room(
                RoomCreateConfig(name="new", description="d", agent_ids=[strict.id]),
                invited_by=UserInviter(stranger.id),
            )
        assert await rooms() == before


async def _restrict_agent(
    world: World, agent_id: str, policy: AddressingPolicy | None
) -> None:
    async with world.session_factory() as session:
        await session.execute(
            update(Agent)
            .where(Agent.id == agent_id)
            .values(
                addressing_policy=policy.model_dump(mode="json") if policy else None
            )
        )
        await session.commit()
