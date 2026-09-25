"""Both histories reach the merge revision `33e037ee949f` with their data.

The hosted-agent chain (`ab921ef034cd` .. `95fc38e451b6`) was applied on a
pilot before main grew its own head (`e3b7c9d2a415`), so a database can arrive
at the merge from either side. The pilot side still has to run main's
migrations, including the one that drops the server-side SDK session tables;
main's side has to run the hosted chain. Each path starts from an empty
database, seeds the rows its side owns, upgrades to heads and checks that the
rows, the tenant-isolation policies and the runtime grants are all in place.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
from alembic.config import Config
from alembic.runtime.environment import EnvironmentContext
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, text
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine

import switch_core.db.models  # noqa: F401 — registers every table on Base.metadata
from switch_core.db.rls_ddl import POLICY_NAME, REQUIRE_TENANT_FUNCTION_NAME
from switch_core.db.runtime_role import _require_every_policy, grant_runtime_role

_CORE = Path(__file__).resolve().parents[2]

_MERGE_REVISION = "33e037ee949f"
_PILOT_HEAD = "95fc38e451b6"
_MAIN_HEAD = "e3b7c9d2a415"

_HOSTED_TABLES = (
    "provider_connections",
    "provider_verifications",
    "hosted_launches",
    "hosted_operations",
    "github_issued_tokens",
)

_PREDICATE = (
    f"(tenant_id = ( SELECT {REQUIRE_TENANT_FUNCTION_NAME}() "
    f"AS {REQUIRE_TENANT_FUNCTION_NAME}))"
)


def _script_directory() -> tuple[Config, ScriptDirectory]:
    config = Config(str(_CORE / "alembic.ini"))
    config.set_main_option("script_location", str(_CORE / "switch_core" / "migrations"))
    return config, ScriptDirectory.from_config(config)


def _upgrade_to(revision: str) -> Any:
    def upgrade(connection: Connection) -> None:
        config, script = _script_directory()

        def do_upgrade(current_revision: str, context: Any) -> Any:
            return script._upgrade_revs(revision, current_revision)

        with EnvironmentContext(config, script, fn=do_upgrade) as environment:
            environment.configure(connection=connection)
            with environment.begin_transaction():
                environment.run_migrations()

    return upgrade


async def _database(postgres_url: str, name: str) -> AsyncIterator[str]:
    admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
    async with admin.connect() as connection:
        await connection.execute(text(f'DROP DATABASE IF EXISTS "{name}"'))
        await connection.execute(text(f'CREATE DATABASE "{name}"'))
    await admin.dispose()

    base, _, _ = postgres_url.rpartition("/")
    try:
        yield f"{base}/{name}"
    finally:
        admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
        async with admin.connect() as connection:
            await connection.execute(text(f'DROP DATABASE IF EXISTS "{name}"'))
        await admin.dispose()


@pytest.fixture
async def pilot_url(postgres_url: str) -> AsyncIterator[str]:
    async for url in _database(postgres_url, "migration_hosted_merge_pilot"):
        yield url


@pytest.fixture
async def main_url(postgres_url: str) -> AsyncIterator[str]:
    async for url in _database(postgres_url, "migration_hosted_merge_main"):
        yield url


async def _seed_tenant_and_user(connection: AsyncConnection) -> None:
    await connection.execute(
        text("INSERT INTO tenants (id, name, slug) VALUES ('t1', 'Tenant', 't1')")
    )
    await connection.execute(
        text(
            "INSERT INTO users (id, name, email, role, password_hash) "
            "VALUES ('u1', 'User', 'user@example.invalid', 'user', 'x')"
        )
    )


async def _assert_merged_schema(connection: AsyncConnection) -> None:
    _, script = _script_directory()
    heads = script.get_heads()
    assert len(heads) == 1
    ancestry = {revision.revision for revision in script.walk_revisions("base", heads[0])}
    assert _MERGE_REVISION in ancestry
    versions = (
        (await connection.execute(text("SELECT version_num FROM alembic_version")))
        .scalars()
        .all()
    )
    assert versions == heads

    sdk_tables = (
        (
            await connection.execute(
                text(
                    "SELECT tablename FROM pg_tables "
                    "WHERE schemaname = 'public' AND tablename LIKE 'sdk\\_%'"
                )
            )
        )
        .scalars()
        .all()
    )
    assert sdk_tables == []

    sdk_foreign_keys = (
        await connection.execute(
            text(
                "SELECT conname FROM pg_constraint c "
                "JOIN pg_class target ON target.oid = c.confrelid "
                "WHERE c.contype = 'f' AND target.relname LIKE 'sdk\\_%'"
            )
        )
    ).all()
    assert sdk_foreign_keys == []

    policies = {
        row.tablename: (row.rowsecurity, row.qual, row.with_check)
        for row in await connection.execute(
            text(
                "SELECT t.tablename, t.rowsecurity, p.qual, p.with_check "
                "FROM pg_tables t LEFT JOIN pg_policies p "
                "ON p.schemaname = t.schemaname AND p.tablename = t.tablename "
                "AND p.policyname = :name "
                "WHERE t.schemaname = 'public' AND t.tablename = ANY(:tables)"
            ),
            {"name": POLICY_NAME, "tables": list(_HOSTED_TABLES)},
        )
    }
    assert policies == {
        table: (True, _PREDICATE, _PREDICATE) for table in _HOSTED_TABLES
    }
    await _require_every_policy(connection)


async def _assert_runtime_grants(connection: AsyncConnection) -> None:
    role = f"switch_merge_test_{uuid.uuid4().hex[:12]}"
    await connection.execute(
        text(
            f'CREATE ROLE "{role}" NOLOGIN '
            "NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS"
        )
    )
    try:
        await grant_runtime_role(connection, role)
        for table in _HOSTED_TABLES:
            for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE"):
                assert await connection.scalar(
                    text("SELECT has_table_privilege(:role, :table, :privilege)"),
                    {"role": role, "table": table, "privilege": privilege},
                ), (table, privilege)
            assert not await connection.scalar(
                text(
                    "SELECT pg_has_role(:role, t.tableowner, 'USAGE') FROM pg_tables t WHERE t.tablename = :table"
                ),
                {"role": role, "table": table},
            ), table
        assert await connection.scalar(
            text("SELECT has_sequence_privilege(:role, 'agent_event_boot', 'USAGE')"),
            {"role": role},
        )
    finally:
        await connection.execute(text(f'DROP OWNED BY "{role}"'))
        await connection.execute(text(f'DROP ROLE "{role}"'))


async def test_pilot_database_keeps_hosted_rows_through_the_merge(
    pilot_url: str,
) -> None:
    engine = create_async_engine(pilot_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_PILOT_HEAD))
            assert await connection.scalar(text("SELECT to_regclass('sdk_sessions')"))

        async with engine.begin() as connection:
            await _seed_tenant_and_user(connection)
            await connection.execute(
                text(
                    "INSERT INTO provider_connections "
                    "(tenant_id, user_id, provider, kind, encrypted_credential, verified_at) "
                    "VALUES ('t1', 'u1', 'claude', 'api-key', 'sealed-credential', now())"
                )
            )
            await connection.execute(
                text(
                    "INSERT INTO provider_verifications "
                    "(tenant_id, id, user_id, provider, kind, token_hash, state, "
                    "created_at, deadline) "
                    "VALUES ('t1', 'v1', 'u1', 'claude', 'api-key', 'hash', 'queued', "
                    "now(), now())"
                )
            )
            await connection.execute(
                text(
                    "INSERT INTO hosted_launches "
                    "(tenant_id, id, owner_id, name, spec, agent_id, state) "
                    "VALUES ('t1', 'l1', 'u1', 'pilot-agent', "
                    "'{\"auto_session\": true}', 'a1', 'ready')"
                )
            )
            await connection.execute(
                text(
                    "INSERT INTO hosted_operations "
                    "(tenant_id, id, launch_id, launch_revision, session_id, action) "
                    "VALUES ('t1', 'o1', 'l1', 1, 's1', 'start')"
                )
            )
            await connection.execute(
                text(
                    "INSERT INTO github_issued_tokens "
                    "(tenant_id, id, owner_id, launch_id, launch_revision, "
                    "encrypted_token, expires_at, revoke_requested, attempts) "
                    "VALUES ('t1', 'g1', 'u1', 'l1', 1, 'sealed-token', now(), false, 0)"
                )
            )

        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to("heads"))

        async with engine.begin() as connection:
            await _assert_merged_schema(connection)
            await _assert_runtime_grants(connection)
            connections = (
                await connection.execute(
                    text("SELECT user_id, provider, kind FROM provider_connections")
                )
            ).all()
            verifications = (
                await connection.execute(
                    text("SELECT id, state FROM provider_verifications")
                )
            ).all()
            launches = (
                await connection.execute(
                    text("SELECT id, name, agent_id, state, spec FROM hosted_launches")
                )
            ).all()
            operations = (
                await connection.execute(
                    text(
                        "SELECT id, launch_id, launch_revision, action "
                        "FROM hosted_operations"
                    )
                )
            ).all()
            tokens = (
                await connection.execute(
                    text(
                        "SELECT id, launch_id, encrypted_token FROM github_issued_tokens"
                    )
                )
            ).all()
    finally:
        await engine.dispose()

    assert [tuple(row) for row in connections] == [("u1", "claude", "api-key")]
    assert [tuple(row) for row in verifications] == [("v1", "queued")]
    assert [tuple(row) for row in launches] == [
        ("l1", "pilot-agent", "a1", "ready", {"auto_session": True})
    ]
    assert [tuple(row) for row in operations] == [("o1", "l1", 1, "start")]
    assert [tuple(row) for row in tokens] == [("g1", "l1", "sealed-token")]


async def test_main_database_keeps_session_activity_through_the_merge(
    main_url: str,
) -> None:
    engine = create_async_engine(main_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_MAIN_HEAD))
            assert (
                await connection.scalar(text("SELECT to_regclass('hosted_launches')"))
                is None
            )

        async with engine.begin() as connection:
            await _seed_tenant_and_user(connection)
            await connection.execute(
                text(
                    "INSERT INTO usage_budgets "
                    "(tenant_id, id, metric, model, amount_limit, period_hours) "
                    "VALUES ('t1', 'b1', 'input_tokens', '', 5000000, 24)"
                )
            )
            # The agent these rows belong to is beside the point here.
            await connection.execute(
                text("SET LOCAL session_replication_role = replica")
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO approval_requests
                        (tenant_id, agent_id, session_id, request_id, turn_id,
                         kind, title, options, questions, state)
                    VALUES ('t1', 'a1', 's1', 'r1', 'turn-1', 'approval',
                            'Write file?',
                            '[{"id": "0", "label": "Allow", "decision": "accept"}]',
                            '[]', 'open')
                    """
                )
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO session_activity_items
                        (tenant_id, agent_id, session_id, turn_id, item_id, kind,
                         revision, status, title, text, occurred_at)
                    VALUES ('t1', 'a1', 's1', 'turn-1', 'item-1', 'tool-activity', 1,
                            'completed', 'Read file', 'README.md', now())
                    """
                )
            )

        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to("heads"))

        async with engine.begin() as connection:
            await _assert_merged_schema(connection)
            await _assert_runtime_grants(connection)
            budgets = (
                await connection.execute(
                    text("SELECT id, metric, amount_limit FROM usage_budgets")
                )
            ).all()
            requests = (
                await connection.execute(
                    text("SELECT request_id, title, state FROM approval_requests")
                )
            ).all()
            items = (
                await connection.execute(
                    text("SELECT item_id, status, title FROM session_activity_items")
                )
            ).all()
    finally:
        await engine.dispose()

    assert [tuple(row) for row in budgets] == [("b1", "input_tokens", 5000000)]
    assert [tuple(row) for row in requests] == [("r1", "Write file?", "open")]
    assert [tuple(row) for row in items] == [("item-1", "completed", "Read file")]
