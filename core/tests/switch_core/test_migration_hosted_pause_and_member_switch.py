"""`d3a7f1c2b8e4` adds the user's pause time, lets a box be stopped as paused
or turned off, and adds each member's hosted switch (on by default); its
downgrade takes all three away again, refusing while anyone is paused or
turned off."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from alembic.config import Config
from alembic.runtime.environment import EnvironmentContext
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, text
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine

_CORE = Path(__file__).resolve().parents[2]
_DB = "migration_hosted_pause_and_member_switch"

_BEFORE = "c7715ebb95c9"
_UNDER_TEST = "d3a7f1c2b8e4"


def _script_directory(config: Config) -> ScriptDirectory:
    config.set_main_option("script_location", str(_CORE / "switch_core" / "migrations"))
    return ScriptDirectory.from_config(config)


def _migrate(revision: str, *, downgrade: bool) -> Any:
    def migrate(connection: Connection) -> None:
        config = Config(str(_CORE / "alembic.ini"))
        script = _script_directory(config)

        def revisions(current_revision: str, context: Any) -> Any:
            if downgrade:
                return script._downgrade_revs(revision, current_revision)
            return script._upgrade_revs(revision, current_revision)

        with EnvironmentContext(config, script, fn=revisions) as environment:
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


async def _has(connection: AsyncConnection, table: str, column: str) -> bool:
    return (
        await connection.scalar(
            text(
                "SELECT count(*) FROM information_schema.columns WHERE table_name = "
                ":table AND column_name = :column"
            ),
            {"table": table, "column": column},
        )
    ) == 1


async def _column(connection: AsyncConnection) -> bool:
    hosted = await _has(connection, "tenant_members", "hosted_enabled")
    paused = await _has(connection, "users", "hosted_paused_at")
    assert hosted == paused  # both arrive and leave together
    return hosted


async def _box(connection: AsyncConnection, machine_id: str, reason: str) -> None:
    await connection.execute(
        text(
            "INSERT INTO users (id, name, email, role) VALUES (:id, 'u', :email, 'user') "
            "ON CONFLICT DO NOTHING"
        ),
        {"id": "user-" + machine_id, "email": machine_id + "@example.test"},
    )
    await connection.execute(
        text(
            "INSERT INTO cloud_machines (id, owner_id, state, desired_state, stop_reason, "
            "active_at, created_at, updated_at) VALUES (:id, :owner, 'stopped', 'stopped', "
            ":reason, now(), now(), now())"
        ),
        {"id": machine_id, "owner": "user-" + machine_id, "reason": reason},
    )


async def test_upgrades_and_downgrades(database_url: str) -> None:
    engine = create_async_engine(database_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_BEFORE, downgrade=False))
        async with engine.connect() as connection:
            assert await _column(connection) is False
        # Before: `paused` is refused by the check.
        with pytest.raises(Exception, match="ck_cloud_machine_stop_reason"):
            async with engine.begin() as connection:
                await _box(connection, "m-before", "paused")

        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_UNDER_TEST, downgrade=False))
        async with engine.begin() as connection:
            assert await _column(connection) is True
            await _box(connection, "m-paused", "paused")
            await _box(connection, "m-off", "turned_off")
            await _box(connection, "m-idle", "idle")
            # Existing members default to on: today's access carries over.
            default = await connection.scalar(
                text(
                    "SELECT column_default FROM information_schema.columns WHERE "
                    "table_name = 'tenant_members' AND column_name = 'hosted_enabled'"
                )
            )
            assert default == "true"
            # A pause time is kept on the user, and is empty for everyone today.
            await connection.execute(
                text(
                    "UPDATE users SET hosted_paused_at = now() WHERE id = 'user-m-paused'"
                )
            )
            assert (
                await connection.scalar(
                    text("SELECT count(*) FROM users WHERE hosted_paused_at IS NULL")
                )
            ) == 2
        with pytest.raises(Exception, match="ck_cloud_machine_stop_reason"):
            async with engine.begin() as connection:
                await _box(connection, "m-bad", "anything_else")

        # A paused or turned-off user or box: the downgrade refuses, and
        # changes nothing.
        with pytest.raises(Exception, match="Refusing to downgrade"):
            async with engine.begin() as connection:
                await connection.run_sync(_migrate(_BEFORE, downgrade=True))
        async with engine.connect() as connection:
            assert await _column(connection) is True
        # Resumed: the off box alone still refuses.
        async with engine.begin() as connection:
            await connection.execute(text("UPDATE users SET hosted_paused_at = NULL"))
            await connection.execute(
                text(
                    "UPDATE cloud_machines SET stop_reason = 'idle' "
                    "WHERE stop_reason = 'paused'"
                )
            )
        with pytest.raises(Exception, match="Refusing to downgrade"):
            async with engine.begin() as connection:
                await connection.run_sync(_migrate(_BEFORE, downgrade=True))
        # Turned on as well: it goes ahead.
        async with engine.begin() as connection:
            await connection.execute(
                text(
                    "UPDATE cloud_machines SET stop_reason = 'idle' "
                    "WHERE stop_reason = 'turned_off'"
                )
            )
        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_BEFORE, downgrade=True))
        async with engine.connect() as connection:
            assert await _column(connection) is False
            reasons = dict(
                (
                    await connection.execute(
                        text("SELECT id, stop_reason FROM cloud_machines ORDER BY id")
                    )
                ).all()
            )
        # Nothing rewritten by the downgrade itself.
        assert reasons == {"m-idle": "idle", "m-off": "idle", "m-paused": "idle"}
    finally:
        await engine.dispose()


async def test_the_override_lets_the_downgrade_drop_the_marks_on_purpose(
    database_url: str,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Only an explicit override restores paused or turned-off access."""
    engine = create_async_engine(database_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_UNDER_TEST, downgrade=False))
        async with engine.begin() as connection:
            await _box(connection, "m-paused", "paused")
            await _box(connection, "m-off", "turned_off")
            await connection.execute(
                text(
                    "UPDATE users SET hosted_paused_at = now() WHERE id = 'user-m-paused'"
                )
            )
        monkeypatch.setenv("SWITCH_ALLOW_DROP_HOSTED_MARKS", "1")
        with caplog.at_level("WARNING"):
            async with engine.begin() as connection:
                await connection.run_sync(_migrate(_BEFORE, downgrade=True))
        # One warning, with the count, before the marks go.
        assert any(
            "SWITCH_ALLOW_DROP_HOSTED_MARKS=1" in r.getMessage()
            and "3 paused or turned-off" in r.getMessage()
            for r in caplog.records
        )
        async with engine.connect() as connection:
            assert await _column(connection) is False
            reasons = dict(
                (
                    await connection.execute(
                        text("SELECT id, stop_reason FROM cloud_machines ORDER BY id")
                    )
                ).all()
            )
        assert reasons == {"m-off": "owner", "m-paused": "owner"}
    finally:
        await engine.dispose()
