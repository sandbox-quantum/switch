"""Purging deleted workspaces' audit history, against real Postgres.

A workspace that exists keeps its history whatever the server's log says; one
deleted more than the horizon ago loses its `audit_events` but not the
server's row recording the deletion, nor its organization's audit log; one
deleted more recently keeps it all.

The purge is asked of the restricted runtime role, which is what serves in a
deployment: it may not delete an audit row itself, and does so only through
`purge_deleted_workspace_audit_history()` (`db/audit_history_ddl.py`).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.audit import ServerAuditAction
from switch_core.db.audit_history_ddl import PURGE_FUNCTION_NAME
from switch_core.db.models import (
    AuditEvent,
    OrganizationAuditEvent,
    ServerAuditEvent,
    Tenant,
)
from switch_core.db.session_scope import tenant_session
from switch_core.retention.audit_history import (
    AUDIT_HISTORY_HORIZON,
    AuditHistoryPurgeError,
    check_purge_function,
    purge_deleted_workspace_history,
)
from switch_core.tenant_context import no_tenant
from tests.conftest import RLSHarness

LIVE = "audit-history-live"
LONG_GONE = "audit-history-long-gone"
RECENTLY_GONE = "audit-history-recently-gone"
ORGANIZATION = "audit-history-organization"


async def _history(sessions: async_sessionmaker[AsyncSession], tenant_id: str) -> None:
    now = datetime.now(UTC)
    async with tenant_session(sessions, tenant_id) as session:
        session.add(
            AuditEvent(
                action="member.removed",
                target_type="user",
                target_id="someone",
                occurred_at=now - timedelta(days=1000),
            )
        )
        session.add(
            AuditEvent(
                action="tenant.deleted",
                target_type="tenant",
                target_id=tenant_id,
                occurred_at=now - timedelta(days=900),
            )
        )
        await session.commit()


async def _deleted(
    sessions: async_sessionmaker[AsyncSession], tenant_id: str, ago: timedelta
) -> None:
    with no_tenant():
        async with sessions() as session:
            session.add(
                ServerAuditEvent(
                    action=ServerAuditAction.WORKSPACE_DELETED,
                    target_type="tenant",
                    target_id=tenant_id,
                    occurred_at=datetime.now(UTC) - ago,
                )
            )
            await session.commit()


async def _organization_history(sessions: async_sessionmaker[AsyncSession]) -> None:
    with no_tenant():
        async with sessions() as session:
            session.add(
                OrganizationAuditEvent(
                    organization_id=ORGANIZATION,
                    action="workspace.deleted",
                    target_type="tenant",
                    target_id=LONG_GONE,
                    occurred_at=datetime.now(UTC) - timedelta(days=1000),
                )
            )
            await session.commit()


async def _audit_rows(
    sessions: async_sessionmaker[AsyncSession], tenant_id: str
) -> int:
    async with tenant_session(sessions, tenant_id) as session:
        return int(
            await session.scalar(
                select(func.count())
                .select_from(AuditEvent)
                .where(AuditEvent.tenant_id == tenant_id)
            )
            or 0
        )


async def _count(sessions: async_sessionmaker[AsyncSession], model: type) -> int:
    with no_tenant():
        async with sessions() as session:
            return int(
                await session.scalar(select(func.count()).select_from(model)) or 0
            )


async def _live_tenant(sessions: async_sessionmaker[AsyncSession]) -> None:
    with no_tenant():
        async with sessions() as session:
            session.add(Tenant(id=LIVE, slug=LIVE, name=LIVE))
            await session.commit()


async def _runtime_role(rls_harness: RLSHarness) -> str:
    async with rls_harness.restricted_engine.connect() as connection:
        return str((await connection.execute(text("SELECT current_user"))).scalar_one())


@pytest.mark.asyncio
async def test_the_runtime_role_purges_only_workspaces_deleted_beyond_the_horizon(
    rls_harness: RLSHarness, caplog: pytest.LogCaptureFixture
) -> None:
    owner = rls_harness.owner
    await _live_tenant(owner)
    for tenant_id in (LIVE, LONG_GONE, RECENTLY_GONE):
        await _history(owner, tenant_id)
    await _organization_history(owner)
    # A live workspace with an old deletion on file (deleted, then a
    # workspace with the same id made again) is still never touched.
    await _deleted(owner, LIVE, AUDIT_HISTORY_HORIZON + timedelta(days=30))
    await _deleted(owner, LONG_GONE, AUDIT_HISTORY_HORIZON + timedelta(days=1))
    await _deleted(owner, RECENTLY_GONE, AUDIT_HISTORY_HORIZON - timedelta(days=1))

    with caplog.at_level(logging.INFO, logger="switch_core.retention.audit_history"):
        purged = await purge_deleted_workspace_history(rls_harness.restricted)

    assert purged == 2
    assert f"Purged 2 audit rows of workspace {LONG_GONE}" in caplog.text
    assert await _audit_rows(owner, LIVE) == 2
    assert await _audit_rows(owner, LONG_GONE) == 0
    assert await _audit_rows(owner, RECENTLY_GONE) == 2
    assert await _count(owner, ServerAuditEvent) == 3
    assert await _count(owner, OrganizationAuditEvent) == 1

    assert await purge_deleted_workspace_history(rls_harness.restricted) == 0


@pytest.mark.asyncio
async def test_the_runtime_role_still_cannot_delete_audit_rows_itself(
    rls_harness: RLSHarness,
) -> None:
    await _history(rls_harness.owner, LONG_GONE)

    with pytest.raises(DBAPIError, match="permission denied"):
        async with tenant_session(rls_harness.restricted, LONG_GONE) as session:
            await session.execute(text("DELETE FROM audit_events"))
    assert await _audit_rows(rls_harness.owner, LONG_GONE) == 2


@pytest.mark.asyncio
async def test_the_function_takes_nothing_from_its_caller(
    rls_harness: RLSHarness,
) -> None:
    """No argument to widen what it deletes, a pinned `search_path` so a
    temporary table cannot stand in for one it reads, and no `EXECUTE` for
    `PUBLIC` once the runtime role's grants have run."""
    async with rls_harness.restricted_engine.connect() as connection:
        row = (
            await connection.execute(
                text(
                    """
                    SELECT p.prosecdef, pg_get_function_arguments(p.oid),
                           p.proconfig,
                           has_function_privilege('public', p.oid, 'EXECUTE')
                    FROM pg_proc p
                    JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = :name
                    """
                ),
                {"name": PURGE_FUNCTION_NAME},
            )
        ).one()
    definer, arguments, config, public_may_execute = row
    assert definer
    assert arguments == ""
    assert "search_path=pg_catalog, public, pg_temp" in config
    assert not public_may_execute


@pytest.mark.asyncio
async def test_the_startup_check_passes_for_the_runtime_role(
    rls_harness: RLSHarness,
) -> None:
    await check_purge_function(rls_harness.restricted_engine)


@pytest.mark.asyncio
async def test_the_startup_check_refuses_a_role_that_may_not_execute_it(
    rls_harness: RLSHarness,
) -> None:
    role = await _runtime_role(rls_harness)
    async with rls_harness.owner_engine.begin() as connection:
        await connection.execute(
            text(f'REVOKE EXECUTE ON FUNCTION {PURGE_FUNCTION_NAME}() FROM "{role}"')
        )

    with pytest.raises(AuditHistoryPurgeError, match="may not execute"):
        await check_purge_function(rls_harness.restricted_engine)


@pytest.mark.asyncio
async def test_the_startup_check_refuses_a_schema_without_the_function(
    rls_harness: RLSHarness,
) -> None:
    async with rls_harness.owner_engine.begin() as connection:
        await connection.execute(
            text(f"ALTER FUNCTION {PURGE_FUNCTION_NAME}() RENAME TO purge_elsewhere")
        )
    try:
        with pytest.raises(AuditHistoryPurgeError, match="not installed"):
            await check_purge_function(rls_harness.restricted_engine)
    finally:
        async with rls_harness.owner_engine.begin() as connection:
            await connection.execute(
                text(
                    f"ALTER FUNCTION purge_elsewhere() RENAME TO {PURGE_FUNCTION_NAME}"
                )
            )
