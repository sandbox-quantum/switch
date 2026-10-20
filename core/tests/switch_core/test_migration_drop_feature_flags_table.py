"""Dropping the feature_flags table names the flags that were on.

Flags are set at deploy time after `9c4e7a1f2b38`, so a flag a deployment had
switched on through the old table is off after upgrading unless the operator
lists it in FEATURE_FLAGS_ENABLED. The migration says which ones those are.
"""

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
_MIGRATION_DB = "migration_drop_feature_flags_table"

_PRE_MIGRATION_REVISION = "fabf9b9bff78"
_MIGRATION_UNDER_TEST = "9c4e7a1f2b38"


def _script_directory(config: Config) -> ScriptDirectory:
    config.set_main_option("script_location", str(_CORE / "switch_core" / "migrations"))
    return ScriptDirectory.from_config(config)


def _migrate(revision: str, *, down: bool) -> Any:
    def migrate(connection: Connection) -> None:
        config = Config(str(_CORE / "alembic.ini"))
        script = _script_directory(config)

        def do_migrate(current_revision: str, context: Any) -> Any:
            if down:
                return script._downgrade_revs(revision, current_revision)
            return script._upgrade_revs(revision, current_revision)

        with EnvironmentContext(config, script, fn=do_migrate) as environment:
            environment.configure(connection=connection)
            with environment.begin_transaction():
                environment.run_migrations()

    return migrate


async def test_the_flags_that_were_on_are_logged_and_the_table_goes(
    postgres_url: str, caplog: pytest.LogCaptureFixture
) -> None:
    admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
    async with admin.connect() as connection:
        await connection.execute(text(f'DROP DATABASE IF EXISTS "{_MIGRATION_DB}"'))
        await connection.execute(text(f'CREATE DATABASE "{_MIGRATION_DB}"'))
    base, _, _ = postgres_url.rpartition("/")
    engine = create_async_engine(f"{base}/{_MIGRATION_DB}")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_PRE_MIGRATION_REVISION, down=False))
        async with engine.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO feature_flags (key, enabled) VALUES "
                    "('ecosystem.show_owners', true), ('retired.flag', false)"
                )
            )

        with caplog.at_level("WARNING", logger="alembic.runtime.migration"):
            async with engine.begin() as connection:
                await connection.run_sync(_migrate(_MIGRATION_UNDER_TEST, down=False))
        assert "FEATURE_FLAGS_ENABLED: ecosystem.show_owners" in caplog.text
        assert "retired.flag" not in caplog.text

        async with engine.begin() as connection:
            assert (
                await connection.scalar(text("SELECT to_regclass('feature_flags')"))
                is None
            )

        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_PRE_MIGRATION_REVISION, down=True))
        async with engine.begin() as connection:
            assert (
                await connection.scalar(text("SELECT count(*) FROM feature_flags")) == 0
            )
    finally:
        await engine.dispose()
        async with admin.connect() as connection:
            await connection.execute(text(f'DROP DATABASE IF EXISTS "{_MIGRATION_DB}"'))
        await admin.dispose()
