"""`326235efd002` drops the database checks on a provider connection's provider
and kind, which the provider table checks instead, and its downgrade restores
them, deleting the rows they would refuse."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from alembic.config import Config
from alembic.runtime.environment import EnvironmentContext
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

_CORE = Path(__file__).resolve().parents[2]
_DB = "migration_provider_connection_checks"

_PRE_MIGRATION_REVISION = "fabf9b9bff78"
_MIGRATION_UNDER_TEST = "326235efd002"


def _migrate(revision: str, *, downgrade: bool) -> Any:
    def migrate(connection: Connection) -> None:
        config = Config(str(_CORE / "alembic.ini"))
        config.set_main_option(
            "script_location", str(_CORE / "switch_core" / "migrations")
        )
        script = ScriptDirectory.from_config(config)

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


async def _insert(engine: AsyncEngine, user_id: str, provider: str, kind: str) -> None:
    async with engine.begin() as connection:
        # Foreign keys to tenants and users are beside the point here.
        await connection.execute(text("SET LOCAL session_replication_role = replica"))
        await connection.execute(
            text(
                "INSERT INTO provider_connections "
                "(tenant_id, user_id, provider, kind, encrypted_credential, verified_at) "
                "VALUES ('t', :user_id, :provider, :kind, 'x', now())"
            ),
            {"user_id": user_id, "provider": provider, "kind": kind},
        )


async def _rows(engine: AsyncEngine) -> set[tuple[str, str, str]]:
    async with engine.connect() as connection:
        rows = await connection.execute(
            text("SELECT user_id, provider, kind FROM provider_connections")
        )
        return {(row[0], row[1], row[2]) for row in rows}


async def test_upgrade_drops_the_checks_and_downgrade_restores_them(
    database_url: str,
) -> None:
    engine = create_async_engine(database_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(
                _migrate(_PRE_MIGRATION_REVISION, downgrade=False)
            )
        await _insert(engine, "u1", "claude", "api-key")
        with pytest.raises(
            IntegrityError, match="ck_provider_connections_(provider|kind)"
        ):
            await _insert(engine, "u2", "newcli", "api-key")

        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_MIGRATION_UNDER_TEST, downgrade=False))
        await _insert(engine, "u2", "newcli", "api-key")
        await _insert(engine, "u3", "cursor", "auth-json")
        assert await _rows(engine) == {
            ("u1", "claude", "api-key"),
            ("u2", "newcli", "api-key"),
            ("u3", "cursor", "auth-json"),
        }

        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_PRE_MIGRATION_REVISION, downgrade=True))
        assert await _rows(engine) == {("u1", "claude", "api-key")}
        with pytest.raises(
            IntegrityError, match="ck_provider_connections_(provider|kind)"
        ):
            await _insert(engine, "u2", "newcli", "api-key")
        with pytest.raises(IntegrityError, match="ck_provider_connections_kind"):
            await _insert(engine, "u3", "cursor", "auth-json")
    finally:
        await engine.dispose()
