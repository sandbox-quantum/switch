"""The running-client registry knows which tenant each client belongs to.

`ClientLifecycleService` holds every tenant's clients in one process-wide
dict, and `ensure_system_client` puts an admin client in it *per tenant*. So
"the running admin client" is not a thing: there are as many as there are
tenants, and picking one by type alone picks a stranger's as readily as your
own.

`room_service` did exactly that, and the result was not a subtly wrong row.
`client_rooms` has a composite foreign key on `(tenant_id, client_id)`, so
offering tenant A's admin client to tenant B's room is a
`ForeignKeyViolationError` — raised from `reconcile_room_clients`, which runs
inline at startup, so the second tenant to own a room stopped the deployment
booting for everyone. The end-to-end proof is in
`tests/switch_core/test_room_service_tenant_bindings.py`; this pins the
registry side of it.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest
from sqlalchemy import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.db.models import TENANT_ZERO_ID, Client, Tenant
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.tenant_store import TenantStore

TENANT_B = "11111111-1111-1111-1111-111111111111"


class _StubClient:
    """A client that stays running until stopped, and touches nothing else.

    It has to actually stay running: `_start_task` puts every client in a task
    that removes it from all three registries if `start` returns or raises, so
    a stub that finished immediately would empty the very dicts under test.
    """

    def __init__(self, record: Client) -> None:
        self.client_id = record.id
        self.matrix_user_id = record.matrix_user_id
        self.display_name = record.display_name
        self._stopped = asyncio.Event()

    async def start(self) -> None:
        await self._stopped.wait()

    async def stop(self) -> None:
        self._stopped.set()


class _StubFactory:
    def create(self, record: Client) -> Any:
        return _StubClient(record)


def _service(
    session_factory: async_sessionmaker[AsyncSession],
) -> ClientLifecycleService:
    return ClientLifecycleService(
        matrix_admin=MagicMock(),
        client_store=ClientStore(),
        tenant_store=TenantStore(),
        client_factory=_StubFactory(),  # type: ignore[arg-type]
        session_factory=session_factory,
        config=SimpleNamespace(matrix_server_name="test"),  # type: ignore[arg-type]
    )


def _record(tenant_id: str, client_id: str) -> Client:
    return Client(
        id=client_id,
        tenant_id=tenant_id,
        matrix_user_id="@switch-admin:test",
        display_name="admin",
        type="admin",
    )


class TestGetByType:
    async def test_it_returns_only_the_named_tenants_clients(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        service = _service(session_factory)
        service.start_client(_record(TENANT_ZERO_ID, "admin-zero"))
        service.start_client(_record(TENANT_B, "admin-b"))
        try:
            assert [
                c.client_id for c in service.get_by_type("admin", TENANT_ZERO_ID)
            ] == ["admin-zero"]
            assert [c.client_id for c in service.get_by_type("admin", TENANT_B)] == [
                "admin-b"
            ]
        finally:
            await service.stop_all()

    async def test_a_tenant_with_no_client_of_that_type_gets_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Not "somebody else's, since there is one running". A tenant with no
        admin client has no admin client, and the caller has to cope with that
        rather than be handed a client it cannot legally reference."""
        service = _service(session_factory)
        service.start_client(_record(TENANT_ZERO_ID, "admin-zero"))
        try:
            assert service.get_by_type("admin", TENANT_B) == []
        finally:
            await service.stop_all()

    async def test_stopping_a_client_forgets_its_tenant_too(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The three registries are keyed alike and must empty alike, or a
        client id reused later inherits a stale tenant."""
        service = _service(session_factory)
        service.start_client(_record(TENANT_ZERO_ID, "admin-zero"))

        await service.stop("admin-zero")

        assert service.get_by_type("admin", TENANT_ZERO_ID) == []
        assert "admin-zero" not in service._client_tenants


@pytest.mark.no_ambient_tenant
async def test_start_all_records_every_tenants_clients_with_their_own_tenant(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Boot reads every tenant's clients in one unscoped pass, so the tenant
    has to come off each row rather than off the context — there isn't one."""
    async with session_factory() as session:
        session.add(Tenant(id=TENANT_B, slug="tenant-b", name="Tenant B"))
        await session.flush()
        for tenant_id, client_id in (
            (TENANT_ZERO_ID, "admin-zero"),
            (TENANT_B, "admin-b"),
        ):
            await session.execute(
                insert(Client.__table__).values(
                    id=client_id,
                    tenant_id=tenant_id,
                    matrix_user_id="@switch-admin:test",
                    display_name="admin",
                    type="admin",
                )
            )
        await session.commit()

    service = _service(session_factory)
    await service.start_all()
    try:
        assert [c.client_id for c in service.get_by_type("admin", TENANT_ZERO_ID)] == [
            "admin-zero"
        ]
        assert [c.client_id for c in service.get_by_type("admin", TENANT_B)] == [
            "admin-b"
        ]
    finally:
        await service.stop_all()
