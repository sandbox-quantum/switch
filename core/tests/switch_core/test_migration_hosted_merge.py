"""Both histories reach the merge revision `33e037ee949f` with their data.

A pilot database reaches it through the cutover manifest `a3c9e5f71d28`, which
has to run before main's `b9e4d2a71c05` drops the server-side session tables:
the manifest is what keeps their pending work.

The manifest only captures; the drop also waits for every retained volume's
preflight check to be recorded, which `migrations/env.py` before the drop and
the merge revision after it both enforce. The cases seed the state a recorded
check leaves rather than running the retired cutover tool. `_upgrade_to` builds its own migration context and so exercises
only the merge revision; the `test_real_upgrade_*` cases go through `env.py`
the way `alembic upgrade` and Core's boot do.

The hosted-agent chain (`ab921ef034cd` .. `95fc38e451b6`) was applied on a
pilot before main grew its own head (`c4e9a1f7b203`), so a database can arrive
at the merge from either side. The pilot side still has to run main's
migrations, including the one that drops the server-side SDK session tables;
main's side has to run the hosted chain. Each path starts from an empty
database, seeds the rows its side owns, upgrades to heads and checks that the
rows, the tenant-isolation policies and the runtime grants are all in place.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path
from typing import Any

import pytest
from alembic import command as alembic_command
from alembic.config import Config
from alembic.runtime.environment import EnvironmentContext
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine

import switch_core.db.models  # noqa: F401 — registers every table on Base.metadata
from switch_core.config import SwitchConfig
from switch_core.db.hosted_cutover_gate import DROP_REVISION, cutover_gate_problems
from switch_core.db.rls_ddl import POLICY_NAME, REQUIRE_TENANT_FUNCTION_NAME
from switch_core.db.runtime_role import _require_every_policy, grant_runtime_role
from switch_core.main import _migrate_and_grant

_CORE = Path(__file__).resolve().parents[2]

_MERGE_REVISION = "33e037ee949f"
_PILOT_HEAD = "95fc38e451b6"
_MAIN_HEAD = "c4e9a1f7b203"
# Main's head when it was last merged in: a database already there takes the
# whole hosted chain on its next upgrade.
_LATER_MAIN_HEAD = "a9e1c3f75b20"
# The hosted pilot's head once main's audit events were merged on the hosted
# branch: a database there takes the agent management chain on its next upgrade.
_HOSTED_AUDIT_HEAD = "8f2c4a6e1d93"
_MANIFEST_REVISION = "a3c9e5f71d28"
# The last revision a database with cloud agents that are not removed can
# reach: `b4e1d7a2c9f0` refuses one until they are.
_BEFORE_MACHINES = "5c1e9b7d3f02"

_HOSTED_TABLES = ("provider_connections", "hosted_wake_mailbox")

# The hosted worker tables the head no longer has.
_WORKER_TABLES = (
    "provider_verifications",
    "hosted_launches",
    "hosted_operations",
    "github_issued_tokens",
    "hosted_cutover_volumes",
    "hosted_cutover_items",
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


def _command(room_id: str | None, message_id: str | None, surface: str) -> str:
    return json.dumps(
        {
            "contractVersion": 1,
            "commandId": "placeholder-command",
            "sessionId": "s1",
            "epoch": "e1",
            "origin": {
                "actorId": "placeholder-actor",
                "surface": surface,
                "roomId": room_id,
                "threadId": "th1" if room_id else None,
                "messageId": message_id,
            },
            "body": {"type": "message.send", "text": "placeholder", "attachments": []},
        }
    )


def _status(command_id: str, status: str) -> str:
    return json.dumps(
        {
            "type": "command.status",
            "commandId": command_id,
            "status": status,
            "code": None,
            "message": None,
        }
    )


async def _seed_sdk_rows(connection: AsyncConnection) -> None:
    """#538's server-side session state for the hosted agent `a1` and a local agent `a9`."""
    # The agents, rooms and bridges these rows point at are beside the point here.
    await connection.execute(text("SET LOCAL session_replication_role = replica"))
    for session_id, agent_id in (("s1", "a1"), ("s9", "a9")):
        await connection.execute(
            text(
                "INSERT INTO sdk_sessions "
                "(tenant_id, id, agent_id, host_id, epoch, lease_expires_at, snapshot, host_sequence) "
                "VALUES ('t1', :id, :agent, 'h1', 'e1', now(), '{}', 7)"
            ),
            {"id": session_id, "agent": agent_id},
        )
    for session_id, command_id, room_id, message_id, surface, status in (
        ("s1", "c1", "r1", "m1", "slack", "dispatched"),
        ("s1", "c2", "r1", "m2", "slack", "applied"),
        ("s1", "c3", None, None, "console", "accepted"),
        ("s1", "c4", None, None, "console", "applied"),
        ("s9", "c5", "r1", "m3", "slack", "accepted"),
    ):
        await connection.execute(
            text(
                "INSERT INTO sdk_session_commands "
                "(tenant_id, session_id, command_id, accepted_sequence, command, status) "
                "VALUES ('t1', :session, :command_id, 1, CAST(:command AS jsonb), CAST(:status AS jsonb))"
            ),
            {
                "session": session_id,
                "command_id": command_id,
                "command": _command(room_id, message_id, surface),
                "status": _status(command_id, status),
            },
        )
    for post_id, removed in (("p1", None), ("p2", "now()")):
        await connection.execute(
            text(
                "INSERT INTO session_request_posts "
                "(tenant_id, id, bridge_id, token, handle, external_channel_id, "
                "external_post_id, room_id, thread_id, session_id, epoch, request_id, "
                "revision, form, removed_at) "
                f"VALUES ('t1', :id, 'b1', :id || '-placeholder-token', :id, 'C0', :id, 'r1', "
                f"'th1', 's1', 'e1', :request, 1, '{{}}', {removed or 'NULL'})"
            ),
            {"id": post_id, "request": f"q-{post_id}"},
        )


_EXPECTED_MANIFEST = (
    [("l1", "pending")],
    [
        (
            "console_command",
            "s1",
            None,
            None,
            None,
            {"core": {"command_id": "c3", "status": "accepted"}},
        ),
        (
            "operation",
            "s1",
            None,
            None,
            None,
            {"core": {"operation_id": "o1", "action": "start", "state": "queued"}},
        ),
        (
            "request_open",
            "s1",
            "r1",
            None,
            "th1",
            {"core": {"request_id": "q-p1", "epoch": "e1"}},
        ),
        (
            "room_message",
            "s1",
            "r1",
            "m1",
            "th1",
            {"core": {"command_id": "c1", "status": "dispatched", "code": None}},
        ),
        (
            "room_message",
            "s1",
            "r1",
            "m2",
            "th1",
            {"core": {"command_id": "c2", "status": "applied", "code": None}},
        ),
        ("session", "s1", None, None, None, "session"),
    ],
)


async def _seed_import(connection: AsyncConnection) -> None:
    """A room message Core accepted for `a1` that no worker saw, with an attachment
    whose blob #538 tied to the session, and a session blob nothing imports."""
    await connection.execute(text("SET LOCAL session_replication_role = replica"))
    await connection.execute(
        text(
            "INSERT INTO rooms (tenant_id, id, matrix_room_id, name, description) "
            "VALUES ('t1', 'r2', '!r2:example.invalid', 'Room', '')"
        )
    )
    await connection.execute(
        text(
            "INSERT INTO messages (tenant_id, id, seq, room_id, transport_event_id, "
            "sender_id, event_type, msgtype, body, content) "
            "VALUES ('t1', 'row-m4', 1, 'r2', 'm4', '@person:example.invalid', "
            "'m.room.message', 'm.file', 'report.txt', '{}')"
        )
    )
    await connection.execute(
        text(
            "INSERT INTO message_attachments "
            "(tenant_id, id, message_id, position, uri, filename, mimetype, size) "
            "VALUES ('t1', 'att-m4', 'row-m4', 0, 'mxc://example.invalid/kept', "
            "'report.txt', 'text/plain', 5)"
        )
    )
    for blob, uri in (("blob-kept", "kept"), ("blob-dropped", "dropped")):
        await connection.execute(
            text(
                "INSERT INTO media_blobs (tenant_id, id, uri, size, data, sdk_session_id) "
                "VALUES ('t1', :id, :uri, 5, 'bytes', 's1')"
            ),
            {"id": blob, "uri": f"mxc://example.invalid/{uri}"},
        )
    await connection.execute(
        text(
            "INSERT INTO sdk_session_commands "
            "(tenant_id, session_id, command_id, accepted_sequence, command, status) "
            "VALUES ('t1', 's1', 'c6', 2, CAST(:command AS jsonb), CAST(:status AS jsonb))"
        ),
        {"command": _command("r2", "m4", "slack"), "status": _status("c6", "accepted")},
    )


async def _pilot_at_manifest(url: str, *, with_import: bool) -> None:
    """A pilot database with a stopped hosted launch, prepared at the manifest revision."""
    engine = create_async_engine(url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_PILOT_HEAD))
        async with engine.begin() as connection:
            await _seed_tenant_and_user(connection)
            await connection.execute(
                text(
                    "INSERT INTO hosted_launches "
                    "(tenant_id, id, owner_id, name, spec, agent_id, state, desired_state) "
                    "VALUES ('t1', 'l1', 'u1', 'pilot-agent', '{}', 'a1', 'stopped', 'stopped')"
                )
            )
            await _seed_sdk_rows(connection)
            if with_import:
                await _seed_import(connection)
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_MANIFEST_REVISION))
    finally:
        await engine.dispose()


async def _cutover_problems(url: str) -> list[str]:
    engine = create_async_engine(url)
    try:
        async with engine.connect() as connection:
            return await connection.run_sync(cutover_gate_problems)
    finally:
        await engine.dispose()


async def _record_blocked(url: str, reason: str) -> None:
    """The volume of `l1` as a blocked preflight check leaves it."""
    engine = create_async_engine(url)
    try:
        async with engine.begin() as connection:
            await connection.execute(
                text(
                    "UPDATE hosted_cutover_volumes SET preflight_state = 'blocked', "
                    "blocked_reason = :reason WHERE launch_id = 'l1'"
                ),
                {"reason": reason},
            )
    finally:
        await engine.dispose()


_IMPORTED_EVENT = json.dumps(
    {
        "type": "message",
        "payload": {"attachments": [{"mxc": "mxc://example.invalid/kept"}]},
        "missed": None,
    }
)


async def _record_complete(url: str) -> None:
    """The volume of `l1` as a complete preflight check with an empty manifest
    leaves it: every item decided, `m4` imported with its blob kept."""
    engine = create_async_engine(url)
    try:
        async with engine.begin() as connection:
            await connection.execute(
                text(
                    "UPDATE hosted_cutover_volumes SET preflight_state = 'complete', "
                    "blocked_reason = NULL WHERE launch_id = 'l1'"
                )
            )
            await connection.execute(
                text(
                    "UPDATE hosted_cutover_items SET disposition = CASE "
                    "WHEN message_id = 'm4' THEN 'import' ELSE 'preserved' END, "
                    "payload = CASE WHEN message_id = 'm4' "
                    "THEN CAST(:event AS jsonb) ELSE payload END "
                    "WHERE launch_id = 'l1'"
                ),
                {"event": _IMPORTED_EVENT},
            )
            await connection.execute(
                text(
                    "UPDATE media_blobs SET sdk_session_id = NULL WHERE id = 'blob-kept'"
                )
            )
    finally:
        await engine.dispose()


async def _ungated_heads_refused(url: str, match: str) -> None:
    """A bare `alembic upgrade heads` rolls back, the drop with it."""
    engine = create_async_engine(url)
    try:
        with pytest.raises(RuntimeError, match=match):
            async with engine.begin() as connection:
                await connection.run_sync(_upgrade_to("heads"))
        async with engine.begin() as connection:
            assert (
                await connection.scalar(text("SELECT version_num FROM alembic_version"))
                == _MANIFEST_REVISION
            )
            assert await connection.scalar(text("SELECT to_regclass('sdk_sessions')"))
    finally:
        await engine.dispose()


async def _cutover_rows(connection: AsyncConnection) -> tuple[list[Any], list[Any]]:
    volumes = (
        await connection.execute(
            text("SELECT launch_id, preflight_state FROM hosted_cutover_volumes")
        )
    ).all()
    items = (
        await connection.execute(
            text(
                "SELECT kind, session_id, room_id, message_id, thread_id, evidence "
                "FROM hosted_cutover_items WHERE agent_id = 'a1' AND disposition IS NULL "
                "ORDER BY kind, message_id"
            )
        )
    ).all()
    assert all(
        row.kind != "session" or row.evidence["core"]["host_sequence"] == 7
        for row in items
    )
    return [tuple(row) for row in volumes], [
        tuple(row)[:5] + (("session",) if row.kind == "session" else (row.evidence,))
        for row in items
    ]


async def _assert_merged_schema(connection: AsyncConnection) -> None:
    _, script = _script_directory()
    heads = script.get_heads()
    assert len(heads) == 1
    ancestry = {
        revision.revision for revision in script.walk_revisions("base", heads[0])
    }
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

    for table in _WORKER_TABLES:
        assert (
            await connection.scalar(
                text("SELECT to_regclass(:table)"), {"table": table}
            )
            is None
        ), table

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


async def _remove_launches_and_upgrade(engine: AsyncEngine) -> None:
    """Remove every cloud agent, as `b4e1d7a2c9f0` requires, then upgrade to heads."""
    async with engine.begin() as connection:
        await connection.execute(
            text(
                "UPDATE hosted_launches SET state = 'deleted', desired_state = 'deleted'"
            )
        )
        await connection.run_sync(_upgrade_to("heads"))
    async with engine.begin() as connection:
        await _assert_merged_schema(connection)
        await _assert_runtime_grants(connection)


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
                    "(tenant_id, id, owner_id, name, spec, agent_id, state, desired_state) "
                    "VALUES ('t1', 'l1', 'u1', 'pilot-agent', "
                    "'{\"auto_session\": true}', 'a1', 'stopped', 'stopped')"
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
            await _seed_sdk_rows(connection)

        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_MANIFEST_REVISION))

        async with engine.begin() as connection:
            assert await connection.scalar(text("SELECT to_regclass('sdk_sessions')"))
            captured = await _cutover_rows(connection)

        await _record_complete(pilot_url)
        assert await _cutover_problems(pilot_url) == []

        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_BEFORE_MACHINES))

        async with engine.begin() as connection:
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
            kept = await _cutover_rows(connection)
        await _remove_launches_and_upgrade(engine)
    finally:
        await engine.dispose()

    assert [tuple(row) for row in connections] == [("u1", "claude", "api-key")]
    assert [tuple(row) for row in verifications] == [("v1", "queued")]
    assert [tuple(row) for row in launches] == [
        ("l1", "pilot-agent", "a1", "stopped", {"auto_session": True})
    ]
    assert [tuple(row) for row in operations] == [("o1", "l1", 1, "start")]
    assert [tuple(row) for row in tokens] == [("g1", "l1", "sealed-token")]
    assert captured == _EXPECTED_MANIFEST
    assert kept == ([("l1", "complete")], [])


async def test_pilot_upgrade_refuses_to_drop_sessions_before_the_manifest(
    pilot_url: str,
) -> None:
    engine = create_async_engine(pilot_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_PILOT_HEAD))
        async with engine.begin() as connection:
            await _seed_tenant_and_user(connection)
            await connection.execute(
                text(
                    "INSERT INTO hosted_launches "
                    "(tenant_id, id, owner_id, name, spec, agent_id, state) "
                    "VALUES ('t1', 'l1', 'u1', 'pilot-agent', '{}', 'a1', 'stopped')"
                )
            )
            await _seed_sdk_rows(connection)

        with pytest.raises(
            RuntimeError, match="a Switch release that still has the cutover tool"
        ):
            async with engine.begin() as connection:
                await connection.run_sync(_upgrade_to("heads"))

        async with engine.begin() as connection:
            version = await connection.scalar(
                text("SELECT version_num FROM alembic_version")
            )
            commands = await connection.scalar(
                text("SELECT count(*) FROM sdk_session_commands")
            )
    finally:
        await engine.dispose()

    assert version == _PILOT_HEAD
    assert commands == 5


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

    assert [tuple(row) for row in requests] == [("r1", "Write file?", "open")]
    assert [tuple(row) for row in items] == [("item-1", "completed", "Read file")]


async def test_later_main_database_takes_the_hosted_chain(main_url: str) -> None:
    engine = create_async_engine(main_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_LATER_MAIN_HEAD))
            assert (
                await connection.scalar(text("SELECT to_regclass('hosted_launches')"))
                is None
            )

        async with engine.begin() as connection:
            await _seed_tenant_and_user(connection)
            await connection.execute(
                text(
                    "INSERT INTO tenant_join_domains (tenant_id, domain, created_by) "
                    "VALUES ('t1', 'example.invalid', 'u1')"
                )
            )

        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to("heads"))

        async with engine.begin() as connection:
            await _assert_merged_schema(connection)
            await _assert_runtime_grants(connection)
            domains = (
                await connection.execute(
                    text("SELECT tenant_id, domain FROM tenant_join_domains")
                )
            ).all()
    finally:
        await engine.dispose()

    assert [tuple(row) for row in domains] == [("t1", "example.invalid")]


async def test_hosted_audit_database_takes_the_agent_management_chain(
    main_url: str,
) -> None:
    engine = create_async_engine(main_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_HOSTED_AUDIT_HEAD))
            assert (
                await connection.scalar(text("SELECT to_regclass('agent_controllers')"))
                is None
            )

        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to("heads"))

        async with engine.begin() as connection:
            await _assert_merged_schema(connection)
            await _assert_runtime_grants(connection)
            controllers = await connection.scalar(
                text("SELECT to_regclass('agent_controllers')")
            )
    finally:
        await engine.dispose()

    assert controllers is not None


async def test_pilot_upgrade_refuses_the_drop_until_every_volume_is_recorded(
    pilot_url: str,
) -> None:
    await _pilot_at_manifest(pilot_url, with_import=True)

    problems = await _cutover_problems(pilot_url)
    assert any("launch l1 has no recorded preflight check" in p for p in problems)
    assert any("launch l1 has cutover items no manifest decided" in p for p in problems)
    await _ungated_heads_refused(
        pilot_url, "the volume of launch l1 has no recorded preflight check"
    )

    await _record_blocked(
        pilot_url,
        "sessions at /data/state/sessions/placeholder/events.jsonl:3: "
        "the line is not JSON",
    )
    (blocked,) = [p for p in await _cutover_problems(pilot_url) if "blocked" in p]
    assert (
        "launch l1: sessions at /data/state/sessions/placeholder/events.jsonl:3"
        in blocked
    )
    assert "the line is not JSON" in blocked
    await _ungated_heads_refused(
        pilot_url, "the preflight check blocked on the volume of launch l1"
    )

    await _record_complete(pilot_url)
    assert await _cutover_problems(pilot_url) == []

    engine = create_async_engine(pilot_url)
    try:
        async with engine.begin() as connection:
            await connection.execute(
                text(
                    "UPDATE media_blobs SET sdk_session_id = 's1' WHERE id = 'blob-kept'"
                )
            )
        assert any(
            "would be dropped with its session" in p
            for p in await _cutover_problems(pilot_url)
        )
        await _ungated_heads_refused(
            pilot_url,
            "import for launch l1 mxc://example.invalid/kept is gone",
        )
        await _record_complete(pilot_url)
        assert await _cutover_problems(pilot_url) == []

        async with engine.begin() as connection:
            await connection.execute(
                text(
                    "UPDATE hosted_cutover_items SET payload = NULL WHERE message_id = 'm4'"
                )
            )
        assert any(
            "the import l1 r2 m4 has no event" in p
            for p in await _cutover_problems(pilot_url)
        )
        await _ungated_heads_refused(pilot_url, "the import l1 r2 m4 has no event")
        async with engine.begin() as connection:
            await connection.execute(
                text(
                    "UPDATE hosted_cutover_items SET payload = CAST(:event AS jsonb) "
                    "WHERE message_id = 'm4'"
                ),
                {
                    "event": json.dumps(
                        {"type": "message", "payload": {}, "missed": None}
                    )
                },
            )
    finally:
        await engine.dispose()


async def test_pilot_upgrade_refuses_a_capture_the_old_core_outran(
    pilot_url: str,
) -> None:
    await _pilot_at_manifest(pilot_url, with_import=False)
    await _record_complete(pilot_url)
    assert await _cutover_problems(pilot_url) == []
    engine = create_async_engine(pilot_url)
    try:
        async with engine.begin() as connection:
            await connection.execute(
                text(
                    "UPDATE sdk_session_commands SET status = CAST(:status AS jsonb) "
                    "WHERE command_id = 'c1'"
                ),
                {"status": _status("c1", "applied")},
            )
    finally:
        await engine.dispose()
    (stale,) = await _cutover_problems(pilot_url)
    assert stale.startswith("c1 changed in the old session tables after `prepare`")


async def test_pilot_upgrade_refuses_a_launch_restarted_or_added_after_prepare(
    pilot_url: str,
) -> None:
    await _pilot_at_manifest(pilot_url, with_import=False)
    await _record_complete(pilot_url)
    assert await _cutover_problems(pilot_url) == []
    engine = create_async_engine(pilot_url)
    try:
        async with engine.begin() as connection:
            await connection.execute(
                text("UPDATE hosted_launches SET desired_state = 'running'")
            )
        assert await _cutover_problems(pilot_url) == ["launch l1 is not stopped"]
        await _ungated_heads_refused(pilot_url, "launch l1 is not stopped")
        async with engine.begin() as connection:
            await connection.execute(
                text("UPDATE hosted_launches SET desired_state = 'stopped'")
            )
            await connection.execute(
                text("SET LOCAL session_replication_role = replica")
            )
            await connection.execute(
                text(
                    "INSERT INTO hosted_launches "
                    "(tenant_id, id, owner_id, name, spec, agent_id, state, desired_state) "
                    "VALUES ('t1', 'l2', 'u1', 'late-agent', '{}', 'a2', 'stopped', 'stopped')"
                )
            )
    finally:
        await engine.dispose()
    (missing,) = await _cutover_problems(pilot_url)
    assert missing.startswith("launch l2 has no cutover volume")
    await _ungated_heads_refused(pilot_url, "launch l2 has no cutover volume")


def _migration_config(url: str, monkeypatch: pytest.MonkeyPatch) -> SwitchConfig:
    """The environment `migrations/env.py` reads, pointed at `url`."""
    parts = make_url(url)
    environment = {
        "DB_HOST": parts.host,
        "DB_PORT": str(parts.port),
        "DB_USER": parts.username,
        "DB_PASSWORD": parts.password,
        "DB_NAME": parts.database,
        "MATRIX_SERVER_NAME": "example.invalid",
        "AGENT_REGISTRATION_TOKEN": "placeholder-registration-token",
        "SECRET_KEYS": "test:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "GATEWAY_ADMIN_EMAIL": "admin@example.invalid",
        "GATEWAY_ADMIN_PASSWORD": "placeholder-password",
    }
    for name, value in environment.items():
        assert value is not None
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("DB_OWNER_USER", raising=False)
    monkeypatch.delenv("DB_OWNER_PASSWORD", raising=False)
    return SwitchConfig()  # type: ignore[call-arg]


async def _alembic_upgrade_heads(config: SwitchConfig) -> None:
    await asyncio.to_thread(
        alembic_command.upgrade, Config(str(_CORE / "alembic.ini")), "heads"
    )


_MIGRATE_PATHS = pytest.mark.parametrize(
    "migrate",
    [_alembic_upgrade_heads, _migrate_and_grant],
    ids=["alembic-upgrade-heads", "core-boot"],
)


async def _head(url: str) -> tuple[list[str], bool]:
    engine = create_async_engine(url)
    try:
        async with engine.connect() as connection:
            versions = list(
                await connection.scalars(
                    text("SELECT version_num FROM alembic_version")
                )
            )
            sessions = await connection.scalar(
                text("SELECT to_regclass('sdk_sessions') IS NOT NULL")
            )
    finally:
        await engine.dispose()
    return versions, bool(sessions)


@_MIGRATE_PATHS
@pytest.mark.parametrize(
    ("with_import", "statements", "match"),
    [
        pytest.param(
            False,
            [
                "UPDATE sdk_session_commands SET status = CAST('"
                + _status("c1", "applied")
                + "' AS jsonb) WHERE command_id = 'c1'"
            ],
            "c1 changed in the old session tables after `prepare`",
            id="stale-capture",
        ),
        pytest.param(
            False,
            [
                "SET LOCAL session_replication_role = replica",
                "INSERT INTO hosted_launches "
                "(tenant_id, id, owner_id, name, spec, agent_id, state, desired_state) "
                "VALUES ('t1', 'l2', 'u1', 'late-agent', '{}', 'a2', 'stopped', 'stopped')",
            ],
            "launch l2 has no cutover volume",
            id="missing-volume",
        ),
        pytest.param(
            True,
            ["UPDATE hosted_cutover_items SET payload = NULL WHERE message_id = 'm4'"],
            "the import l1 r2 m4 has no event",
            id="missing-import-payload",
        ),
        pytest.param(
            False,
            ["UPDATE hosted_launches SET desired_state = 'running'"],
            "launch l1 is not stopped",
            id="launch-running",
        ),
    ],
)
async def test_real_upgrade_refuses_an_incomplete_cutover_before_the_drop(
    pilot_url: str,
    monkeypatch: pytest.MonkeyPatch,
    migrate: Callable[[SwitchConfig], Awaitable[None]],
    with_import: bool,
    statements: list[str],
    match: str,
) -> None:
    await _pilot_at_manifest(pilot_url, with_import=with_import)
    await _record_complete(pilot_url)
    engine = create_async_engine(pilot_url)
    try:
        async with engine.begin() as connection:
            for statement in statements:
                await connection.execute(text(statement))
    finally:
        await engine.dispose()
    config = _migration_config(pilot_url, monkeypatch)

    with pytest.raises(RuntimeError, match=match):
        await migrate(config)

    assert await _head(pilot_url) == ([_MANIFEST_REVISION], True)


async def _alembic_upgrade_to_drop(config: SwitchConfig) -> None:
    await asyncio.to_thread(
        alembic_command.upgrade, Config(str(_CORE / "alembic.ini")), DROP_REVISION
    )


@pytest.mark.parametrize(
    "migrate",
    [_alembic_upgrade_to_drop, _alembic_upgrade_heads, _migrate_and_grant],
    ids=["alembic-upgrade-drop", "alembic-upgrade-heads", "core-boot"],
)
async def test_real_upgrade_refuses_a_cutover_never_prepared(
    pilot_url: str,
    monkeypatch: pytest.MonkeyPatch,
    migrate: Callable[[SwitchConfig], Awaitable[None]],
) -> None:
    engine = create_async_engine(pilot_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_PILOT_HEAD))
            await _seed_tenant_and_user(connection)
            await connection.execute(
                text(
                    "INSERT INTO hosted_launches "
                    "(tenant_id, id, owner_id, name, spec, agent_id, state, desired_state) "
                    "VALUES ('t1', 'l1', 'u1', 'pilot-agent', '{}', 'a1', 'stopped', 'stopped')"
                )
            )
            await _seed_sdk_rows(connection)
    finally:
        await engine.dispose()

    with pytest.raises(
        RuntimeError,
        match=r"launch l1 has hosted state the cutover has not captured.*predates the controller runtime",
    ):
        await migrate(_migration_config(pilot_url, monkeypatch))

    assert await _head(pilot_url) == ([_PILOT_HEAD], True)


@_MIGRATE_PATHS
async def test_real_upgrade_completes_a_prepared_cutover(
    pilot_url: str,
    monkeypatch: pytest.MonkeyPatch,
    migrate: Callable[[SwitchConfig], Awaitable[None]],
) -> None:
    await _pilot_at_manifest(pilot_url, with_import=True)
    await _record_complete(pilot_url)

    with pytest.raises(RuntimeError, match="hosted_machines: 1 cloud agent"):
        await migrate(_migration_config(pilot_url, monkeypatch))
    assert await _head(pilot_url) == ([_MANIFEST_REVISION], True)

    engine = create_async_engine(pilot_url)
    try:
        async with engine.begin() as connection:
            await connection.execute(
                text(
                    "UPDATE hosted_launches SET state = 'deleted', desired_state = 'deleted'"
                )
            )
    finally:
        await engine.dispose()
    await migrate(_migration_config(pilot_url, monkeypatch))

    _, script = _script_directory()
    assert await _head(pilot_url) == ([script.get_current_head()], False)


@_MIGRATE_PATHS
@pytest.mark.parametrize(
    "start", [None, "545f80e11f13"], ids=["fresh", "main-before-drop"]
)
async def test_real_upgrade_leaves_databases_without_hosted_launches_alone(
    main_url: str,
    monkeypatch: pytest.MonkeyPatch,
    migrate: Callable[[SwitchConfig], Awaitable[None]],
    start: str | None,
) -> None:
    if start is not None:
        engine = create_async_engine(main_url)
        try:
            async with engine.begin() as connection:
                await connection.run_sync(_upgrade_to(start))
        finally:
            await engine.dispose()

    await migrate(_migration_config(main_url, monkeypatch))

    _, script = _script_directory()
    assert await _head(main_url) == ([script.get_current_head()], False)
