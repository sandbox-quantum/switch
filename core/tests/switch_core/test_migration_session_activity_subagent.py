"""`f81d02ce93a7` adds optional subagent metadata to activity items."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from alembic.config import Config
from alembic.runtime.environment import EnvironmentContext
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, text
from sqlalchemy.ext.asyncio import create_async_engine

_CORE = Path(__file__).resolve().parents[2]
_DB = "migration_session_activity_subagent"
_BEFORE = "f3a8d1c6b927"
_UNDER_TEST = "f81d02ce93a7"


def _migrate(revision: str, *, downgrade: bool) -> Any:
    def migrate(connection: Connection) -> None:
        config = Config(str(_CORE / "alembic.ini"))
        config.set_main_option("script_location", str(_CORE / "switch_core" / "migrations"))
        script = ScriptDirectory.from_config(config)

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
async def database_url(postgres_url: str):
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


async def _shape(connection) -> tuple[bool, bool]:
    column = await connection.scalar(
        text(
            "SELECT count(*) FROM information_schema.columns WHERE table_name = "
            "'session_activity_items' AND column_name = 'subagent'"
        )
    )
    constraint = await connection.scalar(
        text(
            "SELECT count(*) FROM pg_constraint WHERE conname = "
            "'ck_session_activity_items_subagent_kind'"
        )
    )
    return column == 1, constraint == 1


async def test_upgrades_and_downgrades(database_url: str) -> None:
    engine = create_async_engine(database_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_BEFORE, downgrade=False))
        async with engine.connect() as connection:
            assert await _shape(connection) == (False, False)

        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_UNDER_TEST, downgrade=False))
        async with engine.connect() as connection:
            assert await _shape(connection) == (True, True)

        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_BEFORE, downgrade=True))
        async with engine.connect() as connection:
            assert await _shape(connection) == (False, False)
    finally:
        await engine.dispose()
