"""The check a server that does not migrate at boot runs instead.

Each test writes `alembic_version` by hand in a database of its own, so what is
under test is the comparison against this build's heads, not the migrations.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
from alembic.config import Config as AlembicConfig
from alembic.runtime.environment import EnvironmentContext
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from switch_core.db.schema_version import (
    SchemaNotAtHeadError,
    record_expand_only,
    require_schema_at_head,
    schema_ahead_through_expand_only,
)

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


async def _record(engine: AsyncEngine, *chain: tuple[str, str]) -> None:
    async with engine.begin() as connection:
        await connection.execute(
            text(
                "CREATE TABLE IF NOT EXISTS schema_expand_only_revisions "
                "(revision text PRIMARY KEY, down_revision text NOT NULL, "
                "applied_at timestamptz NOT NULL DEFAULT now())"
            )
        )
        for revision, down in chain:
            await connection.execute(
                text("INSERT INTO schema_expand_only_revisions VALUES (:r, :d)"),
                {"r": revision, "d": down},
            )


def _head(alembic_cfg: AlembicConfig) -> str:
    (head,) = ScriptDirectory.from_config(alembic_cfg).get_heads()
    return head


class TestAheadByExpandOnlyRevisions:
    """An older release during a rolling deploy, or after a rollback: the
    database's head is a revision this build has no file for."""

    async def test_one_recorded_revision_ahead_is_served(
        self, scratch_engine: AsyncEngine, alembic_cfg: AlembicConfig
    ) -> None:
        await _stamp(scratch_engine, "future1")
        await _record(scratch_engine, ("future1", _head(alembic_cfg)))

        await require_schema_at_head(scratch_engine, alembic_cfg)
        assert await schema_ahead_through_expand_only(scratch_engine, alembic_cfg)

    async def test_a_chain_of_recorded_revisions_is_served(
        self, scratch_engine: AsyncEngine, alembic_cfg: AlembicConfig
    ) -> None:
        await _stamp(scratch_engine, "future2")
        await _record(
            scratch_engine,
            ("future2", "future1"),
            ("future1", _head(alembic_cfg)),
        )

        await require_schema_at_head(scratch_engine, alembic_cfg)

    async def test_a_revision_not_recorded_as_expand_only_is_refused(
        self, scratch_engine: AsyncEngine, alembic_cfg: AlembicConfig
    ) -> None:
        """It may drop or rename what this release reads."""
        await _stamp(scratch_engine, "future2")
        await _record(scratch_engine, ("future1", _head(alembic_cfg)))

        with pytest.raises(SchemaNotAtHeadError):
            await require_schema_at_head(scratch_engine, alembic_cfg)
        assert not await schema_ahead_through_expand_only(scratch_engine, alembic_cfg)

    async def test_a_chain_that_lands_below_this_builds_head_is_refused(
        self, scratch_engine: AsyncEngine, alembic_cfg: AlembicConfig
    ) -> None:
        """A branch off an older revision is not ahead of this build."""
        script = ScriptDirectory.from_config(alembic_cfg)
        parents = script.get_revision(_head(alembic_cfg)).down_revision
        older = parents if isinstance(parents, str) else parents[0]
        await _stamp(scratch_engine, "future1")
        await _record(scratch_engine, ("future1", older))

        with pytest.raises(SchemaNotAtHeadError):
            await require_schema_at_head(scratch_engine, alembic_cfg)

    async def test_at_head_is_not_ahead(
        self, scratch_engine: AsyncEngine, alembic_cfg: AlembicConfig
    ) -> None:
        await _stamp(scratch_engine, _head(alembic_cfg))
        await _record(scratch_engine)

        assert not await schema_ahead_through_expand_only(scratch_engine, alembic_cfg)


def _run(connection: Connection, alembic_cfg: AlembicConfig, target: str) -> None:
    """Upgrade or downgrade on an explicit connection, with the recorder the
    repository's env.py installs, without loading env.py itself."""
    script = ScriptDirectory.from_config(alembic_cfg)

    def migrate(revision: Any, context: Any) -> Any:
        if target == "head":
            return script._upgrade_revs("head", revision)
        return script._downgrade_revs(target, revision)

    with EnvironmentContext(alembic_cfg, script, fn=migrate) as environment:
        environment.configure(
            connection=connection, on_version_apply=[record_expand_only]
        )
        with environment.begin_transaction():
            environment.run_migrations()


async def test_applying_the_chain_records_the_expand_only_revisions(
    scratch_engine: AsyncEngine, alembic_cfg: AlembicConfig
) -> None:
    async with scratch_engine.begin() as connection:
        await connection.run_sync(_run, alembic_cfg, "head")
    async with scratch_engine.connect() as connection:
        recorded = dict(
            (
                await connection.execute(
                    text(
                        "SELECT revision, down_revision FROM schema_expand_only_revisions"
                    )
                )
            ).all()
        )
    # Each is recorded with the revision it follows in the chain, whatever that
    # is when the chain is extended or reordered.
    script = ScriptDirectory.from_config(alembic_cfg)
    for revision in ("e2b0df5be5ff", "e5956cbd3bdc"):
        assert recorded[revision] == script.get_revision(revision).down_revision
    assert recorded["e5956cbd3bdc"] == "e2b0df5be5ff"
    for revision in recorded:
        assert script.get_revision(revision).module.expand_only is True

    async with scratch_engine.begin() as connection:
        await connection.run_sync(_run, alembic_cfg, "e2b0df5be5ff")
    async with scratch_engine.connect() as connection:
        left = set(
            (
                await connection.execute(
                    text("SELECT revision FROM schema_expand_only_revisions")
                )
            ).scalars()
        )
    assert left == {"e2b0df5be5ff"}
    async with scratch_engine.begin() as connection:
        await connection.run_sync(_run, alembic_cfg, "c4d8e2f6a913")
    async with scratch_engine.connect() as connection:
        table = await connection.scalar(
            text("SELECT to_regclass('schema_expand_only_revisions')")
        )
    assert table is None
