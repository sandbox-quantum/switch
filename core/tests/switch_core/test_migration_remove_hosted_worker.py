"""`f5d2b8e6c3a1` removes the hosted worker.

It refuses to run while a cloud machine that runs the hosted worker is not
deleted, then drops the worker's tables and columns and the agent providers'
credentials held for it, keeping GitHub connections.
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
_DB = "migration_remove_hosted_worker"

_PRE_MIGRATION_REVISION = "e7a2c4b9d013"
_MIGRATION_UNDER_TEST = "f5d2b8e6c3a1"

_WORKER_TABLES = (
    "hosted_launches",
    "hosted_operations",
    "hosted_wake_mailbox",
    "hosted_cutover_items",
    "hosted_cutover_volumes",
    "github_issued_tokens",
    "provider_verifications",
)


def _script_directory(config: Config) -> ScriptDirectory:
    config.set_main_option("script_location", str(_CORE / "switch_core" / "migrations"))
    return ScriptDirectory.from_config(config)


def _upgrade(revision: str) -> Any:
    def migrate(connection: Connection) -> None:
        config = Config(str(_CORE / "alembic.ini"))
        script = _script_directory(config)

        def revisions(current_revision: str, context: Any) -> Any:
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


async def test_refuses_a_live_worker_machine_then_removes_the_worker(
    database_url: str,
) -> None:
    engine = create_async_engine(database_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade(_PRE_MIGRATION_REVISION))

        async with engine.begin() as connection:
            # Foreign keys to tenants and users are beside the point here.
            await connection.execute(
                text("SET LOCAL session_replication_role = replica")
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO hosted_machines
                        (tenant_id, id, owner_id, slot_id, generation, state,
                         desired_state, runtime, active_at)
                    VALUES ('t', 'worker', 'u', 'slot-a', 1, 'ready', 'running',
                            'worker', now()),
                           ('t', 'controller', 'v', 'slot-b', 1, 'ready',
                            'running', 'controller', now())
                    """
                )
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO provider_connections
                        (tenant_id, user_id, provider, kind, encrypted_credential,
                         verified_at)
                    VALUES ('t', 'u', 'claude', 'api-key', 'sealed', now()),
                           ('t', 'u', 'github', 'oauth', 'sealed', now())
                    """
                )
            )

        with pytest.raises(RuntimeError) as raised:
            async with engine.begin() as connection:
                await connection.run_sync(_upgrade(_MIGRATION_UNDER_TEST))
        assert str(raised.value) == (
            "remove the hosted worker: 0 cloud agent(s) of the hosted worker are "
            "not removed and 1 cloud machine(s) that run it are not deleted. "
            "Remove those cloud agents in Switch Console, wait until their "
            "machines are deleted, then upgrade again."
        )

        async with engine.begin() as connection:
            await connection.execute(
                text(
                    "UPDATE hosted_machines SET state = 'deleted', "
                    "desired_state = 'deleted' WHERE id = 'worker'"
                )
            )
            await connection.run_sync(_upgrade(_MIGRATION_UNDER_TEST))

        async with engine.connect() as connection:
            tables = {
                table: await connection.scalar(
                    text("SELECT to_regclass(:table)"), {"table": table}
                )
                for table in _WORKER_TABLES
            }
            columns = {
                row[0]
                for row in await connection.execute(
                    text(
                        "SELECT column_name FROM information_schema.columns "
                        "WHERE table_name = 'hosted_machines'"
                    )
                )
            }
            machines = (
                await connection.execute(
                    text("SELECT id, state FROM hosted_machines ORDER BY id")
                )
            ).all()
            providers = (
                await connection.execute(
                    text("SELECT provider FROM provider_connections")
                )
            ).all()
    finally:
        await engine.dispose()

    assert tables == dict.fromkeys(_WORKER_TABLES)
    assert (
        not {
            "runtime",
            "machine_capability_hash",
            "machine_capability_encrypted",
            "machine_capability_revision",
            "agents_version",
        }
        & columns
    )
    assert {"controller_id", "enrollment_code_encrypted"} <= columns
    assert machines == [("controller", "ready"), ("worker", "deleted")]
    assert providers == [("github",)]
