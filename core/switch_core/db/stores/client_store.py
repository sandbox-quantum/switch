from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import Client, ClientRoom, require_tenant_id


class ClientStore:
    async def get_all(self, session: AsyncSession) -> list[Client]:
        result = await session.execute(select(Client))
        return list(result.scalars().all())

    async def get(self, session: AsyncSession, client_id: str) -> Client | None:
        return await session.get(Client, client_id)

    async def get_by_matrix_user_id(
        self, session: AsyncSession, matrix_user_id: str
    ) -> Client | None:
        """Resolve a client by its Matrix user id within the bound tenant.

        Scoped explicitly rather than left to row-level security:
        `matrix_user_id` is unique per tenant
        (`uq_clients_tenant_matrix_user_id`), not globally, so the moment a
        second tenant has a client with the same puppet id, an unfiltered read
        here matches both rows and raises `MultipleResultsFound` out of
        message routing and provisioning, which resolve the sending client
        from an inbound event this way.
        """
        result = await session.execute(
            select(Client).where(
                Client.tenant_id == require_tenant_id(),
                Client.matrix_user_id == matrix_user_id,
            )
        )
        return result.scalar_one_or_none()

    async def get_by_type(
        self, session: AsyncSession, client_type: str
    ) -> list[Client]:
        result = await session.execute(select(Client).where(Client.type == client_type))
        return list(result.scalars().all())

    async def create(self, session: AsyncSession, client: Client) -> Client:
        session.add(client)
        await session.flush()
        return client

    async def delete(self, session: AsyncSession, client_id: str) -> None:
        """Delete a client and the room memberships that point at it.

        `client_rooms` carries a composite foreign key on
        `(tenant_id, client_id)` with no `ON DELETE` rule, so a client that has
        ever joined a room cannot be deleted while its membership rows stand —
        Postgres refuses the delete. Memberships are cleared here rather than
        by each caller: the rows describe where the client was, and once it is
        gone they describe nothing.

        Memberships only. `agents`, `collaboration_bridges` and
        `external_users` also reference a client with no `ON DELETE` rule, and
        those rows are owned by something with its own lifecycle, so deleting
        them is the caller's to sequence — the client goes last, after whatever
        claims it. A caller that gets that order wrong gets the same foreign
        key violation this clears for `client_rooms`.
        """
        client = await session.get(Client, client_id)
        if client is None:
            return
        await session.execute(
            delete(ClientRoom).where(ClientRoom.client_id == client_id)
        )
        await session.delete(client)
        await session.flush()
