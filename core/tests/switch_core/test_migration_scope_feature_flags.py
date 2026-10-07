"""Scoping feature flags to workspaces keeps every deployment's current values.

Before `9c4e7a1f2b38` a flag row was server-global. The migration copies each
row that was on into every tenant, so a flag that was on for the whole
deployment is still on for each workspace in it, while one that was off leaves
no row that would hide a later server default; and downgrading folds them back into one row that
is on if any workspace had it on.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from alembic.config import Config
from alembic.runtime.environment import EnvironmentContext
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, text
from sqlalchemy.ext.asyncio import create_async_engine

_CORE = Path(__file__).resolve().parents[2]
_MIGRATION_DB = "migration_scope_feature_flags"

_PRE_MIGRATION_REVISION = "eb24eafa59a0"
_MIGRATION_UNDER_TEST = "9c4e7a1f2b38"
_TENANT_ZERO_ID = "00000000-0000-0000-0000-000000000000"


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


async def test_global_flags_are_copied_into_every_workspace_and_back(
    postgres_url: str,
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
                    "INSERT INTO tenants (id, slug, name) "
                    "VALUES ('second', 'second', 'Second')"
                )
            )
            await connection.execute(
                text(
                    "INSERT INTO feature_flags (key, enabled) VALUES "
                    "('ecosystem.show_owners', true), ('retired.flag', false)"
                )
            )

        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_MIGRATION_UNDER_TEST, down=False))

        async with engine.begin() as connection:
            rows = (
                await connection.execute(
                    text(
                        "SELECT tenant_id, key, enabled FROM feature_flags "
                        "ORDER BY tenant_id, key"
                    )
                )
            ).all()
            assert [tuple(r) for r in rows] == [
                (_TENANT_ZERO_ID, "ecosystem.show_owners", True),
                ("second", "ecosystem.show_owners", True),
            ]
            await connection.execute(
                text(
                    "UPDATE feature_flags SET enabled = false "
                    "WHERE tenant_id = 'second' AND key = 'ecosystem.show_owners'"
                )
            )
            await connection.execute(
                text(
                    "INSERT INTO feature_flags (tenant_id, key, enabled) "
                    "VALUES ('second', 'retired.flag', true)"
                )
            )

        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_PRE_MIGRATION_REVISION, down=True))

        async with engine.begin() as connection:
            rows = (
                await connection.execute(
                    text("SELECT key, enabled FROM feature_flags ORDER BY key")
                )
            ).all()
            assert [tuple(r) for r in rows] == [
                ("ecosystem.show_owners", True),
                ("retired.flag", True),
            ]
    finally:
        await engine.dispose()
        async with admin.connect() as connection:
            await connection.execute(text(f'DROP DATABASE IF EXISTS "{_MIGRATION_DB}"'))
        await admin.dispose()
