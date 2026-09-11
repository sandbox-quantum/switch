"""A client's task owns no tenant (CHOO-2623).

`start_all` reads every tenant's clients in one pass and binds nothing around
starting any of them, because a client is not a single-tenant actor for the
purposes of its own task: it reads which rooms it is in — a lookup keyed by a
globally unique client id — and then works one room at a time, binding that
room's tenant per delivery.

`_run_client` unbinds first, and the creator matters here more than anywhere
else. A puppet client is minted mid-conversation, from inside an inbound
bridge event bound to *that* room's tenant, and then reused for every room the
person it stands for ever speaks in. Whatever the first room was must not
become the client's identity for the rest of its life.
"""

from __future__ import annotations

import asyncio
import uuid
from unittest.mock import MagicMock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.db.models import Client, Tenant
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.tenant_store import TenantStore
from switch_core.tenant_context import current_tenant_id, tenant_scope


class _RecordingClient:
    """Stands in for a running client, noting the tenant it was started under."""

    def __init__(self, seen: list[str | None]) -> None:
        self.display_name = "recorded"
        self.matrix_user_id = "@recorded:test"
        self._seen = seen

    async def start(self) -> None:
        self._seen.append(current_tenant_id())

    async def stop(self) -> None:
        return None


def _service(
    session_factory: async_sessionmaker[AsyncSession],
    client_factory: object,
) -> ClientLifecycleService:
    return ClientLifecycleService(
        matrix_admin=MagicMock(),
        client_store=ClientStore(),
        tenant_store=TenantStore(),
        client_factory=client_factory,  # type: ignore[arg-type]
        session_factory=session_factory,
        config=MagicMock(),
    )


async def test_a_client_task_runs_with_no_tenant_bound(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The puppet case, in miniature: created from inside a room's tenant,
    and it must not keep it."""
    room_tenant = f"tenant-{uuid.uuid4().hex[:8]}"
    seen: list[str | None] = []
    service = _service(session_factory, MagicMock())

    with tenant_scope(room_tenant):
        service._start_task("client-1", _RecordingClient(seen))  # type: ignore[arg-type]
        await asyncio.sleep(0)

    assert seen == [None], (
        "the client's task kept the tenant of whatever created it; a puppet "
        "reused in a second room would act as the first room's tenant"
    )


@pytest.mark.no_ambient_tenant
async def test_start_all_binds_nothing_around_starting_each_client(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Reading every tenant's clients is unscoped, and nothing is bound
    afterwards: whatever the enumeration bound would only decide what each
    task snapshots, which is exactly what must not matter."""
    tenant_a = f"tenant-{uuid.uuid4().hex[:8]}"
    tenant_b = f"tenant-{uuid.uuid4().hex[:8]}"
    async with session_factory() as session:
        for tenant_id in (tenant_a, tenant_b):
            session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
        await session.flush()
        for tenant_id in (tenant_a, tenant_b):
            session.add(
                Client(
                    tenant_id=tenant_id,
                    matrix_user_id=f"@agent-{tenant_id}:test",
                    display_name="agent",
                    type="agent",
                )
            )
        await session.commit()

    seen: list[str | None] = []
    client_factory = MagicMock()
    client_factory.create.side_effect = lambda record: _RecordingClient(seen)

    service = _service(session_factory, client_factory)
    await service.start_all()
    await asyncio.sleep(0)
    await service.stop_all()

    assert len(seen) >= 2, "the clients were never started"
    assert set(seen) == {None}
    assert current_tenant_id() is None
