"""`689d7d8ff913` adds `decision_settings` and `pending_decisions`, each
tenant-scoped under row-level security, and its downgrade drops them."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from alembic.config import Config
from alembic.runtime.environment import EnvironmentContext
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, text
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine

_CORE = Path(__file__).resolve().parents[2]
_DB = "migration_decision_routing"

_PRE_MIGRATION_REVISION = "f68b679599ab"
_MIGRATION_UNDER_TEST = "689d7d8ff913"
_TABLES = ("decision_settings", "pending_decisions")


def _script_directory(config: Config) -> ScriptDirectory:
    config.set_main_option("script_location", str(_CORE / "switch_core" / "migrations"))
    return ScriptDirectory.from_config(config)


def _migrate(revision: str, *, downgrade: bool) -> Any:
    def migrate(connection: Connection) -> None:
        config = Config(str(_CORE / "alembic.ini"))
        script = _script_directory(config)

        def revisions(current_revision: str, context: Any) -> Any:
            if downgrade:
                return script._downgrade_revs(revision, current_revision)
            return script._upgrade_revs(revision, current_revision)

        with EnvironmentContext(config, script, fn=revisions) as environment:
            environment.configure(connection=connection)
            with environment.begin_transaction():
                environment.run_migrations()

    return migrate


@pytest.fixture
async def database_url(postgres_url: str) -> Any:
    admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
    async with admin.connect() as connection:
        await connection.execute(text(f'DROP DATABASE IF EXISTS "{_DB}"'))
        await connection.execute(text(f'CREATE DATABASE "{_DB}"'))
    await admin.dispose()

    base, _, _ = postgres_url.rpartition("/")
    try:
        yield f"{base}/{_DB}"
    finally:
        admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
        async with admin.connect() as connection:
            await connection.execute(text(f'DROP DATABASE IF EXISTS "{_DB}"'))
        await admin.dispose()


async def _tables(connection: AsyncConnection) -> dict[str, bool]:
    """Each table of the two that exists, and whether row-level security is on."""
    rows = await connection.execute(
        text(
            "SELECT relname, relrowsecurity FROM pg_class "
            "WHERE relname = ANY(:names) AND relkind = 'r'"
        ),
        {"names": list(_TABLES)},
    )
    return {name: secured for name, secured in rows}


async def _policies(connection: AsyncConnection) -> set[str]:
    rows = await connection.execute(
        text(
            "SELECT tablename FROM pg_policies "
            "WHERE policyname = 'tenant_isolation' AND tablename = ANY(:names)"
        ),
        {"names": list(_TABLES)},
    )
    return {row[0] for row in rows}


async def test_upgrades_and_downgrades(database_url: str) -> None:
    engine = create_async_engine(database_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(
                _migrate(_PRE_MIGRATION_REVISION, downgrade=False)
            )
            assert await _tables(connection) == {}

        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_MIGRATION_UNDER_TEST, downgrade=False))
            assert await _tables(connection) == dict.fromkeys(_TABLES, True)
            assert await _policies(connection) == set(_TABLES)

        async with engine.begin() as connection:
            await connection.execute(
                text("INSERT INTO tenants (id, slug, name) VALUES ('t', 't', 't')")
            )
            await connection.execute(
                text(
                    "INSERT INTO decision_settings (tenant_id, backend, threshold) "
                    "VALUES ('t', 'none', 0.5)"
                )
            )
            with pytest.raises(Exception, match="ck_decision_settings_backend"):
                async with connection.begin_nested():
                    await connection.execute(
                        text(
                            "INSERT INTO decision_settings (tenant_id, backend) "
                            "VALUES ('t', 'elsewhere')"
                        )
                    )

        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_PRE_MIGRATION_REVISION, downgrade=True))
            assert await _tables(connection) == {}
            assert await _policies(connection) == set()
    finally:
        await engine.dispose()
