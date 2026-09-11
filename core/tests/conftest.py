from __future__ import annotations

from collections.abc import AsyncIterator, Iterator

import pytest
import pytest_asyncio
from sqlalchemy import insert
from sqlalchemy.ext.asyncio import (
    AsyncConnection,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from testcontainers.postgres import PostgresContainer

# Importing the models module registers every table on Base.metadata so
# create_all provisions the full schema (rooms, room_groups, FKs, …).
import switch_core.db.models  # noqa: F401
from switch_core.db.base import Base
from switch_core.db.models import TENANT_ZERO_ID, Tenant


async def _seed_tenant_zero(conn: AsyncConnection) -> None:
    """Insert the one tenant every scoped row's `tenant_id` default points at.

    Every scoped table's `tenant_id` FK requires a matching `tenants` row, so
    this must run right after the schema exists.
    """
    await conn.execute(
        insert(Tenant.__table__).values(
            id=TENANT_ZERO_ID, slug="default", name="Default"
        )
    )


@pytest.fixture(scope="session")
def postgres_url() -> Iterator[str]:
    """A throwaway PostgreSQL instance for the whole test session.

    Store tests run against real Postgres (not SQLite/mocks) so behaviours like
    `ON DELETE SET NULL` and check constraints are exercised for real.
    """
    with PostgresContainer("postgres:16-alpine") as pg:
        host = pg.get_container_host_ip()
        port = pg.get_exposed_port(5432)
        yield (
            f"postgresql+asyncpg://{pg.username}:{pg.password}"
            f"@{host}:{port}/{pg.dbname}"
        )


@pytest_asyncio.fixture
async def session_factory(
    postgres_url: str,
) -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    """Fresh schema per test: create all tables, yield a session factory, drop."""
    engine = create_async_engine(postgres_url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await _seed_tenant_zero(conn)
    try:
        yield async_sessionmaker(bind=engine, expire_on_commit=False)
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
