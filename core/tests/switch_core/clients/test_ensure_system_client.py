"""`ensure_system_client` is per tenant, and had no test at all (CHOO-2623).

`main.run` calls it on every boot with nothing bound. Before this, that was a
read of "does a client of this type exist anywhere" followed by a
`Client(...)` with no `tenant_id` — which, once the tenant column stopped
falling back to tenant zero, raised `TenantNotBoundError` and killed the
process before it ever served a request. Only on a *fresh* database: a
seeded one short-circuits on the read, which is why nothing noticed.

So there are two things to pin. The boot case — an empty database gets an
admin client rather than an exception — and the shape the design actually
asks for: `clients` is scoped, so this is one row per tenant, and a second
tenant with no admin client of its own is not served by the first tenant's.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.db.models import TENANT_ZERO_ID, Client, Tenant
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.tenant_store import TenantStore
from switch_core.tenant_context import current_tenant_id


def _service(
    session_factory: async_sessionmaker[AsyncSession],
) -> ClientLifecycleService:
    return ClientLifecycleService(
        matrix_admin=MagicMock(),
        client_store=ClientStore(),
        tenant_store=TenantStore(),
        client_factory=MagicMock(),
        session_factory=session_factory,
        config=SimpleNamespace(matrix_server_name="test"),  # type: ignore[arg-type]
    )


async def _admin_clients(
    session_factory: async_sessionmaker[AsyncSession],
) -> list[Client]:
    async with session_factory() as session:
        result = await session.execute(
            select(Client).where(Client.type == "admin").order_by(Client.tenant_id)
        )
        return list(result.scalars().all())


async def _make_tenant(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str
) -> None:
    async with session_factory() as session:
        session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
        await session.commit()


@pytest.mark.no_ambient_tenant
async def test_a_fresh_database_gets_an_admin_client_rather_than_an_exception(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The boot case, verbatim: nothing bound, no client anywhere, one
    tenant. This is the call that took the process down."""
    await _service(session_factory).ensure_system_client("admin")

    clients = await _admin_clients(session_factory)
    assert [c.tenant_id for c in clients] == [TENANT_ZERO_ID]
    assert clients[0].matrix_user_id == "@switch-admin:test"


@pytest.mark.no_ambient_tenant
async def test_each_tenant_gets_its_own_row(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Not "one exists, so we are done": a tenant whose rooms have no admin
    client in them has nothing to provision or narrate them."""
    other = f"tenant-{uuid.uuid4().hex[:8]}"
    await _make_tenant(session_factory, other)

    await _service(session_factory).ensure_system_client("admin")

    clients = await _admin_clients(session_factory)
    assert sorted(c.tenant_id for c in clients) == sorted([TENANT_ZERO_ID, other])


@pytest.mark.no_ambient_tenant
async def test_it_is_idempotent_and_fills_only_the_gap(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Every boot runs this. A second pass adds nothing, and a tenant
    onboarded between two boots gets the row the first pass could not have
    made."""
    service = _service(session_factory)
    await service.ensure_system_client("admin")
    await service.ensure_system_client("admin")
    assert [c.tenant_id for c in await _admin_clients(session_factory)] == [
        TENANT_ZERO_ID
    ]

    latecomer = f"tenant-{uuid.uuid4().hex[:8]}"
    await _make_tenant(session_factory, latecomer)
    await service.ensure_system_client("admin")

    clients = await _admin_clients(session_factory)
    assert sorted(c.tenant_id for c in clients) == sorted([TENANT_ZERO_ID, latecomer])


@pytest.mark.no_ambient_tenant
async def test_nothing_stays_bound_afterwards(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """It binds a tenant per row it creates and releases it: startup carries
    on into work that must not inherit whichever tenant happened to be last."""
    await _make_tenant(session_factory, f"tenant-{uuid.uuid4().hex[:8]}")
    await _service(session_factory).ensure_system_client("admin")
    assert current_tenant_id() is None


@pytest.mark.no_ambient_tenant
async def test_a_tenant_created_after_startup_gets_a_working_admin_client(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Bug 2, arranged the way it happened live: boot runs once, against
    whatever tenants exist then, and a second tenant onboards while the
    process keeps running — no second boot in between.

    Before `create_tenant`, the only way a tenant came into existence was a
    row inserted directly (`_make_tenant`, above, is exactly that), and
    nothing woke `ensure_system_client` up to notice it short of the next
    restart. Routing creation through the service instead means the tenant
    has a working admin client — a real row, addressed by the tenant id this
    call itself minted, not "some client exists somewhere" — by the time this
    returns.
    """
    service = _service(session_factory)
    await service.ensure_system_client("admin")  # the boot-time call

    tenant = await service.create_tenant(name="Acme", slug="acme")

    clients = await _admin_clients(session_factory)
    assert sorted(c.tenant_id for c in clients) == sorted([TENANT_ZERO_ID, tenant.id])
    acme_client = next(c for c in clients if c.tenant_id == tenant.id)
    assert acme_client.matrix_user_id == "@switch-admin:test"
