"""`d7a3c1e9f205` adds the mid-turn steering setting, the delivery label on
activity rows and `steered_message_marks` under row-level security, and its
downgrade takes them away again."""

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
_DB = "migration_mid_turn_steering"

_PRE_MIGRATION_REVISION = "b7e2c4a9d1f6"
_MIGRATION_UNDER_TEST = "d7a3c1e9f205"


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


async def _columns(connection: AsyncConnection) -> set[tuple[str, str]]:
    rows = await connection.execute(
        text(
            "SELECT table_name, column_name FROM information_schema.columns "
            "WHERE (table_name, column_name) IN "
            "(('agents', 'mid_turn_delivery'), ('session_activity_items', 'delivery'))"
        )
    )
    return {(table, column) for table, column in rows}


async def _marks_table(connection: AsyncConnection) -> list[tuple[bool, int]]:
    rows = await connection.execute(
        text(
            "SELECT c.relrowsecurity, "
            "(SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname "
            "AND p.policyname = 'tenant_isolation') "
            "FROM pg_class c WHERE c.relname = 'steered_message_marks' AND c.relkind = 'r'"
        )
    )
    return [(secured, policies) for secured, policies in rows]


async def test_upgrades_and_downgrades(database_url: str) -> None:
    engine = create_async_engine(database_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(
                _migrate(_PRE_MIGRATION_REVISION, downgrade=False)
            )
            assert await _columns(connection) == set()
            assert await _marks_table(connection) == []

        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_MIGRATION_UNDER_TEST, downgrade=False))
            assert await _columns(connection) == {
                ("agents", "mid_turn_delivery"),
                ("session_activity_items", "delivery"),
            }
            assert await _marks_table(connection) == [(True, 1)]
            default = await connection.scalar(
                text(
                    "SELECT column_default FROM information_schema.columns "
                    "WHERE table_name = 'agents' AND column_name = 'mid_turn_delivery'"
                )
            )
            assert default is not None and "steer" in default
            checks = set(
                (
                    await connection.execute(
                        text(
                            "SELECT conname FROM pg_constraint WHERE conname IN "
                            "('ck_agents_mid_turn_delivery', "
                            "'ck_session_activity_items_delivery')"
                        )
                    )
                ).scalars()
            )
            assert checks == {
                "ck_agents_mid_turn_delivery",
                "ck_session_activity_items_delivery",
            }

        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_PRE_MIGRATION_REVISION, downgrade=True))
            assert await _columns(connection) == set()
            assert await _marks_table(connection) == []
    finally:
        await engine.dispose()
