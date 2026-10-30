"""`947ed1a48729` gives each service connection its choices and how it was
made, and keys registered clients by choice, keeping every row there was;
its downgrade takes them away again."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from alembic.config import Config
from alembic.runtime.environment import EnvironmentContext
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine

_CORE = Path(__file__).resolve().parents[2]
_DB = "migration_service_connection_choices"

_BEFORE = "e5a9c3d71f08"
_UNDER_TEST = "947ed1a48729"


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


async def _seed(connection: AsyncConnection) -> None:
    """A Datadog connection made with keys, an Atlassian one signed in, and
    the client Atlassian's sign-ins go through, as a release before the
    revision left them."""
    tenant_id = await connection.scalar(text("SELECT id FROM tenants LIMIT 1"))
    await connection.execute(
        text(
            "INSERT INTO users (id, name, email, role, password_hash, metadata) "
            "VALUES ('ada', 'Ada', 'ada@example.com', 'user', NULL, '{}')"
        )
    )
    for service in ("datadog", "atlassian"):
        await connection.execute(
            text(
                "INSERT INTO service_connections (tenant_id, user_id, service, "
                "status, consent, granted_scopes, account_id, external_identity, "
                "encrypted_secret, secret_revision) VALUES (:tenant, 'ada', "
                ":service, 'active', 'write', '[]', :account, 'ada', 'sealed', 1)"
            ),
            {"tenant": tenant_id, "service": service, "account": f"{service}-1"},
        )
    await connection.execute(
        text(
            "INSERT INTO service_oauth_clients (service, registration_endpoint, "
            "oauth_client_id, encrypted_secret) VALUES ('atlassian', "
            "'https://auth.example.test/register', 'client-1', 'sealed')"
        )
    )


async def _connection_columns(connection: AsyncConnection) -> set[str]:
    return {
        row[0]
        for row in await connection.execute(
            text(
                "SELECT column_name FROM information_schema.columns WHERE "
                "table_name = 'service_connections' AND column_name IN "
                "('choices', 'method')"
            )
        )
    }


async def _client_key(connection: AsyncConnection) -> list[str]:
    return list(
        await connection.scalars(
            text(
                "SELECT a.attname FROM pg_index i JOIN pg_attribute a ON "
                "a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE "
                "i.indrelid = 'service_oauth_clients'::regclass AND i.indisprimary "
                "ORDER BY array_position(i.indkey, a.attnum)"
            )
        )
    )


async def test_upgrades_and_downgrades(database_url: str) -> None:
    engine = create_async_engine(database_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_BEFORE, downgrade=False))
            await _seed(connection)

        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_UNDER_TEST, downgrade=False))
        async with engine.connect() as connection:
            assert await _connection_columns(connection) == {"choices", "method"}
            rows = (
                await connection.execute(
                    text(
                        "SELECT service, method, choices FROM service_connections "
                        "ORDER BY service"
                    )
                )
            ).all()
            # Datadog was the one entry connected with keys.
            assert [tuple(row) for row in rows] == [
                ("atlassian", "oauth", {}),
                ("datadog", "keys", {}),
            ]
            assert await _client_key(connection) == ["service", "choice"]
            clients = (
                await connection.execute(
                    text(
                        "SELECT service, choice, oauth_client_id FROM service_oauth_clients"
                    )
                )
            ).all()
            assert [tuple(row) for row in clients] == [("atlassian", "", "client-1")]

        async with engine.begin() as connection:
            # A second site's client sits beside the first.
            await connection.execute(
                text(
                    "INSERT INTO service_oauth_clients (service, choice, "
                    "registration_endpoint, oauth_client_id, encrypted_secret) "
                    "VALUES ('atlassian', 'eu.example.test', "
                    "'https://auth.eu.example.test/register', 'client-2', 'sealed')"
                )
            )
        with pytest.raises(IntegrityError, match="ck_service_connections_method"):
            async with engine.begin() as connection:
                await connection.execute(
                    text("UPDATE service_connections SET method = 'pasted'")
                )

        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_BEFORE, downgrade=True))
        async with engine.connect() as connection:
            assert await _connection_columns(connection) == set()
            assert await _client_key(connection) == ["service"]
            clients = (
                await connection.execute(
                    text("SELECT service, oauth_client_id FROM service_oauth_clients")
                )
            ).all()
            # What was kept for another choice goes; the service's own stays.
            assert [tuple(row) for row in clients] == [("atlassian", "client-1")]
    finally:
        await engine.dispose()
