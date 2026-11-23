"""`c18f5ebeef66` lets `decision_settings.backend` hold `self_hosted` and
`gemini`; its downgrade deletes the rows that chose either and narrows the
CHECK again."""

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
_DB = "migration_decision_open_choices"

_PRE_MIGRATION_REVISION = "a3f9c2d71e08"
_MIGRATION_UNDER_TEST = "c18f5ebeef66"


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


async def _insert(connection: AsyncConnection, tenant: str, backend: str) -> None:
    await connection.execute(
        text("INSERT INTO decision_settings (tenant_id, backend) VALUES (:t, :b)"),
        {"t": tenant, "b": backend},
    )


async def _backends(connection: AsyncConnection) -> dict[str, str]:
    rows = await connection.execute(
        text("SELECT tenant_id, backend FROM decision_settings")
    )
    return {tenant: backend for tenant, backend in rows}


async def test_upgrades_and_downgrades(database_url: str) -> None:
    engine = create_async_engine(database_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(
                _migrate(_PRE_MIGRATION_REVISION, downgrade=False)
            )
            for tenant in ("a", "b", "c"):
                await connection.execute(
                    text("INSERT INTO tenants (id, slug, name) VALUES (:t, :t, :t)"),
                    {"t": tenant},
                )
            await _insert(connection, "a", "haiku_bedrock")
            with pytest.raises(Exception, match="ck_decision_settings_backend"):
                async with connection.begin_nested():
                    await _insert(connection, "b", "self_hosted")

        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_MIGRATION_UNDER_TEST, downgrade=False))
            await _insert(connection, "b", "self_hosted")
            await _insert(connection, "c", "gemini")
            assert await _backends(connection) == {
                "a": "haiku_bedrock",
                "b": "self_hosted",
                "c": "gemini",
            }
            with pytest.raises(Exception, match="ck_decision_settings_backend"):
                async with connection.begin_nested():
                    await connection.execute(
                        text(
                            "UPDATE decision_settings SET backend = 'elsewhere' "
                            "WHERE tenant_id = 'a'"
                        )
                    )

        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_PRE_MIGRATION_REVISION, downgrade=True))
            assert await _backends(connection) == {"a": "haiku_bedrock"}
            with pytest.raises(Exception, match="ck_decision_settings_backend"):
                async with connection.begin_nested():
                    await _insert(connection, "b", "gemini")
    finally:
        await engine.dispose()
