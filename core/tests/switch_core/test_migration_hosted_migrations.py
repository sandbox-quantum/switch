"""The hosted migrations revision (`c118ea00053c`): up, down, up again.

It adds the `hosted_migrations` table and
`machine_workspaces.moving_from_controller_id`, and lets
`cloud_machines.stop_reason` be `migration` (the move's hold). The downgrade refuses while a move is
unfinished or a machine is frozen for one, since it would drop what a rollback
needs; with none, it restores the old check and drops the table.
"""

from __future__ import annotations

import pytest
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.switch_core.test_migration_cloud_machine_backend import (
    _CORE,
    _drop,
    _engine,
    _move,
    _script,
)

_BEFORE = "97c1c62e3ca3"
_UNDER_TEST = "c118ea00053c"


def test_the_revision_is_expand_only() -> None:
    """An older Core may serve a database at this revision."""
    revision = _script(Config(str(_CORE / "alembic.ini"))).get_revision(_UNDER_TEST)
    assert revision is not None
    assert revision.module.expand_only is True
    assert revision.down_revision == _BEFORE


async def _shape(engine: AsyncEngine) -> tuple[bool, str]:
    """Whether the table and the workspace column are there, and the
    stop-reason check's definition."""
    async with engine.begin() as connection:
        table = (
            await connection.execute(
                text(
                    "SELECT to_regclass('hosted_migrations') IS NOT NULL AND EXISTS ("
                    "SELECT 1 FROM information_schema.columns "
                    "WHERE table_name = 'machine_workspaces' "
                    "AND column_name = 'moving_from_controller_id')"
                )
            )
        ).scalar_one()
        check = (
            await connection.execute(
                text(
                    "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                    "WHERE conname = 'ck_cloud_machine_stop_reason'"
                )
            )
        ).scalar_one()
    return bool(table), str(check)


_SEED = (
    "INSERT INTO users (id, name, email, role) VALUES "
    "('u-mig', 'Mig', 'mig@example.test', 'user')",
    "INSERT INTO cloud_machines (id, owner_id, state, desired_state, stop_reason, "
    "active_at) VALUES ('m-mig', 'u-mig', 'stopped', 'stopped', 'migration', now())",
)


async def test_up_down_up(postgres_url: str) -> None:
    engine = await _engine(postgres_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_move(_BEFORE))
        table, check = await _shape(engine)
        assert not table and "'migration'" not in check

        async with engine.begin() as connection:
            await connection.run_sync(_move(_UNDER_TEST))
        table, check = await _shape(engine)
        assert table and "'migration'" in check and "'paused'" in check

        async with engine.begin() as connection:
            await connection.run_sync(_move(_BEFORE, down=True))
        table, check = await _shape(engine)
        assert not table and "'migration'" not in check

        async with engine.begin() as connection:
            await connection.run_sync(_move(_UNDER_TEST))
        assert (await _shape(engine))[0]
    finally:
        await engine.dispose()
        await _drop(postgres_url)


async def test_the_downgrade_refuses_while_a_machine_is_frozen_for_a_move(
    postgres_url: str,
) -> None:
    engine = await _engine(postgres_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_move(_UNDER_TEST))
            for statement in _SEED:
                await connection.execute(text(statement))
        with pytest.raises(RuntimeError, match="Refusing to downgrade"):
            async with engine.begin() as connection:
                await connection.run_sync(_move(_BEFORE, down=True))
        assert (await _shape(engine))[0]
    finally:
        await engine.dispose()
        await _drop(postgres_url)
