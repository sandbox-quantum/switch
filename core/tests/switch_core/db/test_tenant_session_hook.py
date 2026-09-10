"""The `after_begin` hook (`db/tenant_session.py`): it stamps `app.tenant_id`
on a transaction while the bound context says so, releases it at commit, and
— the exact prior-art bug this design exists to prevent — must not let a
tenant leak from one session into the next session that reuses the same
pooled connection.

Uses its own single-connection engine (`pool_size=1, max_overflow=0`) rather
than the shared `session_factory` fixture, so "the next session reuses the
same physical connection" is guaranteed rather than incidental — verified
directly below via `pg_backend_pid()`.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from switch_core.db.base import Base
from switch_core.db.engine import create_session_factory
from switch_core.tenant_context import tenant_scope

TENANT_A = "tenant-hook-a"


@pytest_asyncio.fixture
async def single_connection_session_factory(
    postgres_url: str,
) -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine(postgres_url, pool_size=1, max_overflow=0)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        # Goes through the production factory constructor so the
        # after_begin hook is registered, same as the shared fixture.
        yield create_session_factory(engine)
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


async def _current_setting(session: AsyncSession) -> str | None:
    result = await session.execute(
        text("SELECT current_setting('app.tenant_id', true)")
    )
    value = result.scalar_one()
    return value or None


async def _pid_and_setting(session: AsyncSession) -> tuple[int, str | None]:
    result = await session.execute(
        text("SELECT pg_backend_pid(), current_setting('app.tenant_id', true)")
    )
    pid, value = result.one()
    return pid, (value or None)


class TestTenantSetOnBeginAndReleasedOnCommit:
    async def test_tenant_is_visible_inside_the_transaction(
        self, single_connection_session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with single_connection_session_factory() as session:
            with tenant_scope(TENANT_A):
                assert await _current_setting(session) == TENANT_A
            await session.commit()

    async def test_tenant_is_released_once_the_transaction_commits(
        self, single_connection_session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with single_connection_session_factory() as session:
            with tenant_scope(TENANT_A):
                await _current_setting(session)  # begins the transaction
            await session.commit()

            # Same session, same connection, a new transaction — and by now
            # the context that set it has been unbound (the `with` above
            # exited before the commit).
            assert await _current_setting(session) is None


class TestNoLeakAcrossAPooledConnection:
    async def test_a_reused_connection_does_not_inherit_the_previous_tenant(
        self, single_connection_session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with single_connection_session_factory() as session:
            with tenant_scope(TENANT_A):
                pid_a, setting_a = await _pid_and_setting(session)
            assert setting_a == TENANT_A
            await session.commit()

        # A second session, opened after the first is closed, with no tenant
        # bound at all — e.g. a system session doing auth resolution, or a
        # background job that has not been converted to bind one yet. With a
        # pool of exactly one connection this must be the same physical
        # connection the first session used.
        async with single_connection_session_factory() as session:
            pid_b, setting_b = await _pid_and_setting(session)
            assert pid_b == pid_a, "the pool did not actually reuse the connection"
            assert setting_b is None
