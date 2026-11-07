"""`5d2c8a71e9f4` adds `session_activity_items.delivery` without scanning the
table: the check constraint goes in `NOT VALID`, and still holds every row
written after it."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from alembic.config import Config
from alembic.runtime.environment import EnvironmentContext
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

_CORE = Path(__file__).resolve().parents[2]
_DB = "migration_session_activity_message_delivery"

_MIGRATION_UNDER_TEST = "5d2c8a71e9f4"
_CONSTRAINT = "ck_session_activity_items_delivery"


def _script_directory(config: Config) -> ScriptDirectory:
    config.set_main_option("script_location", str(_CORE / "switch_core" / "migrations"))
    return ScriptDirectory.from_config(config)


def _migrate(revision: str, *, down: bool = False) -> Any:
    def migrate(connection: Connection) -> None:
        config = Config(str(_CORE / "alembic.ini"))
        script = _script_directory(config)

        def step(current_revision: str, context: Any) -> Any:
            if down:
                return script._downgrade_revs(revision, current_revision)
            return script._upgrade_revs(revision, current_revision)

        with EnvironmentContext(config, script, fn=step) as environment:
            environment.configure(connection=connection)
            with environment.begin_transaction():
                environment.run_migrations()

    return migrate


@pytest.fixture
async def engine(postgres_url: str) -> Any:
    admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
    async with admin.connect() as connection:
        await connection.execute(text(f'DROP DATABASE IF EXISTS "{_DB}"'))
        await connection.execute(text(f'CREATE DATABASE "{_DB}"'))
    await admin.dispose()

    base, _, _ = postgres_url.rpartition("/")
    engine = create_async_engine(f"{base}/{_DB}")
    try:
        yield engine
    finally:
        await engine.dispose()
        admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
        async with admin.connect() as connection:
            await connection.execute(text(f'DROP DATABASE IF EXISTS "{_DB}"'))
        await admin.dispose()


async def _insert(engine: AsyncEngine, item_id: str, kind: str, delivery: str) -> None:
    async with engine.begin() as connection:
        # Foreign keys are beside the point; the check constraint is the point.
        await connection.execute(text("SET LOCAL session_replication_role = replica"))
        await connection.execute(
            text(
                "INSERT INTO session_activity_items (tenant_id, agent_id, "
                "session_id, turn_id, item_id, kind, revision, status, title, "
                "text, occurred_at, delivery) VALUES ('t', 'a', 's', 'u', "
                ":item_id, :kind, 0, 'completed', '', '', now(), :delivery)"
            ),
            {"item_id": item_id, "kind": kind, "delivery": delivery},
        )


async def test_the_constraint_skips_the_scan_and_holds_new_rows(
    engine: AsyncEngine,
) -> None:
    async with engine.begin() as connection:
        await connection.run_sync(_migrate(_MIGRATION_UNDER_TEST))

    async with engine.connect() as connection:
        validated = await connection.scalar(
            text("SELECT convalidated FROM pg_constraint WHERE conname = :name"),
            {"name": _CONSTRAINT},
        )
    # NOT VALID: added without reading the rows already there.
    assert validated is False

    await _insert(engine, "steered", "user-message", "steered")
    with pytest.raises(IntegrityError, match=_CONSTRAINT):
        await _insert(engine, "not-a-message", "assistant-message", "steered")
    with pytest.raises(IntegrityError, match=_CONSTRAINT):
        await _insert(engine, "unknown", "user-message", "forwarded")


async def test_the_revision_is_expand_only_and_goes_back_cleanly(
    engine: AsyncEngine,
) -> None:
    script = _script_directory(Config(str(_CORE / "alembic.ini")))
    assert script.get_revision(_MIGRATION_UNDER_TEST).module.expand_only is True

    down_revision = script.get_revision(_MIGRATION_UNDER_TEST).down_revision
    assert isinstance(down_revision, str)
    async with engine.begin() as connection:
        await connection.run_sync(_migrate(_MIGRATION_UNDER_TEST))
    async with engine.begin() as connection:
        await connection.run_sync(_migrate(down_revision, down=True))

    async with engine.connect() as connection:
        column = await connection.scalar(
            text(
                "SELECT 1 FROM information_schema.columns WHERE table_name = "
                "'session_activity_items' AND column_name = 'delivery'"
            )
        )
        constraint = await connection.scalar(
            text("SELECT 1 FROM pg_constraint WHERE conname = :name"),
            {"name": _CONSTRAINT},
        )
    assert column is None
    assert constraint is None
