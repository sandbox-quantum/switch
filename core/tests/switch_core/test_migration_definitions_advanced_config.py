"""`e8b4e2f62e25` turns stored definitions' `model_options` into `advanced_config`.

Definitions were stored with `model_options`, or before that key existed with
neither; the definition schema now refuses `model_options` and expects
`advanced_config`, so every stored row has to be converted.
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
_DB = "migration_definitions_advanced_config"

_PRE_MIGRATION_REVISION = "c4d8e1f2a9b3"
_MIGRATION_UNDER_TEST = "e8b4e2f62e25"


def _script_directory(config: Config) -> ScriptDirectory:
    config.set_main_option("script_location", str(_CORE / "switch_core" / "migrations"))
    return ScriptDirectory.from_config(config)


def _migrate_to(revision: str, *, downgrade: bool) -> Any:
    def migrate(connection: Connection) -> None:
        config = Config(str(_CORE / "alembic.ini"))
        script = _script_directory(config)

        def step(current_revision: str, context: Any) -> Any:
            if downgrade:
                return script._downgrade_revs(revision, current_revision)
            return script._upgrade_revs(revision, current_revision)

        with EnvironmentContext(config, script, fn=step) as environment:
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


async def _insert(engine: AsyncEngine, rows: dict[str, dict[str, Any]]) -> None:
    async with engine.begin() as connection:
        # Foreign keys to tenants, agents and users are beside the point here.
        await connection.execute(text("SET LOCAL session_replication_role = replica"))
        for agent_id, definition in rows.items():
            await connection.execute(
                text(
                    "INSERT INTO agent_definitions "
                    "(tenant_id, id, agent_id, owner_id, revision, desired_state, "
                    "definition) VALUES ('t', :id, :agent_id, 'o', 4, 'running', "
                    "CAST(:definition AS jsonb))"
                ),
                {
                    "id": f"def-{agent_id}",
                    "agent_id": agent_id,
                    "definition": json.dumps(definition),
                },
            )


async def _definitions(engine: AsyncEngine) -> dict[str, tuple[dict[str, Any], int]]:
    async with engine.connect() as connection:
        result = await connection.execute(
            text("SELECT agent_id, definition, revision FROM agent_definitions")
        )
        return {row.agent_id: (row.definition, row.revision) for row in result}


def _definition(**fields: Any) -> dict[str, Any]:
    return {
        "provider": "claude",
        "model": "opus",
        "instructions": "",
        "auto_approve": False,
        "directory": None,
        "isolation": "shared",
        **fields,
    }


async def test_model_options_move_to_advanced_config_and_back(
    database_url: str,
) -> None:
    engine = create_async_engine(database_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(
                _migrate_to(_PRE_MIGRATION_REVISION, downgrade=False)
            )
        await _insert(
            engine,
            {
                "with-options": _definition(model_options={"effort": "high"}),
                "empty-options": _definition(model_options={}),
                "no-options": _definition(model=None),
            },
        )

        async with engine.begin() as connection:
            await connection.run_sync(
                _migrate_to(_MIGRATION_UNDER_TEST, downgrade=False)
            )
        upgraded = await _definitions(engine)
        await _insert(
            engine,
            {
                "new-settings": _definition(
                    advanced_config={"effort": "max", "tools": ["Read"]},
                ),
                "settings-without-a-model": _definition(
                    model=None, advanced_config={"effort": "max"}
                ),
            },
        )

        async with engine.begin() as connection:
            await connection.run_sync(
                _migrate_to(_PRE_MIGRATION_REVISION, downgrade=True)
            )
        downgraded = await _definitions(engine)
    finally:
        await engine.dispose()

    assert upgraded == {
        "with-options": (_definition(advanced_config={"effort": "high"}), 4),
        "empty-options": (_definition(advanced_config={}), 4),
        "no-options": (_definition(model=None, advanced_config={}), 4),
    }
    assert downgraded == {
        "with-options": (_definition(model_options={"effort": "high"}), 4),
        "empty-options": (_definition(model_options={}), 4),
        "no-options": (_definition(model=None, model_options={}), 4),
        "new-settings": (_definition(model_options={"effort": "max"}), 4),
        "settings-without-a-model": (_definition(model=None, model_options={}), 4),
    }
