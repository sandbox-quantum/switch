"""Removing a server-side connector is scoped, and says so (CHOO-2623).

`remove()` was the one lifecycle verb the tenant rework did not reach. It
opened a raw session — which inherits the requesting operator's tenant — and
handed it to a store `delete` that returned quietly when it matched nothing.
Under the policies those two make a specific, silent failure: a tenant-A
operator deleting a tenant-B connector matched zero rows and the service
logged "Removed server-side connector <id>".

Two halves, both tested here against the role the policies actually apply to
(`rls_harness.restricted` — the plain fixture connects as the tables' owner
and would pass whether or not a single policy existed):

- the delete refuses to report a removal it did not perform;
- and it refuses *before* the teardown, because `_cores` is a process-wide
  registry holding every tenant's connectors. Tearing down first meant a
  caller from the wrong tenant stopped another tenant's connector and deleted
  its agents, and only then failed to delete the row.
"""

from __future__ import annotations

import logging

import pytest
from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.server_connectors.lifecycle import (
    ServerSideConnectorLifecycleService,
)
from switch_core.db.models import (
    TENANT_ZERO_ID,
    ApiKey,
    ServerConnector,
    Tenant,
    User,
)
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.server_connector_store import ServerConnectorStore
from switch_core.tenant_context import tenant_scope

pytestmark = pytest.mark.no_ambient_tenant

TENANT_B = "11111111-1111-1111-1111-111111111111"


class _SpyCore:
    """Stands in for a running `ConnectorCore` and records being torn down."""

    def __init__(self) -> None:
        self.deleted_agents = False
        self.stopped = False

    async def delete_agents(self) -> None:
        self.deleted_agents = True

    async def stop(self) -> None:
        self.stopped = True


async def _seed_connector(
    owner_factory: async_sessionmaker[AsyncSession], tenant_id: str
) -> str:
    """A connector in `tenant_id`, written as the owner so the fixture itself
    needs no tenant of its own."""
    async with owner_factory() as session:
        if tenant_id != TENANT_ZERO_ID:
            session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
            await session.flush()
        user = User(name=tenant_id, email=f"{tenant_id}@x.test", role="user")
        session.add(user)
        await session.flush()
        await session.execute(
            insert(ApiKey.__table__).values(
                id=f"key-{tenant_id}",
                tenant_id=tenant_id,
                user_id=user.id,
                key_hash=f"hash-{tenant_id}",
                encrypted_key="enc",
                label="server-connector:test",
                type="registration",
            )
        )
        await session.execute(
            insert(ServerConnector.__table__).values(
                id=f"connector-{tenant_id}",
                tenant_id=tenant_id,
                type="test-type",
                display_name="Test Connector",
                connection_config={},
                api_key_id=f"key-{tenant_id}",
                status="active",
            )
        )
        await session.commit()
    return f"connector-{tenant_id}"


def _service(
    session_factory: async_sessionmaker[AsyncSession],
) -> ServerSideConnectorLifecycleService:
    return ServerSideConnectorLifecycleService(
        connector_store=ServerConnectorStore(),
        api_key_store=ApiKeyStore(),
        protocol=None,  # type: ignore[arg-type]
        session_factory=session_factory,
        encryption_secret="s" * 32,
    )


async def _still_there(
    owner_factory: async_sessionmaker[AsyncSession], connector_id: str
) -> bool:
    async with owner_factory() as session:
        row = (
            await session.execute(
                select(ServerConnector.id).where(ServerConnector.id == connector_id)
            )
        ).first()
    return row is not None


class TestRemovingAnotherTenantsConnector:
    async def test_it_raises_rather_than_reporting_a_removal(
        self, rls_harness, caplog: pytest.LogCaptureFixture
    ) -> None:
        connector_id = await _seed_connector(rls_harness.owner, TENANT_B)
        service = _service(rls_harness.restricted)

        with caplog.at_level(logging.INFO, logger=service.__module__):
            with tenant_scope(TENANT_ZERO_ID):
                with pytest.raises(ValueError, match="Connector not found"):
                    await service.remove(connector_id)

        assert await _still_there(rls_harness.owner, connector_id)
        assert not any(
            "Removed server-side connector" in r.getMessage() for r in caplog.records
        ), "reported a removal that did not happen"

    async def test_it_does_not_tear_the_connector_down_first(self, rls_harness) -> None:
        """`_cores` spans tenants, so an authorization failure discovered
        after the teardown is a cross-tenant outage with a 500 attached."""
        connector_id = await _seed_connector(rls_harness.owner, TENANT_B)
        service = _service(rls_harness.restricted)
        core = _SpyCore()
        service._cores[connector_id] = core  # type: ignore[assignment]

        with tenant_scope(TENANT_ZERO_ID):
            with pytest.raises(ValueError):
                await service.remove(connector_id)

        assert not core.deleted_agents
        assert not core.stopped
        assert service._cores[connector_id] is core


class TestRemovingYourOwn:
    async def test_it_deletes_the_row_and_tears_the_core_down(
        self, rls_harness
    ) -> None:
        connector_id = await _seed_connector(rls_harness.owner, TENANT_B)
        service = _service(rls_harness.restricted)
        core = _SpyCore()
        service._cores[connector_id] = core  # type: ignore[assignment]

        with tenant_scope(TENANT_B):
            await service.remove(connector_id)

        assert not await _still_there(rls_harness.owner, connector_id)
        assert core.deleted_agents
        assert core.stopped
        assert connector_id not in service._cores

    async def test_removing_it_twice_is_an_error_not_a_shrug(self, rls_harness) -> None:
        """The second call has nothing to delete, and saying so is the whole
        point: "matched nothing" is also what a cross-tenant delete looks
        like, so it cannot be treated as success anywhere."""
        connector_id = await _seed_connector(rls_harness.owner, TENANT_B)
        service = _service(rls_harness.restricted)

        with tenant_scope(TENANT_B):
            await service.remove(connector_id)
            with pytest.raises(ValueError, match="Connector not found"):
                await service.remove(connector_id)


class TestTheStore:
    async def test_delete_raises_on_a_row_this_session_cannot_see(
        self, rls_harness
    ) -> None:
        connector_id = await _seed_connector(rls_harness.owner, TENANT_B)

        with tenant_scope(TENANT_ZERO_ID):
            async with rls_harness.restricted() as session:
                with pytest.raises(ValueError, match="Connector not found"):
                    await ServerConnectorStore().delete(session, connector_id)

        assert await _still_there(rls_harness.owner, connector_id)
