from collections.abc import Collection

from sqlalchemy import BigInteger, ColumnElement, cast, delete, func, literal, select
from sqlalchemy.dialects.postgresql import BIT
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import Agent, Client, ClientRoom, require_tenant_id

# How many clients a tenant runs and what they are, as one pair of numbers:
# the count, and the sum of a 60-bit hash of each client's id, type and name
# and of its agent's id, name, display name and description. Equal pairs mean
# no client was added, removed or renamed and no agent was added, removed or
# re-described in between. Computed by the database, so reading it costs one
# row however many clients the tenant has.
Fingerprint = tuple[int, int]

_FIELD_SEPARATOR = "\x1f"


def _row_hash() -> ColumnElement[int]:
    fields = func.concat_ws(
        _FIELD_SEPARATOR,
        Client.id,
        Client.type,
        Client.display_name,
        func.coalesce(Agent.id, ""),
        func.coalesce(Agent.name, ""),
        func.coalesce(Agent.display_name, ""),
        func.coalesce(Agent.description, ""),
    )
    # The first 15 hex digits of the md5, read as a 60-bit number.
    return cast(
        cast(literal("x") + func.substr(func.md5(fields), 1, 15), BIT(60)),
        BigInteger,
    )


class ClientStore:
    async def get_all(self, session: AsyncSession) -> list[Client]:
        result = await session.execute(select(Client))
        return list(result.scalars().all())

    async def get(self, session: AsyncSession, client_id: str) -> Client | None:
        return await session.get(Client, client_id)

    async def get_many(
        self, session: AsyncSession, tenant_id: str, client_ids: Collection[str]
    ) -> list[Client]:
        """The tenant's clients among `client_ids`, in one query. An id with
        no row in the tenant is left out."""
        if not client_ids:
            return []
        result = await session.execute(
            select(Client).where(
                Client.tenant_id == tenant_id, Client.id.in_(list(client_ids))
            )
        )
        return list(result.scalars().all())

    async def get_running(
        self, session: AsyncSession, tenant_id: str, excluded_types: Collection[str]
    ) -> tuple[list[Client], Fingerprint]:
        """The tenant's clients of every type but `excluded_types`, and the
        fingerprint of those rows, from one statement and so from one
        snapshot of the table."""
        result = await session.execute(
            select(Client, func.count().over(), func.sum(_row_hash()).over())
            .outerjoin(Agent, Agent.client_id == Client.id)
            .where(Client.tenant_id == tenant_id, Client.type.not_in(excluded_types))
        )
        rows = result.all()
        if not rows:
            return [], (0, 0)
        return [row[0] for row in rows], (int(rows[0][1]), int(rows[0][2]))

    async def fingerprint(
        self, session: AsyncSession, tenant_id: str, excluded_types: Collection[str]
    ) -> Fingerprint:
        """The fingerprint `get_running` returns, without the rows."""
        result = await session.execute(
            select(func.count(), func.coalesce(func.sum(_row_hash()), 0))
            .select_from(Client)
            .outerjoin(Agent, Agent.client_id == Client.id)
            .where(Client.tenant_id == tenant_id, Client.type.not_in(excluded_types))
        )
        count, total = result.one()
        return int(count), int(total)

    async def get_by_transport_user_id(
        self, session: AsyncSession, transport_user_id: str
    ) -> Client | None:
        """Resolve a client by its participant id (`transport_user_id`) within the bound tenant.

        Scoped explicitly rather than left to row-level security:
        `matrix_user_id` is unique per tenant
        (`uq_clients_tenant_matrix_user_id`), not globally, so the moment a
        second tenant has a client with the same human actor id, an unfiltered read
        here matches both rows and raises `MultipleResultsFound` out of
        message routing and provisioning, which resolve the sending client
        from an inbound event this way.
        """
        result = await session.execute(
            select(Client).where(
                Client.tenant_id == require_tenant_id(),
                Client.transport_user_id == transport_user_id,
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
