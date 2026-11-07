from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    Agent,
    ApiKey,
    Client,
    Package,
    Reference,
    Room,
    Task,
    Tenant,
    TenantNotBoundError,
    User,
    room_agents,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.room_store import RoomStore


async def _make_room(session: AsyncSession, transport_room_id: str) -> Room:
    room = Room(
        transport_room_id=transport_room_id,
        name=transport_room_id,
        description="test room",
    )
    session.add(room)
    await session.flush()
    return room


async def _make_agent(session: AsyncSession, user_id: str) -> Agent:
    api_key = ApiKey(
        user_id=user_id,
        key_hash="hash-member",
        encrypted_key="enc",
        label="member",
        type="agent",
    )
    client = Client(
        transport_user_id="@member:test.local", display_name="member", type="agent"
    )
    session.add_all([api_key, client])
    await session.flush()
    agent = Agent(
        name="member",
        description="member",
        agent_type="always_on",
        connector_type="claude_code",
        integration_profile={"connection_model": "always_on"},
        client_id=client.id,
        api_key_id=api_key.id,
    )
    session.add(agent)
    await session.flush()
    return agent


class TestGetByTransportRoomIdMultiTenant:
    """`Room.matrix_room_id` is unique per tenant
    (`uq_rooms_tenant_matrix_room_id`), not globally — two tenants may each
    have a room bound to the same transport room id. Before scoping the read,
    an unfiltered `get_by_matrix_room_id` matched both rows and raised
    `MultipleResultsFound` out of every inbound-event path that resolves the
    room this way (provisioning, the Postgres transport, admin commands).

    Each tenant gets its own session, opened inside its own binding with
    `tenant_session`, for both the arrangement and the read back. A session's
    transaction is stamped with whatever tenant was bound when it began —
    `set_config` rides `after_begin`, issued once — so entering
    `tenant_scope(other_tenant)` around statements on the session already open
    for tenant zero would rebind the contextvar without moving what Postgres
    was told, and the two would disagree from that statement on.
    """

    async def test_returns_the_bound_tenants_room(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomStore()
        other_tenant = f"tenant-{uuid.uuid4().hex[:8]}"
        shared_transport_room_id = "!shared:switch.local"

        async with session_factory() as session:
            session.add(Tenant(id=other_tenant, slug=other_tenant, name=other_tenant))
            await session.flush()
            own_id = (await _make_room(session, shared_transport_room_id)).id
            await session.commit()

        async with tenant_session(session_factory, other_tenant) as other_session:
            other_id = (await _make_room(other_session, shared_transport_room_id)).id
            await other_session.commit()

        async with session_factory() as verify:
            result = await store.get_by_transport_room_id(
                verify, shared_transport_room_id
            )
            assert result is not None
            assert result.id == own_id

        async with tenant_session(session_factory, other_tenant) as verify:
            result = await store.get_by_transport_room_id(
                verify, shared_transport_room_id
            )
            assert result is not None
            assert result.id == other_id


class TestGetByTransportRoomIdRequiresATenant:
    """No caller left reaches `get_by_matrix_room_id` with nothing bound
    (CHOO-2623): `PostgresTransport` and the two `Actor` subclasses carry
    their own tenant, and `PostgresProvisioning` is only ever invoked from
    inside a `tenant_scope` bound to the room it acts on. An unfiltered
    fallback for "nothing bound" therefore has no legitimate caller left to
    serve — only a forgotten bind, which two tenants sharing a
    `matrix_room_id` turn into `MultipleResultsFound` instead of `Room | None`.
    Refusing outright, the same as `ClientStore.get_by_matrix_user_id`, turns
    that into a clear, immediate error instead.
    """

    @pytest.mark.no_ambient_tenant
    async def test_raises_rather_than_matching_two_tenants_rooms(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomStore()
        tenant_a = f"tenant-{uuid.uuid4().hex[:8]}"
        tenant_b = f"tenant-{uuid.uuid4().hex[:8]}"
        shared_transport_room_id = "!shared-unbound:switch.local"

        async with session_factory() as session:
            session.add_all(
                [
                    Tenant(id=tenant_a, slug=tenant_a, name=tenant_a),
                    Tenant(id=tenant_b, slug=tenant_b, name=tenant_b),
                ]
            )
            await session.commit()

        async with tenant_session(session_factory, tenant_a) as session:
            await _make_room(session, shared_transport_room_id)
            await session.commit()

        async with tenant_session(session_factory, tenant_b) as session:
            await _make_room(session, shared_transport_room_id)
            await session.commit()

        async with session_factory() as verify:
            with pytest.raises(TenantNotBoundError):
                await store.get_by_transport_room_id(verify, shared_transport_room_id)


class TestDelete:
    async def test_deletes_a_room_with_what_hangs_off_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        packages, references = PackageStore(), ReferenceStore()
        async with session_factory() as session:
            owner = User(name="owner", email="owner@example.com", role="admin")
            session.add(owner)
            await session.flush()
            room = await _make_room(session, "!attached:switch.local")
            package = await packages.create(
                session,
                Package(
                    owner_id=owner.id,
                    read_visibility="private",
                    write_visibility="private",
                    name="pkg",
                    description="d",
                    instructions="i",
                ),
            )
            reference = await references.create(
                session,
                Reference(
                    owner_id=owner.id,
                    read_visibility="private",
                    write_visibility="private",
                    type="url",
                    name="ref",
                    description="d",
                    instructions="i",
                    value={"url": "https://example.com"},
                ),
            )
            await packages.attach_to_room(session, room.id, package.id)
            await references.attach_to_room(session, room.id, reference.id)
            agent = await _make_agent(session, owner.id)
            await session.execute(
                insert(room_agents).values(room_id=room.id, agent_id=agent.id)
            )
            session.add(
                Task(
                    room_id=room.id,
                    requester_agent_id=agent.id,
                    performer_agent_id=agent.id,
                    summary="s",
                    description="d",
                    status="pending",
                )
            )
            await session.commit()
            room_id, package_id, reference_id = room.id, package.id, reference.id
            agent_id = agent.id

        async with session_factory() as session:
            await RoomStore().delete(session, room_id)
            await session.commit()

        async with session_factory() as session:
            assert await session.get(Room, room_id) is None
            assert await packages.get(session, package_id) is not None
            assert await session.get(Reference, reference_id) is not None
            assert await session.get(Agent, agent_id) is not None
            tasks = await session.execute(select(Task).where(Task.room_id == room_id))
            assert tasks.scalars().all() == []


class TestAddAgents:
    async def test_two_concurrent_adds_of_one_agent_both_succeed(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomStore()
        async with session_factory() as session:
            owner = User(name="owner", email="owner@example.com", role="admin")
            session.add(owner)
            await session.flush()
            room = await _make_room(session, "!double-add:switch.local")
            agent = await _make_agent(session, owner.id)
            await session.commit()

        async with session_factory() as first, session_factory() as second:
            await store.add_agents(first, room.id, [agent.id])
            # Waits on the first's uncommitted row, then finds it there.
            racing = asyncio.create_task(store.add_agents(second, room.id, [agent.id]))
            await asyncio.sleep(0.2)
            assert not racing.done()
            await first.commit()
            await racing
            await second.commit()

        async with session_factory() as session:
            assert await store.get_agent_ids(session, room.id) == [agent.id]
