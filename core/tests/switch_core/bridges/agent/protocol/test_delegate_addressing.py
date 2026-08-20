from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.bridges.agent.protocol.types import AgentStatus
from switch_core.db.models import Agent, ApiKey, Client, Room, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.task_store import TaskStore


def _service(session_factory: async_sessionmaker[AsyncSession]) -> ProtocolService:
    svc = object.__new__(ProtocolService)
    # Presence unions the heartbeat rows with the live connections
    # (CHOO-1857); an empty registry means "rows only".
    svc.connections = ConnectionRegistry()
    svc.session_factory = session_factory  # type: ignore[attr-defined]
    svc.agent_store = AgentStore()  # type: ignore[attr-defined]
    svc.room_store = RoomStore()  # type: ignore[attr-defined]
    svc.task_store = TaskStore()  # type: ignore[attr-defined]
    # No live matrix client → delegate_task skips the custom-event send.
    svc.client_lifecycle = _NoClients()  # type: ignore[attr-defined]

    async def _status(_agent_id: str, _room_id: str) -> AgentStatus:
        return AgentStatus.NO_SESSION

    svc.get_agent_status = _status  # type: ignore[attr-defined]
    return svc


class _NoClients:
    def get_by_agent_id(self, _agent_id: str) -> None:
        return None


async def _make_user(session: AsyncSession, name: str) -> User:
    user = User(name=name, email=f"{name}@test", role="user", password_hash="x")
    session.add(user)
    await session.flush()
    return user


async def _make_agent(
    session: AsyncSession,
    name: str,
    *,
    owner_id: str,
    addressing_policy: dict | None = None,
) -> Agent:
    api_key = ApiKey(
        user_id=owner_id,
        key_hash=f"hash-{name}",
        encrypted_key="enc",
        label=name,
        type="agent",
    )
    client = Client(
        matrix_user_id=f"@{name}:test",
        display_name=name,
        type="agent",
        password="x",
    )
    session.add_all([api_key, client])
    await session.flush()
    agent = Agent(
        name=name,
        description=f"{name} desc",
        agent_type="session_addressable",
        connector_type="external",
        integration_profile={"connection_model": "session_passive"},
        client_id=client.id,
        api_key_id=api_key.id,
        owner_id=owner_id,
        addressing_policy=addressing_policy,
    )
    session.add(agent)
    await session.flush()
    return agent


async def _make_room(
    session: AsyncSession, room_store: RoomStore, agent_ids: list[str]
) -> Room:
    room = Room(matrix_room_id="!room:test", name="Room", description="d")
    session.add(room)
    await session.flush()
    await room_store.add_agents(session, room.id, agent_ids)
    return room


class TestDelegateAddressingGate:
    async def test_denied_delegation_raises(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        async with session_factory() as session:
            owner = await _make_user(session, "owner")
            requester = await _make_agent(session, "req", owner_id=owner.id)
            # Performer only accepts a DIFFERENT agent, so `req` is not permitted.
            performer = await _make_agent(
                session,
                "perf",
                owner_id=owner.id,
                addressing_policy={
                    "rules": [{"agents": ["someone-else"], "users": []}]
                },
            )
            room = await _make_room(
                session, svc.room_store, [requester.id, performer.id]
            )
            await session.commit()
            req_id, perf_id, room_id = requester.id, performer.id, room.id

        with pytest.raises(PermissionError, match="not permitted to address"):
            await svc.delegate_task(req_id, room_id, perf_id, "do it", "details")

        # Nothing was created — the gate fires before the Task row.
        async with session_factory() as session:
            tasks = await svc.task_store.get_by_room(session, room_id)
        assert tasks == []

    async def test_permitted_delegation_succeeds(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        async with session_factory() as session:
            owner = await _make_user(session, "owner")
            requester = await _make_agent(session, "req", owner_id=owner.id)
            performer = await _make_agent(
                session,
                "perf",
                owner_id=owner.id,
                addressing_policy={"rules": [{"agents": ["req"], "users": []}]},
            )
            # Rule targets the requester by id — patch after we know the id.
            room = await _make_room(
                session, svc.room_store, [requester.id, performer.id]
            )
            await session.commit()
            req_id, perf_id, room_id = requester.id, performer.id, room.id

        async with session_factory() as session:
            await svc.agent_store.update(
                session,
                perf_id,
                addressing_policy={"rules": [{"agents": [req_id], "users": []}]},
            )
            await session.commit()

        result = await svc.delegate_task(req_id, room_id, perf_id, "do it", "details")
        assert result.task_id

    async def test_the_owners_own_manager_may_still_dispatch(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # The case the default has to survive: one person's manager agent
        # handing work to their worker. Under strict owner-only this raised,
        # which is a working setup broken by a privacy default.
        svc = _service(session_factory)
        async with session_factory() as session:
            owner = await _make_user(session, "owner")
            manager = await _make_agent(session, "manager", owner_id=owner.id)
            worker = await _make_agent(
                session,
                "worker",
                owner_id=owner.id,
                addressing_policy={
                    "rules": [{"users": [], "agents": [], "owner_agents": True}]
                },
            )
            room = await _make_room(session, svc.room_store, [manager.id, worker.id])
            await session.commit()
            mgr_id, worker_id, room_id = manager.id, worker.id, room.id

        result = await svc.delegate_task(mgr_id, room_id, worker_id, "do it", "details")
        assert result.task_id

    async def test_but_not_somebody_elses_manager(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # Same rule, different owner. "My agents" has to mean mine, or the
        # setting is just "any agent" with a friendlier name.
        svc = _service(session_factory)
        async with session_factory() as session:
            owner = await _make_user(session, "owner")
            other = await _make_user(session, "other")
            manager = await _make_agent(session, "their-manager", owner_id=other.id)
            worker = await _make_agent(
                session,
                "worker",
                owner_id=owner.id,
                addressing_policy={
                    "rules": [{"users": [], "agents": [], "owner_agents": True}]
                },
            )
            room = await _make_room(session, svc.room_store, [manager.id, worker.id])
            await session.commit()
            mgr_id, worker_id, room_id = manager.id, worker.id, room.id

        with pytest.raises(PermissionError, match="not permitted to address"):
            await svc.delegate_task(mgr_id, room_id, worker_id, "do it", "details")

    async def test_open_policy_allows_delegation(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        async with session_factory() as session:
            owner = await _make_user(session, "owner")
            requester = await _make_agent(session, "req", owner_id=owner.id)
            performer = await _make_agent(session, "perf", owner_id=owner.id)
            room = await _make_room(
                session, svc.room_store, [requester.id, performer.id]
            )
            await session.commit()
            req_id, perf_id, room_id = requester.id, performer.id, room.id

        result = await svc.delegate_task(req_id, room_id, perf_id, "do it", "details")
        assert result.task_id
