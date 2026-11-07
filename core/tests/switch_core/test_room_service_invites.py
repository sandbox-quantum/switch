"""The invite gate inside `RoomService`, against real Postgres (#805).

`test_invites.py` pins what the gate decides. This pins where it decides: the
one place every invite path funnels through. A refusal has to land *before*
any of the side effects — the membership row, the platform invite, the
`room_clients` row — and has to be the reading of the policy at the moment the
membership transaction commits, not the one a moment earlier.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from typing import Any, cast

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import (
    default_agent_policy,
    owner_only_policy,
    parse_policy,
)
from switch_core.db.models import Agent, ApiKey, Client, Room, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.invites import Inviter, InviteRefused
from switch_core.room_service import RoomCreateConfig, RoomService


class _Provisioning:
    """Records every platform call, so a test can assert none was made."""

    def __init__(self) -> None:
        self.created = 0
        self.invited: list[tuple[str, str]] = []
        self.deleted: list[str] = []

    async def create_room(self, name: str, description: str) -> str:
        self.created += 1
        return f"!room-{self.created}:test"

    async def invite_to_room(
        self, transport_room_id: str, transport_user_id: str
    ) -> None:
        self.invited.append((transport_room_id, transport_user_id))

    async def delete_room(self, transport_room_id: str) -> None:
        self.deleted.append(transport_room_id)


class _RunningClients:
    def __init__(self, by_agent: dict[str, Any]) -> None:
        self._by_agent = by_agent
        self._by_id = {client.client_id: client for client in by_agent.values()}

    def get_by_agent_id(self, agent_id: str) -> Any:
        return self._by_agent.get(agent_id)

    def get(self, client_id: str) -> Any:
        return self._by_id.get(client_id)

    def get_by_type(self, client_type: str, tenant_id: str) -> list[Any]:
        return []


class _NoBridges:
    def get(self, bridge_id: str) -> Any:
        return None

    def rooms_changed(self, bridge_id: str) -> None:
        pass


class _NoDefaultBridge:
    async def get_default(self, session: AsyncSession) -> None:
        return None

    async def get(self, session: AsyncSession, bridge_id: str) -> None:
        return None


def _service(
    session_factory: async_sessionmaker[AsyncSession],
    running: dict[str, Any],
) -> RoomService:
    """A normally constructed service, so the gate is wired as in production."""
    return RoomService(
        provisioning=cast(Any, _Provisioning()),
        room_store=RoomStore(),
        agent_store=AgentStore(),
        client_lifecycle=cast(Any, _RunningClients(running)),
        collab_lifecycle=cast(Any, _NoBridges()),
        collab_bridge_store=cast(Any, _NoDefaultBridge()),
        resource_service=cast(Any, None),
        session_factory=session_factory,
        room_cache=cast(Any, SimpleNamespace(invalidate=lambda *args: None)),
    )


def _provisioning(service: RoomService) -> _Provisioning:
    return cast(_Provisioning, service._provisioning)


class _Seeded:
    def __init__(
        self,
        *,
        owner_id: str,
        stranger_id: str,
        agent_ids: list[str],
        room_id: str,
        running: dict[str, Any],
        service: RoomService,
    ) -> None:
        self.owner_id = owner_id
        self.stranger_id = stranger_id
        self.agent_ids = agent_ids
        self.room_id = room_id
        self.running = running
        self.service = service


async def _seed(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    policies: list[object | None],
    existing: list[int] = (),
) -> _Seeded:
    """An owner, a stranger, `policies` agents owned by the owner, and a room.

    Room membership costs a platform invite in production; here it is only the
    row, because membership is what the gate must neither write nor remove.
    """
    async with session_factory() as session:
        owner = User(
            name="owner",
            email=f"owner-{uuid.uuid4()}@test",
            role="user",
            password_hash="x",
        )
        stranger = User(
            name="stranger",
            email=f"stranger-{uuid.uuid4()}@test",
            role="user",
            password_hash="x",
        )
        session.add_all([owner, stranger])
        await session.flush()

        agent_ids: list[str] = []
        running: dict[str, Any] = {}
        for i, policy in enumerate(policies):
            key = ApiKey(
                user_id=owner.id,
                key_hash=f"hash-{uuid.uuid4()}",
                encrypted_key="enc",
                label=f"a{i}",
                type="agent",
            )
            client = Client(
                transport_user_id=f"@a{i}-{uuid.uuid4().hex[:8]}:test",
                display_name=f"a{i}",
                type="agent",
            )
            session.add_all([key, client])
            await session.flush()
            agent = Agent(
                name=f"a{i}-{uuid.uuid4().hex[:8]}",
                description="d",
                agent_type="session_addressable",
                connector_type="claude_code",
                integration_profile={},
                client_id=client.id,
                api_key_id=key.id,
                owner_id=owner.id,
                addressing_policy=policy,
            )
            session.add(agent)
            await session.flush()
            agent_ids.append(agent.id)
            running[agent.id] = SimpleNamespace(
                client_id=client.id, transport_user_id=client.transport_user_id
            )

        room = Room(
            transport_room_id=f"!r-{uuid.uuid4().hex[:8]}:test",
            name="room",
            description="d",
        )
        session.add(room)
        await session.flush()
        if existing:
            await RoomStore().add_agents(
                session, room.id, [agent_ids[i] for i in existing]
            )
        await session.commit()
        service = _service(session_factory, running)
        return _Seeded(
            owner_id=owner.id,
            stranger_id=stranger.id,
            agent_ids=agent_ids,
            room_id=room.id,
            running=running,
            service=service,
        )


def _restricted() -> dict:
    return owner_only_policy([]).model_dump()


async def _members(
    session_factory: async_sessionmaker[AsyncSession], room_id: str
) -> list[str]:
    async with session_factory() as session:
        return await RoomStore().get_agent_ids(session, room_id)


async def _room_clients(
    session_factory: async_sessionmaker[AsyncSession], room_id: str
) -> list[str]:
    async with session_factory() as session:
        return await RoomStore().get_client_ids(session, room_id)


async def _rooms(session_factory: async_sessionmaker[AsyncSession]) -> list[Room]:
    async with session_factory() as session:
        return list((await session.execute(select(Room))).scalars().all())


class TestAddAgentsToRoom:
    async def test_the_owner_can_add_their_own_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        seeded = await _seed(session_factory, policies=[_restricted()])
        agent_id = seeded.agent_ids[0]

        await seeded.service.add_agents_to_room(
            seeded.room_id,
            agent_ids=[agent_id],
            invited_by=Inviter.person(seeded.owner_id),
        )

        assert await _members(session_factory, seeded.room_id) == [agent_id]
        assert await _room_clients(session_factory, seeded.room_id) == [
            seeded.running[agent_id].client_id
        ]
        assert len(_provisioning(seeded.service).invited) == 1

    async def test_a_stranger_is_refused_before_any_side_effect(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        seeded = await _seed(session_factory, policies=[_restricted()])
        agent_id = seeded.agent_ids[0]

        with pytest.raises(InviteRefused) as refused:
            await seeded.service.add_agents_to_room(
                seeded.room_id,
                agent_ids=[agent_id],
                invited_by=Inviter.person(seeded.stranger_id),
            )

        assert "owner" in str(refused.value)
        assert await _members(session_factory, seeded.room_id) == []
        assert await _room_clients(session_factory, seeded.room_id) == []
        assert _provisioning(seeded.service).invited == []

    async def test_one_refusal_refuses_the_whole_batch(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """All or nothing: a half-filled room is not what anyone asked for."""
        seeded = await _seed(
            session_factory,
            policies=[parse_policy(None).model_dump(), _restricted()],
        )
        open_agent, restricted = seeded.agent_ids

        with pytest.raises(InviteRefused):
            await seeded.service.add_agents_to_room(
                seeded.room_id,
                agent_ids=[open_agent, restricted],
                invited_by=Inviter.person(seeded.stranger_id),
            )

        assert await _members(session_factory, seeded.room_id) == []
        assert _provisioning(seeded.service).invited == []

    async def test_an_open_agent_can_be_added_by_anyone(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        seeded = await _seed(
            session_factory, policies=[parse_policy(None).model_dump()]
        )
        agent_id = seeded.agent_ids[0]

        await seeded.service.add_agents_to_room(
            seeded.room_id,
            agent_ids=[agent_id],
            invited_by=Inviter.person(seeded.stranger_id),
        )

        assert await _members(session_factory, seeded.room_id) == [agent_id]

    async def test_an_owner_s_other_agent_is_judged_as_that_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        seeded = await _seed(
            session_factory,
            policies=[
                default_agent_policy().model_dump(),
                default_agent_policy().model_dump(),
            ],
        )
        manager, worker = seeded.agent_ids

        await seeded.service.add_agents_to_room(
            seeded.room_id,
            agent_ids=[worker],
            invited_by=Inviter.agent(manager),
        )

        assert await _members(session_factory, seeded.room_id) == [worker]

    async def test_an_unknown_adder_is_allowed_the_join(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Refusing would break a channel for a reason nobody in it can fix."""
        seeded = await _seed(session_factory, policies=[_restricted()])
        agent_id = seeded.agent_ids[0]

        await seeded.service.add_agents_to_room(
            seeded.room_id,
            agent_ids=[agent_id],
            invited_by=Inviter.unknown_adder(),
        )

        assert await _members(session_factory, seeded.room_id) == [agent_id]

    async def test_existing_members_are_neither_judged_nor_removed(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Tightening a policy never ejects an agent already in a room."""
        seeded = await _seed(session_factory, policies=[_restricted()], existing=[0])
        agent_id = seeded.agent_ids[0]

        await seeded.service.add_agents_to_room(
            seeded.room_id,
            agent_ids=[agent_id],
            invited_by=Inviter.person(seeded.stranger_id),
        )

        assert await _members(session_factory, seeded.room_id) == [agent_id]
        assert _provisioning(seeded.service).invited == []

    async def test_a_policy_tightened_after_the_preflight_still_refuses(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The commit-time recheck is the one that counts.

        The preflight reads an agent the stranger may add. Before the
        membership transaction commits, its owner tightens the policy and the
        change commits. The invite must observe that order and refuse — and
        leave nothing behind.
        """
        seeded = await _seed(
            session_factory, policies=[parse_policy(None).model_dump()]
        )
        agent_id = seeded.agent_ids[0]
        original = seeded.service._invites.refused
        calls = 0

        async def refused(*args: Any, **kw: Any) -> list[Agent]:
            nonlocal calls
            calls += 1
            if calls == 1:
                async with session_factory() as session:
                    agent = await session.get(Agent, agent_id)
                    assert agent is not None
                    agent.addressing_policy = _restricted()
                    await session.commit()
            return await original(*args, **kw)

        seeded.service._invites.refused = refused  # type: ignore[method-assign]

        with pytest.raises(InviteRefused):
            await seeded.service.add_agents_to_room(
                seeded.room_id,
                agent_ids=[agent_id],
                invited_by=Inviter.person(seeded.stranger_id),
            )

        assert calls == 2
        assert await _members(session_factory, seeded.room_id) == []
        assert await _room_clients(session_factory, seeded.room_id) == []
        assert _provisioning(seeded.service).invited == []

    async def test_an_owner_left_alone_is_not_refused_by_a_race(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        seeded = await _seed(session_factory, policies=[_restricted()])
        agent_id = seeded.agent_ids[0]

        await seeded.service.add_agents_to_room(
            seeded.room_id,
            agent_ids=[agent_id],
            invited_by=Inviter.person(seeded.owner_id),
        )

        assert await _members(session_factory, seeded.room_id) == [agent_id]


class TestCreateRoom:
    async def test_a_refused_room_is_refused_before_it_is_provisioned(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        seeded = await _seed(session_factory, policies=[_restricted()])

        with pytest.raises(InviteRefused):
            await seeded.service.create_room(
                RoomCreateConfig(
                    name="private",
                    description="d",
                    agent_ids=[seeded.agent_ids[0]],
                    internal_only=True,
                    created_by=seeded.stranger_id,
                    owner_id=seeded.stranger_id,
                ),
                invited_by=Inviter.person(seeded.stranger_id),
            )

        assert _provisioning(seeded.service).created == 0
        assert _provisioning(seeded.service).invited == []
        # Only the room the test seeded; nothing was made for this attempt.
        assert [room.name for room in await _rooms(session_factory)] == ["room"]

    async def test_the_owner_provisions_and_seats_their_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        seeded = await _seed(session_factory, policies=[_restricted()])

        result = await seeded.service.create_room(
            RoomCreateConfig(
                name="ours",
                description="d",
                agent_ids=[seeded.agent_ids[0]],
                internal_only=True,
                created_by=seeded.owner_id,
                owner_id=seeded.owner_id,
            ),
            invited_by=Inviter.person(seeded.owner_id),
        )

        assert _provisioning(seeded.service).created == 1
        assert await _members(session_factory, result.room.id) == [seeded.agent_ids[0]]

    async def test_a_policy_tightened_after_the_preflight_refuses_the_room(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        seeded = await _seed(
            session_factory, policies=[parse_policy(None).model_dump()]
        )
        agent_id = seeded.agent_ids[0]
        original = seeded.service._invites.refused
        calls = 0

        async def refused(*args: Any, **kw: Any) -> list[Agent]:
            nonlocal calls
            calls += 1
            if calls == 1:
                async with session_factory() as session:
                    agent = await session.get(Agent, agent_id)
                    assert agent is not None
                    agent.addressing_policy = _restricted()
                    await session.commit()
            return await original(*args, **kw)

        seeded.service._invites.refused = refused  # type: ignore[method-assign]

        with pytest.raises(InviteRefused):
            await seeded.service.create_room(
                RoomCreateConfig(
                    name="late",
                    description="d",
                    agent_ids=[agent_id],
                    internal_only=True,
                    created_by=seeded.stranger_id,
                    owner_id=seeded.stranger_id,
                ),
                invited_by=Inviter.person(seeded.stranger_id),
            )

        assert calls == 2
        assert [room.name for room in await _rooms(session_factory)] == ["room"]
        assert await _members(session_factory, seeded.room_id) == []


class TestRefusedAgents:
    """The question the gateway's pickers ask, without attempting the invite."""

    async def test_it_names_only_the_agents_that_would_refuse(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        seeded = await _seed(
            session_factory,
            policies=[parse_policy(None).model_dump(), _restricted()],
        )
        open_agent, restricted = seeded.agent_ids

        refused = await seeded.service.refused_agents(
            Inviter.person(seeded.stranger_id),
            [open_agent, restricted],
            room_id=seeded.room_id,
            group_id=None,
        )

        assert [agent.id for agent in refused] == [restricted]

    async def test_it_names_none_for_the_owner(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        seeded = await _seed(session_factory, policies=[_restricted()])

        refused = await seeded.service.refused_agents(
            Inviter.person(seeded.owner_id),
            seeded.agent_ids,
            room_id=seeded.room_id,
            group_id=None,
        )

        assert refused == []


def test_the_gate_is_the_same_one_every_path_uses() -> None:
    """A path that forgets to say who is asking does not compile."""
    import inspect

    for method in (RoomService.create_room, RoomService.add_agents_to_room):
        signature = inspect.signature(method)
        invited_by = signature.parameters["invited_by"]
        assert invited_by.kind is inspect.Parameter.KEYWORD_ONLY
        assert invited_by.default is inspect.Parameter.empty
