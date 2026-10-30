"""`dd2046c13b23` lets a workspace run its decisions on one of its admin's
machines: `decision_settings` gains the controller, the model and when it was
ready, a machine needs both, and its controller must be in the same
workspace. The downgrade puts those workspaces back on the server default."""

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
_DB = "migration_decision_machine"

_PRE_MIGRATION_REVISION = "689d7d8ff913"
_MIGRATION_UNDER_TEST = "dd2046c13b23"


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


async def _seed(connection: AsyncConnection) -> None:
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
            "INSERT INTO agent_controllers (id, tenant_id, owner_id, name, kind) "
            "VALUES ('c1', 't', 'ada', 'Studio Mac', 'console')"
        )
    )


async def test_upgrades_and_downgrades(database_url: str) -> None:
    engine = create_async_engine(database_url)
    added = {"controller_id", "model", "machine_ready_at"}
    try:
        async with engine.begin() as connection:
            await connection.run_sync(
                _migrate(_PRE_MIGRATION_REVISION, downgrade=False)
            )
            assert not added & await _columns(connection)
            await _seed(connection)

        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_MIGRATION_UNDER_TEST, downgrade=False))
            assert added <= await _columns(connection)

        async with engine.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO decision_settings "
                    "(tenant_id, backend, controller_id, model) "
                    "VALUES ('t', 'machine', 'c1', 'qwen3.5-4b-q4_k_m')"
                )
            )
            with pytest.raises(Exception, match="ck_decision_settings_machine"):
                async with connection.begin_nested():
                    await connection.execute(
                        text(
                            "INSERT INTO decision_settings (tenant_id, backend) "
                            "VALUES ('u', 'machine')"
                        )
                    )
            # The machine must be in the same workspace.
            with pytest.raises(Exception, match="fk_decision_settings_controller"):
                async with connection.begin_nested():
                    await connection.execute(
                        text(
                            "INSERT INTO decision_settings "
                            "(tenant_id, backend, controller_id, model) "
                            "VALUES ('u', 'machine', 'c1', 'qwen3.5-4b-q4_k_m')"
                        )
                    )
            with pytest.raises(Exception, match="ck_decision_settings_backend"):
                async with connection.begin_nested():
                    await connection.execute(
                        text(
                            "INSERT INTO decision_settings (tenant_id, backend) "
                            "VALUES ('u', 'elsewhere')"
                        )
                    )
            await connection.execute(
                text(
                    "INSERT INTO decision_settings (tenant_id, backend) "
                    "VALUES ('u', 'none')"
                )
            )

        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_PRE_MIGRATION_REVISION, downgrade=True))
            assert not added & await _columns(connection)
            rows = await connection.execute(
                text("SELECT tenant_id, backend FROM decision_settings")
            )
            # The machine's workspace is back on the server default; the
            # other workspace's choice stays.
            assert [tuple(row) for row in rows] == [("u", "none")]

        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_MIGRATION_UNDER_TEST, downgrade=False))
            await connection.execute(
                text(
                    "INSERT INTO decision_settings "
                    "(tenant_id, backend, controller_id, model) "
                    "VALUES ('t', 'machine', 'c1', 'qwen3.5-4b-q4_k_m')"
                )
            )
            # Deleting the machine (its owner's account deleted) takes the
            # setting with it.
            await connection.execute(text("DELETE FROM agent_controllers"))
            rows = await connection.execute(
                text("SELECT tenant_id FROM decision_settings ORDER BY tenant_id")
            )
            assert [row[0] for row in rows] == ["u"]
    finally:
        await engine.dispose()
