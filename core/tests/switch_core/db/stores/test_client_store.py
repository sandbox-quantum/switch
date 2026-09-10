from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Client, Tenant
from switch_core.db.stores.client_store import ClientStore
from switch_core.tenant_context import tenant_scope


async def _make_client(session: AsyncSession, matrix_user_id: str) -> Client:
    client = Client(
        matrix_user_id=matrix_user_id,
        display_name=matrix_user_id,
        type="agent",
    )
    session.add(client)
    await session.flush()
    return client


async def _make_client_for_tenant(
    session: AsyncSession, tenant_id: str, matrix_user_id: str
) -> Client:
    """A client filed under `tenant_id` rather than the ambient tenant."""
    with tenant_scope(tenant_id):
        return await _make_client(session, matrix_user_id)


class TestGetByMatrixUserIdMultiTenant:
    """`Client.matrix_user_id` is unique per tenant
    (`uq_clients_tenant_matrix_user_id`), not globally — two tenants may each
    puppet the same Matrix user id. Before scoping the read, an unfiltered
    `get_by_matrix_user_id` matched both rows and raised
    `MultipleResultsFound` out of message routing and provisioning, which
    resolve the sending client from an inbound event this way.
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
            own = await _make_client(session, shared_matrix_user_id)
            other = await _make_client_for_tenant(
                session, other_tenant, shared_matrix_user_id
            )
            await session.commit()

        async with session_factory() as verify:
            result = await store.get_by_matrix_user_id(verify, shared_matrix_user_id)
        assert result is not None
        assert result.id == own.id

        async with session_factory() as verify:
            with tenant_scope(other_tenant):
                result = await store.get_by_matrix_user_id(
                    verify, shared_matrix_user_id
                )
        assert result is not None
        assert result.id == other.id
