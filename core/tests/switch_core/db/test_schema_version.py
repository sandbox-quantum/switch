"""The check a server that does not migrate at boot runs instead.

Each test writes `alembic_version` by hand in a database of its own, so what is
under test is the comparison against this build's heads, not the migrations.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from alembic.config import Config as AlembicConfig
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from switch_core.db.schema_version import SchemaNotAtHeadError, require_schema_at_head

_ALEMBIC_INI = Path(__file__).resolve().parents[3] / "alembic.ini"
_SCRATCH_DB = "schema_version_check"

pytestmark = pytest.mark.no_ambient_tenant


@pytest.fixture
def alembic_cfg() -> AlembicConfig:
    return AlembicConfig(str(_ALEMBIC_INI))


@pytest.fixture
async def scratch_engine(postgres_url: str) -> AsyncIterator[AsyncEngine]:
    admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
    async with admin.connect() as connection:
        await connection.execute(text(f'DROP DATABASE IF EXISTS "{_SCRATCH_DB}"'))
        await connection.execute(text(f'CREATE DATABASE "{_SCRATCH_DB}"'))
    base, _, _ = postgres_url.rpartition("/")
    engine = create_async_engine(f"{base}/{_SCRATCH_DB}")
    try:
        yield engine
    finally:
        await engine.dispose()
        async with admin.connect() as connection:
            await connection.execute(text(f'DROP DATABASE IF EXISTS "{_SCRATCH_DB}"'))
        await admin.dispose()


async def _stamp(engine: AsyncEngine, *revisions: str) -> None:
    async with engine.begin() as connection:
        await connection.execute(
            text("CREATE TABLE alembic_version (version_num varchar(32) PRIMARY KEY)")
        )
        for revision in revisions:
            await connection.execute(
                text("INSERT INTO alembic_version VALUES (:r)"), {"r": revision}
            )


async def test_a_database_at_head_is_accepted(
    scratch_engine: AsyncEngine, alembic_cfg: AlembicConfig
) -> None:
    await _stamp(scratch_engine, *ScriptDirectory.from_config(alembic_cfg).get_heads())

    await require_schema_at_head(scratch_engine, alembic_cfg)


async def test_a_database_behind_head_is_refused(
    scratch_engine: AsyncEngine, alembic_cfg: AlembicConfig
) -> None:
    script = ScriptDirectory.from_config(alembic_cfg)
    (head,) = script.get_heads()
    parents = script.get_revision(head).down_revision
    assert parents is not None
    previous = parents if isinstance(parents, str) else parents[0]
    await _stamp(scratch_engine, previous)

    with pytest.raises(SchemaNotAtHeadError, match="DB_MIGRATE_ON_BOOT"):
        await require_schema_at_head(scratch_engine, alembic_cfg)


async def test_a_database_never_migrated_is_refused(
    scratch_engine: AsyncEngine, alembic_cfg: AlembicConfig
) -> None:
    with pytest.raises(SchemaNotAtHeadError, match="none"):
        await require_schema_at_head(scratch_engine, alembic_cfg)
