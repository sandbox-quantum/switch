"""The migrations build the schema the models describe.

Every other test provisions its schema with `Base.metadata.create_all`, so a
model can gain a column, an index or a constraint that no migration ever
applies and the whole suite still passes — the drift only shows up on a real
deployment, where the table is the one Alembic built. This test replays the
chain into an empty database and asks Alembic's autogenerate comparison
whether anything is still missing.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.runtime.environment import EnvironmentContext
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, text
from sqlalchemy.ext.asyncio import create_async_engine

import switch_core.db.models  # noqa: F401 — registers every table on Base.metadata
from switch_core.db.base import Base

_CORE = Path(__file__).resolve().parents[2]
_PARITY_DB = "migration_parity"


def _script_directory(config: Config) -> ScriptDirectory:
    config.set_main_option("script_location", str(_CORE / "switch_core" / "migrations"))
    return ScriptDirectory.from_config(config)


def _upgrade_to_head(connection: Connection) -> None:
    """Replay the chain on an explicit connection.

    Driven through `EnvironmentContext` rather than `alembic.command.upgrade`
    so the repo's `env.py` — which builds its own engine from `SwitchConfig`
    and would point at the deployment database — is never loaded.
    """
    config = Config(str(_CORE / "alembic.ini"))
    script = _script_directory(config)

    def do_upgrade(revision: str, context: Any) -> Any:
        return script._upgrade_revs("head", revision)

    with EnvironmentContext(config, script, fn=do_upgrade) as environment:
        environment.configure(connection=connection, target_metadata=Base.metadata)
        with environment.begin_transaction():
            environment.run_migrations()


def _diff(connection: Connection) -> list[Any]:
    context = MigrationContext.configure(connection)
    return list(compare_metadata(context, Base.metadata))


def _is_real_drift(entry: Any) -> bool:
    """Filter the one comparison Alembic cannot make faithfully.

    A server default is compared as rendered SQL text, and Postgres echoes
    `func.now()` back as `now()` while the model still holds the SQLAlchemy
    construct, so every `server_default` column reports as modified whether or
    not the migration matches. Nothing else is filtered: a missing table,
    column, index, constraint or nullability change is real drift.
    """
    return not (isinstance(entry, tuple) and entry[0] == "modify_default")


@pytest.fixture
async def migrated_url(postgres_url: str) -> Any:
    """An empty database, separate from the create_all one the store tests use."""
    admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
    async with admin.connect() as connection:
        await connection.execute(text(f'DROP DATABASE IF EXISTS "{_PARITY_DB}"'))
        await connection.execute(text(f'CREATE DATABASE "{_PARITY_DB}"'))
    await admin.dispose()

    base, _, _ = postgres_url.rpartition("/")
    try:
        yield f"{base}/{_PARITY_DB}"
    finally:
        admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
        async with admin.connect() as connection:
            await connection.execute(text(f'DROP DATABASE IF EXISTS "{_PARITY_DB}"'))
        await admin.dispose()


async def test_migrations_match_the_models(migrated_url: str) -> None:
    engine = create_async_engine(migrated_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to_head)
        async with engine.connect() as connection:
            diff = await connection.run_sync(_diff)
    finally:
        await engine.dispose()

    drift = [entry for entry in diff if _is_real_drift(entry)]
    assert not drift, (
        "the migrations and the models disagree; autogenerate would emit:\n"
        + "\n".join(f"  {entry}" for entry in drift)
    )
