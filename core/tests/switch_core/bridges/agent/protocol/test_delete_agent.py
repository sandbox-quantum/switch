"""`delete_agent` takes the agent's client with it, room memberships and all.

An agent that has been in a room holds two memberships: a `room_agents` row,
which `AgentStore.delete` clears, and a `client_rooms` row for its client,
which `ClientStore.delete` clears — reached through
`ClientLifecycleService.delete_record` in the same transaction as the agent's
delete. Nothing else clears the second, so this pins the whole chain against a
real database.

A delete that fails leaves the agent in place, and its client runs again.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_connections import ClientDeclaration
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.positions import OWN_EVENTS
from switch_core.bridges.collaboration.adapter import AgentIdentity
from switch_core.db.models import TENANT_ZERO_ID, Room, require_tenant_id
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.room_store import RoomStore
from tests.switch_core.bridges.agent.protocol.registration_harness import (
    FakeClientLifecycle,
    make_owner,
    make_service,
    register,
)
from tests.switch_core.clients.test_client_signals import _lifecycle


class _DeletingClientLifecycle(FakeClientLifecycle):
    """Registration's fake, plus the `stop` and `delete_record` calls
    `delete_agent` makes. `delete_record` deletes through the real store in the
    caller's session and commits nothing, as the real service does, so what
    the test sees is what `delete_agent`'s own transaction left."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        super().__init__(session_factory)
        self.stopped: list[str] = []

    async def stop(self, client_id: str) -> None:
        self.stopped.append(client_id)

    async def delete_record(self, session: AsyncSession, client_id: str) -> None:
        await ClientStore().delete(session, client_id)


class TestDeleteAgentInARoom:
    async def test_the_agent_its_client_and_both_memberships_go(
        self, session_factory: async_sessionmaker[AsyncSession], db_buffer: EventBuffer
    ) -> None:
        svc = make_service(session_factory)
        lifecycle = _DeletingClientLifecycle(session_factory)
        svc.client_lifecycle = lifecycle  # type: ignore[assignment]
        svc.event_buffer = db_buffer

        owner = await make_owner(session_factory)
        agent_id = await register(svc, "in-a-room", owner)
        async with session_factory() as session:
            agent = await svc.agent_store.get(session, agent_id)
            assert agent is not None
            client_id = agent.client_id
            room = Room(
                transport_room_id=f"!{uuid.uuid4().hex[:8]}:test",
                name="a room",
                description="somewhere the agent has been",
            )
            session.add(room)
            await session.flush()
            room_id = room.id
            await RoomStore().add_agents(session, room_id, [agent_id])
            await RoomStore().add_client(session, client_id, room_id)
            await session.commit()

        told: list[tuple[str, str, list[str]]] = []

        async def room_agents_changed(tenant_id: str, changed_room_id: str) -> None:
            async with session_factory() as session:
                remaining = await RoomStore().get_agent_ids(session, changed_room_id)
            told.append((tenant_id, changed_room_id, remaining))

        svc.set_room_agents_listener(room_agents_changed)
        await svc.delete_agent(agent_id=agent_id)

        # Told once the agent is gone, so a listener re-reading the room
        # finds it without the agent.
        assert told == [(require_tenant_id(), room_id, [])]
        assert lifecycle.stopped == [client_id]
        async with session_factory() as session:
            assert await svc.agent_store.get(session, agent_id) is None
            assert await ClientStore().get(session, client_id) is None
            assert await RoomStore().get_agent_ids(session, room_id) == []
            assert await RoomStore().get_client_ids(session, room_id) == []
            # Only the memberships go; the room outlives its member.
            assert await RoomStore().get(session, room_id) is not None


class _Adapter:
    def __init__(self, error: str | None = None) -> None:
        self.error = error
        self.removed: list[str] = []

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        if self.error is not None:
            raise RuntimeError(self.error)
        self.removed.append(agent.name)


class _Bridge:
    def __init__(self, bridge_type: str, adapter: _Adapter) -> None:
        self.bridge_type = bridge_type
        self.adapter = adapter


class _Bridges:
    def __init__(self, bridges: list[_Bridge]) -> None:
        self.bridges = bridges

    def bridges_for_tenant(self, tenant_id: str) -> list[_Bridge]:
        return self.bridges


class TestDeleteAgentWhenAPlatformFails:
    async def test_the_agent_still_goes_and_the_failure_is_reported(
        self, session_factory: async_sessionmaker[AsyncSession], db_buffer: EventBuffer
    ) -> None:
        """A platform that cannot be told must not keep the agent alive, and
        must not be passed over in silence either."""
        svc = make_service(session_factory)
        svc.client_lifecycle = _DeletingClientLifecycle(session_factory)  # type: ignore[assignment]
        svc.event_buffer = db_buffer
        failing = _Adapter(error="Slack is down")
        working = _Adapter()
        svc.collab_lifecycle = _Bridges(  # type: ignore[assignment]
            [_Bridge("slack", failing), _Bridge("mattermost", working)]
        )
        owner = await make_owner(session_factory)
        agent_id = await register(svc, "notes-taker", owner)

        result = await svc.delete_agent(agent_id=agent_id)

        assert result.bridge_failures == ["slack: Slack is down"]
        assert working.removed == ["notes-taker"]
        async with session_factory() as session:
            assert await svc.agent_store.get(session, agent_id) is None

    async def test_a_clean_delete_reports_nothing(
        self, session_factory: async_sessionmaker[AsyncSession], db_buffer: EventBuffer
    ) -> None:
        svc = make_service(session_factory)
        svc.client_lifecycle = _DeletingClientLifecycle(session_factory)  # type: ignore[assignment]
        svc.event_buffer = db_buffer
        working = _Adapter()
        svc.collab_lifecycle = _Bridges([_Bridge("slack", working)])  # type: ignore[assignment]
        owner = await make_owner(session_factory)
        await register(svc, "notes-taker", owner)

        result = await svc.delete_agent(agent_name="notes-taker")

        assert result.bridge_failures == []
        assert working.removed == ["notes-taker"]


class TestDeleteAgentWithAConnection:
    async def test_its_connection_is_closed(
        self, session_factory: async_sessionmaker[AsyncSession], db_buffer: EventBuffer
    ) -> None:
        """Rather than left serving a deleted agent's stream, and reporting
        the agent live, until its client goes."""
        svc = make_service(session_factory)
        svc.client_lifecycle = _DeletingClientLifecycle(session_factory)  # type: ignore[assignment]
        svc.event_buffer = db_buffer
        owner = await make_owner(session_factory)
        agent_id = await register(svc, "connected", owner)
        conn = svc.connections.open(
            agent_id=agent_id,
            connection_id="its-connection",
            scope="all",
            delivery_filter="addressed",
            spawn_capable=False,
            position={OWN_EVENTS: 0},
            declaration=ClientDeclaration(),
            expected_generation=None,
        )

        await svc.delete_agent(agent_id=agent_id)

        assert conn.closure is not None
        assert conn.closure.code == "closed"
        assert not svc.connections.is_live(agent_id)


class TestDeleteAgentThatFails:
    async def test_its_client_is_started_again_by_the_next_recheck(
        self, session_factory: async_sessionmaker[AsyncSession], db_buffer: EventBuffer
    ) -> None:
        """`delete_agent` stops the agent's client before its rows go, and a
        re-check leaves a client stopped that way alone. A delete that then
        fails leaves the agent and its client's row in place, so the next
        re-check starts the client again, rather than leaving it stopped here
        until the process restarts."""
        svc = make_service(session_factory)
        svc.event_buffer = db_buffer
        owner = await make_owner(session_factory)
        agent_id = await register(svc, "stays", owner)
        async with session_factory() as session:
            agent = await svc.agent_store.get(session, agent_id)
            assert agent is not None
            client_id = agent.client_id
        lifecycle = _lifecycle(session_factory)
        await lifecycle.start_all()
        svc.client_lifecycle = lifecycle

        async def _fail(*_args: object) -> None:
            raise OSError("connection lost")

        svc.agent_store.delete = _fail  # type: ignore[method-assign]
        with pytest.raises(OSError):
            await svc.delete_agent(agent_id=agent_id)
        await lifecycle.reconcile_tenant(TENANT_ZERO_ID)

        assert lifecycle.get(client_id) is not None
        await lifecycle.stop_all()
