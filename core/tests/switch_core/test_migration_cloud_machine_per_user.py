"""`b6e1c9d4a7f2` makes a cloud machine its owner's rather than a workspace's.

Each machine keeps its id, its workspace row takes the same id, and its
controller, enrollment code and heartbeat carry over. It refuses a user with
live machines in two workspaces, and its downgrade refuses a machine serving
two.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from alembic.config import Config
from alembic.runtime.environment import EnvironmentContext
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

_CORE = Path(__file__).resolve().parents[2]
_DB = "migration_cloud_machine_per_user"

_BEFORE = "a8c3e5f1d27b"
_UNDER_TEST = "b6e1c9d4a7f2"


def _script_directory(config: Config) -> ScriptDirectory:
    config.set_main_option("script_location", str(_CORE / "switch_core" / "migrations"))
    return ScriptDirectory.from_config(config)


def _migrate(revision: str, downgrade: bool = False) -> Any:
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
async def engine(postgres_url: str) -> Any:
    admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
    async with admin.connect() as connection:
        await connection.execute(text(f'DROP DATABASE IF EXISTS "{_DB}"'))
        await connection.execute(text(f'CREATE DATABASE "{_DB}"'))
    await admin.dispose()
    base, _, _ = postgres_url.rpartition("/")
    engine = create_async_engine(f"{base}/{_DB}")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_BEFORE))
        yield engine
    finally:
        await engine.dispose()
        admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
        async with admin.connect() as connection:
            await connection.execute(text(f'DROP DATABASE IF EXISTS "{_DB}"'))
        await admin.dispose()


async def _run(engine: AsyncEngine, migrate: Any) -> None:
    """Run a migration with foreign keys to tenants, users and controllers,
    which the seeded rows do not have, left unchecked."""
    async with engine.begin() as connection:
        await connection.execute(text("SET LOCAL session_replication_role = replica"))
        await connection.run_sync(migrate)


async def _seed(engine: AsyncEngine, rows: str) -> None:
    async with engine.begin() as connection:
        # Foreign keys to tenants, users and controllers are beside the point here.
        await connection.execute(text("SET LOCAL session_replication_role = replica"))
        await connection.execute(
            text(
                f"""
                INSERT INTO hosted_machines
                    (tenant_id, id, owner_id, state, desired_state, revision,
                     controller_id, enrollment_code_encrypted, enrollment_code_revision,
                     active_at, heartbeat, heartbeat_at)
                VALUES {rows}
                """
            )
        )


HEARTBEAT = json.dumps(
    {
        "disk": {"total_bytes": 10, "available_bytes": 4},
        "memory": None,
        "sessions_running": 2,
    }
)


async def test_each_machine_becomes_its_owners_with_its_workspace_row(
    engine: AsyncEngine,
) -> None:
    await _seed(
        engine,
        f"""('t1', 'm1', 'ada', 'ready', 'running', 3, 'c1', 'sealed', 3, now(),
             '{HEARTBEAT}', '2026-10-09T10:00:00+00:00'),
            ('t1', 'old', 'ada', 'deleted', 'deleted', 9, NULL, NULL, NULL, now(),
             NULL, NULL),
            ('t2', 'm2', 'bob', 'queued', 'running', 1, NULL, NULL, NULL, now(),
             NULL, NULL)""",
    )
    async with engine.begin() as connection:
        await connection.execute(text("SET LOCAL session_replication_role = replica"))
        await connection.execute(
            text(
                "INSERT INTO agent_controller_enrollment_codes "
                "(tenant_id, id, owner_id, expires_at, hosted_machine_id) "
                "VALUES ('t1', 'code-1', 'ada', now(), 'm1')"
            )
        )
    await _run(engine, _migrate(_UNDER_TEST))

    async with engine.connect() as connection:
        machines = (
            await connection.execute(
                text(
                    "SELECT id, owner_id, state, revision, heartbeat "
                    "FROM cloud_machines ORDER BY id"
                )
            )
        ).all()
        workspaces = (
            await connection.execute(
                text(
                    "SELECT tenant_id, id, machine_id, owner_id, controller_id, "
                    "enrollment_code_encrypted, enrollment_code_revision "
                    "FROM machine_workspaces ORDER BY id"
                )
            )
        ).all()
        code = await connection.scalar(
            text(
                "SELECT machine_workspace_id FROM agent_controller_enrollment_codes "
                "WHERE id = 'code-1'"
            )
        )
        tenants = (
            await connection.execute(text("SELECT tenants_of_cloud_machine('m1')"))
        ).all()
        gone = await connection.scalar(text("SELECT to_regclass('hosted_machines')"))

    assert [(row[0], row[1], row[2], row[3]) for row in machines] == [
        ("m1", "ada", "ready", 3),
        ("m2", "bob", "queued", 1),
        ("old", "ada", "deleted", 9),
    ]
    assert machines[0][4] == {
        "disk": {"total_bytes": 10, "available_bytes": 4},
        "memory": None,
        "controllers": {
            "m1": {"at": "2026-10-09T10:00:00+00:00", "sessions_running": 2}
        },
    }
    assert machines[1][4] is None
    assert workspaces == [
        ("t1", "m1", "m1", "ada", "c1", "sealed", 3),
        ("t2", "m2", "m2", "bob", None, None, None),
        ("t1", "old", "old", "ada", None, None, None),
    ]
    assert code == "m1"
    assert tenants == [("t1",)]
    assert gone is None


async def test_refuses_a_user_with_live_machines_in_two_workspaces(
    engine: AsyncEngine,
) -> None:
    await _seed(
        engine,
        """('t1', 'm1', 'ada', 'ready', 'running', 1, NULL, NULL, NULL, now(), NULL, NULL),
           ('t2', 'm2', 'ada', 'stopped', 'stopped', 1, NULL, NULL, NULL, now(), NULL, NULL)""",
    )
    with pytest.raises(RuntimeError, match="1 user\\(s\\) have cloud machines"):
        await _run(engine, _migrate(_UNDER_TEST))


async def test_downgrades_while_each_machine_serves_one_workspace(
    engine: AsyncEngine,
) -> None:
    await _seed(
        engine,
        f"""('t1', 'm1', 'ada', 'ready', 'running', 3, 'c1', 'sealed', 3, now(),
             '{HEARTBEAT}', '2026-10-09T10:00:00+00:00')""",
    )
    await _run(engine, _migrate(_UNDER_TEST))
    async with engine.begin() as connection:
        await connection.execute(text("SET LOCAL session_replication_role = replica"))
        await connection.execute(
            text(
                "INSERT INTO machine_workspaces (tenant_id, id, machine_id, owner_id) "
                "VALUES ('t2', 'w2', 'm1', 'ada')"
            )
        )
    with pytest.raises(RuntimeError, match="serve more than one workspace"):
        await _run(engine, _migrate(_BEFORE, downgrade=True))
    async with engine.begin() as connection:
        await connection.execute(text("DELETE FROM machine_workspaces WHERE id = 'w2'"))
    await _run(engine, _migrate(_BEFORE, downgrade=True))
    async with engine.connect() as connection:
        row = (
            await connection.execute(
                text(
                    "SELECT tenant_id, id, owner_id, state, controller_id, heartbeat "
                    "FROM hosted_machines"
                )
            )
        ).one()
    assert row[:5] == ("t1", "m1", "ada", "ready", "c1")
    assert row[5]["sessions_running"] == 2
