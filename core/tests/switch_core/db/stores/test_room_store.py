from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Room, Tenant
from switch_core.db.stores.room_store import RoomStore
from switch_core.tenant_context import tenant_scope


async def _make_room(session: AsyncSession, matrix_room_id: str) -> Room:
    room = Room(
        matrix_room_id=matrix_room_id,
        name=matrix_room_id,
        description="test room",
    )
    session.add(room)
    await session.flush()
    return room


async def _make_room_for_tenant(
    session: AsyncSession, tenant_id: str, matrix_room_id: str
) -> Room:
    """A room filed under `tenant_id` rather than the ambient tenant."""
    with tenant_scope(tenant_id):
        return await _make_room(session, matrix_room_id)


class TestGetByMatrixRoomIdMultiTenant:
    """`Room.matrix_room_id` is unique per tenant
    (`uq_rooms_tenant_matrix_room_id`), not globally — two tenants may each
    have a room bound to the same transport room id. Before scoping the read,
    an unfiltered `get_by_matrix_room_id` matched both rows and raised
    `MultipleResultsFound` out of every inbound-event path that resolves the
    room this way (provisioning, the Postgres transport, admin commands).
    """

    async def test_returns_the_bound_tenants_room(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomStore()
        other_tenant = f"tenant-{uuid.uuid4().hex[:8]}"
        shared_matrix_room_id = "!shared:switch.local"

        async with session_factory() as session:
            session.add(Tenant(id=other_tenant, slug=other_tenant, name=other_tenant))
            await session.flush()
            own = await _make_room(session, shared_matrix_room_id)
            other = await _make_room_for_tenant(
                session, other_tenant, shared_matrix_room_id
            )
            await session.commit()

        async with session_factory() as verify:
            result = await store.get_by_matrix_room_id(verify, shared_matrix_room_id)
        assert result is not None
        assert result.id == own.id

        async with session_factory() as verify:
            with tenant_scope(other_tenant):
                result = await store.get_by_matrix_room_id(
                    verify, shared_matrix_room_id
                )
        assert result is not None
        assert result.id == other.id
