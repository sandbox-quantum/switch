"""`c7715ebb95c9` adds the operator's connector apps, the server audit log and
each connection's OAuth client, and its downgrade takes them away again."""

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
_DB = "migration_connector_app_credentials"

_BEFORE = "98c28a6e7c55"
_UNDER_TEST = "c7715ebb95c9"


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


async def _shape(connection: AsyncConnection) -> tuple[set[str], bool]:
    tables = {
        row[0]
        for row in await connection.execute(
            text(
                "SELECT table_name FROM information_schema.tables WHERE table_name "
                "IN ('service_app_credentials', 'server_audit_events')"
            )
        )
    }
    column = await connection.scalar(
        text(
            "SELECT count(*) FROM information_schema.columns WHERE table_name = "
            "'service_connections' AND column_name = 'oauth_client_id'"
        )
    )
    return tables, column == 1


async def test_upgrades_and_downgrades(database_url: str) -> None:
    engine = create_async_engine(database_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_BEFORE, downgrade=False))
        async with engine.connect() as connection:
            assert await _shape(connection) == (set(), False)

        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_UNDER_TEST, downgrade=False))
        async with engine.connect() as connection:
            assert await _shape(connection) == (
                {"service_app_credentials", "server_audit_events"},
                True,
            )
            protected = await connection.scalar(
                text(
                    "SELECT bool_or(relrowsecurity) FROM pg_class WHERE relname IN "
                    "('service_app_credentials', 'server_audit_events')"
                )
            )
        assert protected is False

        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_BEFORE, downgrade=True))
        async with engine.connect() as connection:
            assert await _shape(connection) == (set(), False)
    finally:
        await engine.dispose()
