from __future__ import annotations

import uuid

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Client, Room, Tenant
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.room_store import RoomStore


async def _make_client(session: AsyncSession, matrix_user_id: str) -> Client:
    client = Client(
        matrix_user_id=matrix_user_id,
        display_name=matrix_user_id,
        type="agent",
    )
    session.add(client)
    await session.flush()
    return client


async def _make_room(session: AsyncSession) -> str:
    room = Room(
        matrix_room_id=f"!{uuid.uuid4().hex[:8]}:test",
        name="a room",
        description="somewhere a client can be a member of",
    )
    session.add(room)
    await session.flush()
    return room.id


class TestDeleteClearsMemberships:
    """A client that has joined a room must still be deletable.

    `client_rooms` references `clients` with no `ON DELETE` rule, so the
    membership rows would otherwise hold the client row hostage — and every
    client worth deleting has them: a bridge puppet has been in every room the
    person it stands for spoke in.
    """

    async def test_a_client_that_is_in_a_room_can_be_deleted(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = ClientStore()
        async with session_factory() as session:
            client_id = (
                await _make_client(session, f"@member-{uuid.uuid4().hex[:8]}:test")
            ).id
            room_id = await _make_room(session)
            await RoomStore().add_client(session, client_id, room_id)
            await session.commit()

        async with session_factory() as session:
            await store.delete(session, client_id)
            await session.commit()

        async with session_factory() as session:
            assert await store.get(session, client_id) is None
            assert await RoomStore().get_client_ids(session, room_id) == []
            # Only the membership goes. Deleting a client is not a reason to
            # lose the room — a cascade on the wrong side would take it.
            assert await RoomStore().get(session, room_id) is not None

    async def test_other_clients_keep_their_memberships(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = ClientStore()
        async with session_factory() as session:
            going = (
                await _make_client(session, f"@going-{uuid.uuid4().hex[:8]}:test")
            ).id
            staying = (
                await _make_client(session, f"@staying-{uuid.uuid4().hex[:8]}:test")
            ).id
            room_id = await _make_room(session)
            await RoomStore().add_client(session, going, room_id)
            await RoomStore().add_client(session, staying, room_id)
            await session.commit()

        async with session_factory() as session:
            await store.delete(session, going)
            await session.commit()

        async with session_factory() as session:
            assert await RoomStore().get_client_ids(session, room_id) == [staying]


class TestDeleteDoesNotReachAcrossTenants:
    """What keeps the membership clear from being a cross-tenant delete.

    `delete(ClientRoom).where(ClientRoom.client_id == ...)` carries no tenant
    predicate. Under the runtime role the `FOR ALL` isolation policy narrows
    it, but these tests connect as the container's superuser, which owns the
    tables and so is bound by no policy — the same gap `db/tenant_lookup.py`
    warns about for fan-out reads, where an unfiltered statement acts on every
    tenant's rows at once.

    It is safe here for a structural reason rather than a policy one, and that
    reason is what these pin: `clients.id` is a standalone primary key, so one
    client id belongs to exactly one tenant and a `client_rooms` row carrying
    it under a second tenant cannot be written in the first place. Both halves
    are load-bearing — drop the global uniqueness and the predicate needs a
    tenant of its own.
    """

    async def test_another_tenants_memberships_are_untouched(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = ClientStore()
        other_tenant = f"tenant-{uuid.uuid4().hex[:8]}"

        async with session_factory() as session:
            going = (
                await _make_client(session, f"@going-{uuid.uuid4().hex[:8]}:test")
            ).id
            here = await _make_room(session)
            await RoomStore().add_client(session, going, here)
            session.add(Tenant(id=other_tenant, slug=other_tenant, name=other_tenant))
            await session.commit()

        async with tenant_session(session_factory, other_tenant) as other:
            theirs = (
                await _make_client(other, f"@theirs-{uuid.uuid4().hex[:8]}:test")
            ).id
            elsewhere = await _make_room(other)
            await RoomStore().add_client(other, theirs, elsewhere)
            await other.commit()

        async with session_factory() as session:
            await store.delete(session, going)
            await session.commit()

        async with tenant_session(session_factory, other_tenant) as verify:
            assert await store.get(verify, theirs) is not None
            assert await RoomStore().get_client_ids(verify, elsewhere) == [theirs]

    async def test_a_client_id_belongs_to_exactly_one_tenant(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The invariant the unfiltered delete predicate rests on.

        If a client id could be reused under a second tenant, the delete above
        would take that tenant's memberships with it on any connection no
        policy narrows.
        """
        other_tenant = f"tenant-{uuid.uuid4().hex[:8]}"
        async with session_factory() as session:
            client_id = (
                await _make_client(session, f"@sole-{uuid.uuid4().hex[:8]}:test")
            ).id
            session.add(Tenant(id=other_tenant, slug=other_tenant, name=other_tenant))
            await session.commit()

        with pytest.raises(IntegrityError):
            async with tenant_session(session_factory, other_tenant) as other:
                other.add(
                    Client(
                        id=client_id,
                        matrix_user_id=f"@copy-{uuid.uuid4().hex[:8]}:test",
                        display_name="a second tenant reusing the id",
                        type="agent",
                    )
                )
                await other.commit()


class TestGetByMatrixUserIdMultiTenant:
    """`Client.matrix_user_id` is unique per tenant
    (`uq_clients_tenant_matrix_user_id`), not globally — two tenants may each
    puppet the same Matrix user id. Before scoping the read, an unfiltered
    `get_by_matrix_user_id` matched both rows and raised
    `MultipleResultsFound` out of message routing and provisioning, which
    resolve the sending client from an inbound event this way.

    Each tenant gets its own session, opened inside its own binding with
    `tenant_session`, for both the arrangement and the read back. A session's
    transaction is stamped with whatever tenant was bound when it began —
    `set_config` rides `after_begin`, issued once — so entering
    `tenant_scope(other_tenant)` around statements on the session already open
    for tenant zero would rebind the contextvar without moving what Postgres
    was told, and the two would disagree from that statement on.
    """

    async def test_returns_the_bound_tenants_client(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = ClientStore()
        other_tenant = f"tenant-{uuid.uuid4().hex[:8]}"
        shared_matrix_user_id = "@shared:switch.local"

        async with session_factory() as session:
            session.add(Tenant(id=other_tenant, slug=other_tenant, name=other_tenant))
            await session.flush()
            own_id = (await _make_client(session, shared_matrix_user_id)).id
            await session.commit()

        async with tenant_session(session_factory, other_tenant) as other_session:
            other_id = (await _make_client(other_session, shared_matrix_user_id)).id
            await other_session.commit()

        async with session_factory() as verify:
            result = await store.get_by_matrix_user_id(verify, shared_matrix_user_id)
            assert result is not None
            assert result.id == own_id

        async with tenant_session(session_factory, other_tenant) as verify:
            result = await store.get_by_matrix_user_id(verify, shared_matrix_user_id)
            assert result is not None
            assert result.id == other_id
