"""`c4f7e2a90b13` brings a database that ran the first session-activity schema
up to turn steps.

Deployments applied `545f80e11f13` when it still created activity lines and
approval-only requests, so this revision has to convert that schema rather
than assume a fresh one: requests are kept (as approvals), lines are dropped.
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
_DB = "migration_session_activity_turn_steps"

_PRE_MIGRATION_REVISION = "b9e4d2a71c05"
_MIGRATION_UNDER_TEST = "c4f7e2a90b13"


def _script_directory(config: Config) -> ScriptDirectory:
    config.set_main_option("script_location", str(_CORE / "switch_core" / "migrations"))
    return ScriptDirectory.from_config(config)


def _upgrade_to(revision: str) -> Any:
    def upgrade(connection: Connection) -> None:
        config = Config(str(_CORE / "alembic.ini"))
        script = _script_directory(config)

        def do_upgrade(current_revision: str, context: Any) -> Any:
            return script._upgrade_revs(revision, current_revision)

        with EnvironmentContext(config, script, fn=do_upgrade) as environment:
            environment.configure(connection=connection)
            with environment.begin_transaction():
                environment.run_migrations()

    return upgrade


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


async def test_requests_become_approvals_and_lines_make_way_for_turn_steps(
    database_url: str,
) -> None:
    engine = create_async_engine(database_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_PRE_MIGRATION_REVISION))

        async with engine.begin() as connection:
            # Foreign keys to tenants and agents are beside the point here.
            await connection.execute(
                text("SET LOCAL session_replication_role = replica")
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO approval_requests
                        (tenant_id, agent_id, session_id, request_id, question,
                         options, state)
                    VALUES ('t', 'a', 's', 'r', 'Write file?',
                            '[{"id": "0", "label": "Allow", "decision": "accept"}]',
                            'open')
                    """
                )
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO session_activity_events
                        (tenant_id, agent_id, session_id, seq, type, summary,
                         occurred_at)
                    VALUES ('t', 'a', 's', 1, 'turn.started', 'Started', now())
                    """
                )
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO turn_status_posts
                        (tenant_id, bridge_id, agent_id, session_id, turn_id,
                         external_channel_id, external_post_id, tool_calls, finished)
                    VALUES ('t', 'b', 'a', 's', 'turn', 'C1', 'P1', 3, true)
                    """
                )
            )

        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_MIGRATION_UNDER_TEST))

        async with engine.connect() as connection:
            request = (
                await connection.execute(
                    text(
                        "SELECT kind, title, detail, questions, answers, turn_id "
                        "FROM approval_requests"
                    )
                )
            ).one()
            lines = await connection.execute(
                text("SELECT to_regclass('session_activity_events')")
            )
            items = await connection.execute(
                text("SELECT count(*) FROM session_activity_items")
            )
            post = (
                await connection.execute(
                    text(
                        "SELECT mark, reaction_message_ref, attention_post_id "
                        "FROM turn_status_posts"
                    )
                )
            ).one()
    finally:
        await engine.dispose()

    assert tuple(request) == ("approval", "Write file?", None, [], None, "")
    assert lines.scalar() is None
    assert items.scalar() == 0
    assert tuple(post) == (None, None, None)
