from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Client, Tenant
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.client_store import ClientStore


async def _make_client(session: AsyncSession, matrix_user_id: str) -> Client:
    client = Client(
        matrix_user_id=matrix_user_id,
        display_name=matrix_user_id,
        type="agent",
    )
    session.add(client)
    await session.flush()
    return client


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
