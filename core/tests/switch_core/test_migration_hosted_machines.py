"""`b4e1d7a2c9f0` moves cloud agents onto one machine per user.

It refuses to run while any launch is not removed, since a launch from before
it owns a VM and disk the migration cannot move, and its downgrade restores the
`sleeping` column it drops.
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
_DB = "migration_hosted_machines"

_PRE_MIGRATION_REVISION = "5c1e9b7d3f02"
_MIGRATION_UNDER_TEST = "b4e1d7a2c9f0"


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


async def _columns(connection: Any) -> set[str]:
    rows = await connection.execute(
        text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'hosted_launches'"
        )
    )
    return {row[0] for row in rows}


async def test_refuses_live_launches_then_upgrades_and_downgrades(
    database_url: str,
) -> None:
    engine = create_async_engine(database_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(
                _migrate(_PRE_MIGRATION_REVISION, downgrade=False)
            )

        async with engine.begin() as connection:
            # Foreign keys to tenants and users are beside the point here.
            await connection.execute(
                text("SET LOCAL session_replication_role = replica")
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO hosted_launches
                        (tenant_id, id, owner_id, name, spec, state, desired_state)
                    VALUES ('t', 'req-live', 'u', 'live', '{}', 'stopped', 'stopped'),
                           ('t', 'req-gone', 'u', 'removed:req-gone', '{}',
                            'deleted', 'deleted')
                    """
                )
            )

        with pytest.raises(RuntimeError) as raised:
            async with engine.begin() as connection:
                await connection.run_sync(
                    _migrate(_MIGRATION_UNDER_TEST, downgrade=False)
                )
        assert str(raised.value) == (
            "hosted_machines: 1 cloud agent(s) are not removed. Remove them in "
            "Switch Console, then follow 'Moving to one machine per user' in "
            "deploy/hosted/README.md."
        )

        async with engine.begin() as connection:
            await connection.execute(
                text(
                    "UPDATE hosted_launches SET state = 'deleted', "
                    "desired_state = 'deleted' WHERE id = 'req-live'"
                )
            )
            await connection.run_sync(_migrate(_MIGRATION_UNDER_TEST, downgrade=False))

        async with engine.connect() as connection:
            upgraded = await _columns(connection)
            machine_ids = (
                await connection.execute(text("SELECT machine_id FROM hosted_launches"))
            ).all()
            protected = await connection.scalar(
                text(
                    "SELECT c.relrowsecurity AND EXISTS (SELECT 1 FROM pg_policy p "
                    "WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') "
                    "FROM pg_class c WHERE c.oid = 'hosted_machines'::regclass"
                )
            )

        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_PRE_MIGRATION_REVISION, downgrade=True))

        async with engine.connect() as connection:
            downgraded = await _columns(connection)
            machines = await connection.scalar(
                text("SELECT to_regclass('hosted_machines')")
            )
            sleeping = (
                await connection.execute(text("SELECT sleeping FROM hosted_launches"))
            ).all()
    finally:
        await engine.dispose()

    assert "sleeping" not in upgraded
    assert {"machine_id", "repository", "process_state"} <= upgraded
    assert machine_ids == [(None,), (None,)]
    assert protected
    assert "sleeping" in downgraded
    assert not {"machine_id", "repository", "process_state"} & downgraded
    assert machines is None
    assert sleeping == [(False,), (False,)]
