"""Purging deleted workspaces' audit history, against real Postgres.

A workspace that exists keeps its history whatever the server's log says; one
deleted more than the horizon ago loses its `audit_events` but not the
server's row recording the deletion; one deleted more recently keeps it all.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.audit import ServerAuditAction
from switch_core.db.models import AuditEvent, ServerAuditEvent, Tenant
from switch_core.db.session_scope import tenant_session
from switch_core.retention.audit_history import (
    AUDIT_HISTORY_HORIZON,
    check_purge_privilege,
    purge_deleted_workspace_history,
)
from switch_core.tenant_context import no_tenant
from tests.conftest import RLSHarness

NOW = datetime(2026, 10, 6, 12, 0, tzinfo=UTC)

LIVE = "audit-history-live"
LONG_GONE = "audit-history-long-gone"
RECENTLY_GONE = "audit-history-recently-gone"


async def _history(sessions: async_sessionmaker[AsyncSession], tenant_id: str) -> None:
    async with tenant_session(sessions, tenant_id) as session:
        session.add(
            AuditEvent(
                action="member.removed",
                target_type="user",
                target_id="someone",
                occurred_at=NOW - timedelta(days=1000),
            )
        )
        session.add(
            AuditEvent(
                action="tenant.deleted",
                target_type="tenant",
                target_id=tenant_id,
                occurred_at=NOW - timedelta(days=900),
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
                    occurred_at=NOW - ago,
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


async def _server_rows(sessions: async_sessionmaker[AsyncSession]) -> int:
    with no_tenant():
        async with sessions() as session:
            return int(
                await session.scalar(select(func.count()).select_from(ServerAuditEvent))
                or 0
            )


async def _live_tenant(sessions: async_sessionmaker[AsyncSession]) -> None:
    with no_tenant():
        async with sessions() as session:
            session.add(Tenant(id=LIVE, slug=LIVE, name=LIVE))
            await session.commit()


@pytest.mark.asyncio
async def test_only_workspaces_deleted_beyond_the_horizon_lose_their_history(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _live_tenant(session_factory)
    for tenant_id in (LIVE, LONG_GONE, RECENTLY_GONE):
        await _history(session_factory, tenant_id)
    # A live workspace with an old deletion on file (deleted, then a
    # workspace with the same id made again) is still never touched.
    await _deleted(session_factory, LIVE, AUDIT_HISTORY_HORIZON + timedelta(days=30))
    await _deleted(
        session_factory, LONG_GONE, AUDIT_HISTORY_HORIZON + timedelta(days=1)
    )
    await _deleted(
        session_factory, RECENTLY_GONE, AUDIT_HISTORY_HORIZON - timedelta(days=1)
    )

    purged = await purge_deleted_workspace_history(session_factory, NOW)

    assert purged == 2
    assert await _audit_rows(session_factory, LIVE) == 2
    assert await _audit_rows(session_factory, LONG_GONE) == 0
    assert await _audit_rows(session_factory, RECENTLY_GONE) == 2
    assert await _server_rows(session_factory) == 3

    assert await purge_deleted_workspace_history(session_factory, NOW) == 0


@pytest.mark.asyncio
async def test_the_owner_may_purge_and_the_runtime_role_may_not(
    rls_harness: RLSHarness, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.ERROR, logger="switch_core.retention.audit_history"):
        assert await check_purge_privilege(rls_harness.owner_engine, owner=True)
        assert not caplog.records

        assert not await check_purge_privilege(
            rls_harness.restricted_engine, owner=False
        )
    assert "will NOT be purged" in caplog.text
    assert "DB_OWNER_USER" in caplog.text


@pytest.mark.asyncio
async def test_the_runtime_role_cannot_purge_and_says_so(
    rls_harness: RLSHarness,
) -> None:
    await _history(rls_harness.owner, LONG_GONE)
    await _deleted(
        rls_harness.owner, LONG_GONE, AUDIT_HISTORY_HORIZON + timedelta(days=1)
    )

    with pytest.raises(Exception, match="permission denied"):
        await purge_deleted_workspace_history(rls_harness.restricted, NOW)
    assert await _audit_rows(rls_harness.owner, LONG_GONE) == 2
