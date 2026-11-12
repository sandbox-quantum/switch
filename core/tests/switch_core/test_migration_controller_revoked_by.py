"""The controller revoked-by migration (`e11b7c3d9a2f`): up, down, up again.

The column arrives nullable with its check, so existing rows read NULL (never woken
by a lift) and only `pause` and `turn_off` are accepted; the downgrade drops
both cleanly.
"""

from __future__ import annotations

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

_BEFORE = "a90e3df4fe3f"
_UNDER_TEST = "e11b7c3d9a2f"


def test_the_revision_is_expand_only() -> None:
    """An older Core may serve a database at this revision."""
    revision = _script(Config(str(_CORE / "alembic.ini"))).get_revision(_UNDER_TEST)
    assert revision is not None
    assert revision.module.expand_only is True
    assert revision.down_revision == _BEFORE


async def _shape(engine: AsyncEngine) -> tuple[str | None, str | None]:
    """The column's nullability, and the check's definition, or None for each."""
    async with engine.begin() as connection:
        nullable = (
            await connection.execute(
                text(
                    "SELECT is_nullable FROM information_schema.columns "
                    "WHERE table_name = 'agent_controllers' AND column_name = 'revoked_by'"
                )
            )
        ).scalar_one_or_none()
        check = (
            await connection.execute(
                text(
                    "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                    "WHERE conname = 'ck_agent_controllers_revoked_by'"
                )
            )
        ).scalar_one_or_none()
    return nullable, check


async def test_up_down_up(postgres_url: str) -> None:
    engine = await _engine(postgres_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_move(_BEFORE))
        assert await _shape(engine) == (None, None)

        async with engine.begin() as connection:
            await connection.run_sync(_move(_UNDER_TEST))
        nullable, check = await _shape(engine)
        assert nullable == "YES"
        # Only the two hosted blocks, or NULL (`ck_agent_controllers_revoked_by`).
        assert check is not None and "'pause'" in check and "'turn_off'" in check
        assert "IS NULL" in check and "'paused'" not in check

        async with engine.begin() as connection:
            await connection.run_sync(_move(_BEFORE, down=True))
        assert await _shape(engine) == (None, None)

        async with engine.begin() as connection:
            await connection.run_sync(_move(_UNDER_TEST))
        assert (await _shape(engine))[0] == "YES"
    finally:
        await engine.dispose()
        await _drop(postgres_url)
