"""The cloud machine backend migration (`a90e3df4fe3f`): up, down, up again.

Existing rows become `vm`, an older Core's insert (which never names the
column) still works and reads `vm`, only `vm` and `box` are accepted, and the
downgrade refuses while any `box` row exists.
"""

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
_MIGRATION_DB = "migration_cloud_machine_backend"
_BEFORE = "eb7e622cf3b0"
_UNDER_TEST = "a90e3df4fe3f"


def _script(config: Config) -> ScriptDirectory:
    config.set_main_option("script_location", str(_CORE / "switch_core" / "migrations"))
    return ScriptDirectory.from_config(config)


def _move(revision: str, *, down: bool = False) -> Any:
    def move(connection: Connection) -> None:
        config = Config(str(_CORE / "alembic.ini"))
        script = _script(config)

        def step(current: str, context: Any) -> Any:
            if down:
                return script._downgrade_revs(revision, current)
            return script._upgrade_revs(revision, current)

        with EnvironmentContext(config, script, fn=step) as environment:
            environment.configure(connection=connection)
            with environment.begin_transaction():
                environment.run_migrations()

    return move


async def _engine(postgres_url: str) -> AsyncEngine:
    admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
    async with admin.connect() as connection:
        await connection.execute(text(f'DROP DATABASE IF EXISTS "{_MIGRATION_DB}"'))
        await connection.execute(text(f'CREATE DATABASE "{_MIGRATION_DB}"'))
    await admin.dispose()
    base, _, _ = postgres_url.rpartition("/")
    return create_async_engine(f"{base}/{_MIGRATION_DB}")


async def _drop(postgres_url: str) -> None:
    admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
    async with admin.connect() as connection:
        await connection.execute(text(f'DROP DATABASE IF EXISTS "{_MIGRATION_DB}"'))
    await admin.dispose()


def _machine(machine_id: str) -> list[str]:
    """A user and their machine, inserted the way an older Core does: the
    `backend` column is never named."""
    return [
        "INSERT INTO users (id, name, email, role) "
        f"VALUES ('user-{machine_id}', 'u', '{machine_id}@example.test', 'user')",
        "INSERT INTO cloud_machines (id, owner_id, state, desired_state, "
        "active_at, created_at, updated_at) "
        f"VALUES ('{machine_id}', 'user-{machine_id}', 'ready', 'running', "
        "now(), now(), now())",
    ]


async def _backends(engine: AsyncEngine) -> dict[str, str]:
    async with engine.begin() as connection:
        rows = await connection.execute(text("SELECT id, backend FROM cloud_machines"))
        return {row.id: row.backend for row in rows}


def test_the_revision_is_expand_only() -> None:
    """An older Core may serve a database at this revision."""
    revision = _script(Config(str(_CORE / "alembic.ini"))).get_revision(_UNDER_TEST)
    assert revision is not None
    assert revision.module.expand_only is True


async def test_up_down_up(postgres_url: str) -> None:
    engine = await _engine(postgres_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_move(_BEFORE))
            for statement in _machine("m-before"):
                await connection.execute(text(statement))

        async with engine.begin() as connection:
            await connection.run_sync(_move(_UNDER_TEST))
        # The existing row is a v1 machine, and so is an older Core's new one.
        async with engine.begin() as connection:
            for statement in _machine("m-older-core"):
                await connection.execute(text(statement))
        assert await _backends(engine) == {"m-before": "vm", "m-older-core": "vm"}
        async with engine.begin() as connection:
            await connection.execute(
                text("UPDATE cloud_machines SET backend = 'box' WHERE id = 'm-before'")
            )
        with pytest.raises(IntegrityError):
            async with engine.begin() as connection:
                await connection.execute(
                    text(
                        "UPDATE cloud_machines SET backend = 'ec2' WHERE id = 'm-before'"
                    )
                )

        # Down refuses while a box row exists, and changes nothing.
        with pytest.raises(RuntimeError, match="box row"):
            async with engine.begin() as connection:
                await connection.run_sync(_move(_BEFORE, down=True))
        assert (await _backends(engine))["m-before"] == "box"
        async with engine.begin() as connection:
            await connection.execute(
                text("UPDATE cloud_machines SET backend = 'vm' WHERE id = 'm-before'")
            )
            await connection.run_sync(_move(_BEFORE, down=True))

        # And up again.
        async with engine.begin() as connection:
            await connection.run_sync(_move(_UNDER_TEST))
        assert set((await _backends(engine)).values()) == {"vm"}
    finally:
        await engine.dispose()
        await _drop(postgres_url)
