"""`c3a7e1f0b5d2` turns a definition's `repository` into a GitHub grant.

A definition with `repository: {installation_id, repository_id}` is granted
that one repository in `connections` and keeps its `directory`; one with
`repository: null` loses the key. Changed definitions and their controllers
bump their revisions. Downgrade reverses a single-repository grant and refuses
any other.
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
_DB = "migration_agent_connection_grants"

_PRE_MIGRATION_REVISION = "0019a00db8f6"
_MIGRATION_UNDER_TEST = "c3a7e1f0b5d2"


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
                    "(tenant_id, id, agent_id, owner_id, controller_id, revision, "
                    "desired_state, definition) VALUES ('t', :id, :agent_id, 'o', "
                    "'ctl', 4, 'running', CAST(:definition AS jsonb))"
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


async def _assignment_revision(engine: AsyncEngine) -> int:
    async with engine.connect() as connection:
        return int(
            await connection.scalar(
                text("SELECT assignment_revision FROM agent_controllers")
            )
        )


def _definition(**fields: Any) -> dict[str, Any]:
    return {
        "provider": "claude",
        "model": None,
        "advanced_config": {},
        "instructions": "",
        "auto_approve": False,
        "directory": "/data/worktrees/a/example/project",
        "isolation": "isolated",
        **fields,
    }


def _grant(installation_id: int, repositories: Any) -> list[dict[str, Any]]:
    return [
        {
            "slug": "github",
            "installations": [
                {"installation_id": installation_id, "repositories": repositories}
            ],
        }
    ]


async def test_a_repository_becomes_a_grant_and_back(database_url: str) -> None:
    engine = create_async_engine(database_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(
                _migrate_to(_PRE_MIGRATION_REVISION, downgrade=False)
            )
            await connection.execute(
                text("SET LOCAL session_replication_role = replica")
            )
            await connection.execute(
                text(
                    "INSERT INTO agent_controllers "
                    "(tenant_id, id, owner_id, name, kind, assignment_revision) "
                    "VALUES ('t', 'ctl', 'o', 'Switch cloud', 'ec2', 7)"
                )
            )
        await _insert(
            engine,
            {
                "in-repo": _definition(
                    repository={"installation_id": 123, "repository_id": 456}
                ),
                "null-repo": _definition(repository=None),
                "no-repo": _definition(),
            },
        )

        async with engine.begin() as connection:
            await connection.run_sync(
                _migrate_to(_MIGRATION_UNDER_TEST, downgrade=False)
            )
        upgraded = await _definitions(engine)
        upgraded_revision = await _assignment_revision(engine)

        await _insert(engine, {"all-repos": _definition(connections=_grant(9, "all"))})
        with pytest.raises(RuntimeError, match="all-repos"):
            async with engine.begin() as connection:
                await connection.run_sync(
                    _migrate_to(_PRE_MIGRATION_REVISION, downgrade=True)
                )
        async with engine.begin() as connection:
            await connection.execute(
                text("DELETE FROM agent_definitions WHERE agent_id = 'all-repos'")
            )
            await connection.run_sync(
                _migrate_to(_PRE_MIGRATION_REVISION, downgrade=True)
            )
        downgraded = await _definitions(engine)
    finally:
        await engine.dispose()

    assert upgraded == {
        "in-repo": (_definition(connections=_grant(123, [456])), 5),
        "null-repo": (_definition(connections=[]), 5),
        "no-repo": (_definition(), 4),
    }
    assert upgraded_revision == 8
    assert downgraded == {
        "in-repo": (
            _definition(repository={"installation_id": 123, "repository_id": 456}),
            6,
        ),
        "null-repo": (_definition(), 6),
        "no-repo": (_definition(), 4),
    }
