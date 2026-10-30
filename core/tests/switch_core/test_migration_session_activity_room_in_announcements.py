"""`ddd07a1fcdcb` puts the room in the session-activity announcements that
carry a key instead of a row: a turn step's, and an approval request's too
large to ride along."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from alembic.config import Config
from alembic.runtime.environment import EnvironmentContext
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, text
from sqlalchemy.ext.asyncio import create_async_engine

from switch_core.db.session_activity_notify_ddl import SESSION_ACTIVITY_CHANNEL

_CORE = Path(__file__).resolve().parents[2]
_DB = "migration_session_activity_room_in_announcements"

_MIGRATION_UNDER_TEST = "ddd07a1fcdcb"


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


async def test_key_announcements_carry_the_room(database_url: str) -> None:
    engine = create_async_engine(database_url)
    payloads: asyncio.Queue[str] = asyncio.Queue()
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_MIGRATION_UNDER_TEST))

        async with engine.connect() as listening:
            raw = await listening.get_raw_connection()
            await raw.driver_connection.add_listener(
                SESSION_ACTIVITY_CHANNEL, lambda *args: payloads.put_nowait(args[3])
            )
            async with engine.begin() as connection:
                # Foreign keys are beside the point; the triggers are the point.
                await connection.execute(
                    text("SET LOCAL session_replication_role = replica")
                )
                await connection.execute(
                    text(
                        "ALTER TABLE session_activity_items "
                        "ENABLE ALWAYS TRIGGER session_activity_items_notify"
                    )
                )
                await connection.execute(
                    text(
                        "ALTER TABLE approval_requests "
                        "ENABLE ALWAYS TRIGGER approval_requests_notify_insert"
                    )
                )
                await connection.execute(
                    text(
                        """
                        INSERT INTO session_activity_items
                            (tenant_id, agent_id, session_id, turn_id, item_id,
                             kind, revision, status, title, text, room_id,
                             occurred_at)
                        VALUES ('t', 'a', 's', 'turn', 'turn', 'turn', 1,
                                'running', '', '', 'room-1', now())
                        """
                    )
                )
                await connection.execute(
                    text(
                        """
                        INSERT INTO approval_requests
                            (tenant_id, agent_id, session_id, request_id, turn_id,
                             kind, title, detail, options, questions, state,
                             room_id)
                        VALUES ('t', 'a', 's', 'r', 'turn', 'approval', 'Deploy?',
                                repeat('x', 8000), '[]', '[]', 'open', 'room-1')
                        """
                    )
                )
            step = json.loads(await asyncio.wait_for(payloads.get(), 5))
            request = json.loads(await asyncio.wait_for(payloads.get(), 5))
    finally:
        await engine.dispose()

    assert step["key"]["room_id"] == "room-1"
    assert "row" not in request
    assert request["key"]["room_id"] == "room-1"
