"""`b193fb2b9cc5` records who saved a workspace's decision settings:
`decision_settings.saved_by`, a user, cleared when that user is deleted. A
row from before has none. The downgrade drops it and keeps the rows."""

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
_DB = "migration_decision_saved_by"

_PRE_MIGRATION_REVISION = "dd2046c13b23"
_MIGRATION_UNDER_TEST = "b193fb2b9cc5"


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


async def _columns(connection: AsyncConnection) -> set[str]:
    rows = await connection.execute(
        text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'decision_settings'"
        )
    )
    return {row[0] for row in rows}


async def _rows(connection: AsyncConnection) -> list[tuple[Any, ...]]:
    rows = await connection.execute(
        text("SELECT tenant_id, backend, saved_by FROM decision_settings ORDER BY 1")
    )
    return [tuple(row) for row in rows]


async def test_upgrades_and_downgrades(database_url: str) -> None:
    engine = create_async_engine(database_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(
                _migrate(_PRE_MIGRATION_REVISION, downgrade=False)
            )
            assert "saved_by" not in await _columns(connection)
            await connection.execute(
                text(
                    "INSERT INTO tenants (id, slug, name) VALUES "
                    "('t', 't', 't'), ('u', 'u', 'u')"
                )
            )
            await connection.execute(
                text(
                    "INSERT INTO users (id, name, email, role) "
                    "VALUES ('ada', 'ada', 'ada@example.invalid', 'user')"
                )
            )
            await connection.execute(
                text(
                    "INSERT INTO decision_settings (tenant_id, backend) "
                    "VALUES ('t', 'none')"
                )
            )

        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_MIGRATION_UNDER_TEST, downgrade=False))
            # A row from before has nobody recorded.
            assert await _rows(connection) == [("t", "none", None)]
            await connection.execute(
                text(
                    "INSERT INTO decision_settings (tenant_id, backend, saved_by) "
                    "VALUES ('u', 'none', 'ada')"
                )
            )
            with pytest.raises(Exception, match="fk_decision_settings_saved_by"):
                async with connection.begin_nested():
                    await connection.execute(
                        text(
                            "UPDATE decision_settings SET saved_by = 'nobody' "
                            "WHERE tenant_id = 't'"
                        )
                    )
            # Deleting the user clears it, and keeps the setting.
            await connection.execute(text("DELETE FROM users WHERE id = 'ada'"))
            assert await _rows(connection) == [("t", "none", None), ("u", "none", None)]
            await connection.execute(
                text(
                    "INSERT INTO users (id, name, email, role) "
                    "VALUES ('bea', 'bea', 'bea@example.invalid', 'user')"
                )
            )
            await connection.execute(
                text(
                    "UPDATE decision_settings SET saved_by = 'bea' WHERE tenant_id = 'u'"
                )
            )

        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_PRE_MIGRATION_REVISION, downgrade=True))
            assert "saved_by" not in await _columns(connection)
            rows = await connection.execute(
                text("SELECT tenant_id FROM decision_settings ORDER BY tenant_id")
            )
            assert [row[0] for row in rows] == ["t", "u"]
    finally:
        await engine.dispose()
