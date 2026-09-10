"""The migration's frozen DDL and the live module it was copied from (CHOO-2623).

`db/rls_ddl.py` and `db/notify_ddl.py` are each attached to `Base.metadata`, so
`create_all` builds the policies and the delivery trigger for every ordinary
test. The migrations that install the same thing on a real database
(`265ed188ad6f` for row-level security, `d4e17b90c3a5` plus `e83c5a17f4d2` for
the trigger) carry their own verbatim copy of that SQL instead of importing
the module, on purpose: a migration is a record of a change that already
happened, and importing the live module would let a later edit to it silently
change what an old migration means. That is the right shape for a migration.

Nothing, however, ever ran the migration's copy and checked it still says the
same thing as the module it was copied from. Every store test builds its
schema with `create_all`, so the frozen copy sits unexercised — a migration
could have its `WITH CHECK` loosened to `true`, its empty-string guard
dropped, or its enable-RLS step turned into a no-op, and the entire suite
would stay green, because none of it ever runs that SQL. `test_migration_parity
.test_migrations_match_the_models` does not catch it either: `compare_metadata`
diffs tables, columns and constraints, not policies or `relrowsecurity`.

This replays the real Alembic chain into one database and `create_all` into a
second, then diffs what Postgres actually built in each — not the source text
of either copy, but the catalogue rows a session would actually be governed
by: `pg_policies` (name, table, `qual` and `with_check`), `pg_class
.relrowsecurity`, and the body of `require_tenant_id` from `pg_proc.prosrc`.
The same frozen-copy pattern, and the same blind spot, applies to the delivery
trigger, so its function body and trigger definition are diffed the same way.

Function bodies are compared with comment-only lines stripped (see
`_without_comments`): `db/notify_ddl.py` gained an explanatory comment inside
`switch_notify_message()` after `e83c5a17f4d2` froze its copy, which is
exactly the kind of edit the frozen-copy pattern is meant to tolerate — the
comment changed nothing the function does. A byte-for-byte comparison would
fail on that alone and teach nobody to ignore this test's next, real, failure.
Everything else — the policies, `relrowsecurity`, the trigger definition, and
any change to the code inside a function body — is compared verbatim.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from alembic.config import Config
from alembic.runtime.environment import EnvironmentContext
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, text
from sqlalchemy.ext.asyncio import create_async_engine

import switch_core.db.models  # noqa: F401 — registers every table, and the RLS/notify DDL, on Base.metadata
from switch_core.db.base import Base
from switch_core.db.notify_ddl import NOTIFY_FUNCTION_NAME, NOTIFY_TRIGGER_NAME
from switch_core.db.rls_ddl import POLICY_NAME, REQUIRE_TENANT_FUNCTION_NAME

_CORE = Path(__file__).resolve().parents[3]
_MIGRATED_DB = "frozen_ddl_parity_migrated"
_CREATE_ALL_DB = "frozen_ddl_parity_create_all"


def _script_directory(config: Config) -> ScriptDirectory:
    config.set_main_option("script_location", str(_CORE / "switch_core" / "migrations"))
    return ScriptDirectory.from_config(config)


def _upgrade_to_head(connection: Connection) -> None:
    """Replay the chain on an explicit connection.

    Same approach as `test_migration_parity.py`: driven through
    `EnvironmentContext` rather than `alembic.command.upgrade`, so the repo's
    `env.py` — which builds its own engine from `SwitchConfig` and would point
    at the deployment database — is never loaded.
    """
    config = Config(str(_CORE / "alembic.ini"))
    script = _script_directory(config)

    def do_upgrade(revision: str, context: Any) -> Any:
        return script._upgrade_revs("head", revision)

    with EnvironmentContext(config, script, fn=do_upgrade) as environment:
        environment.configure(connection=connection, target_metadata=Base.metadata)
        with environment.begin_transaction():
            environment.run_migrations()


def _create_all(connection: Connection) -> None:
    Base.metadata.create_all(connection)


def _policies(connection: Connection) -> dict[str, tuple[str | None, str | None]]:
    rows = connection.execute(
        text(
            "SELECT tablename, qual, with_check FROM pg_policies "
            "WHERE schemaname = 'public' AND policyname = :name"
        ),
        {"name": POLICY_NAME},
    )
    return {row.tablename: (row.qual, row.with_check) for row in rows}


def _rls_enabled(connection: Connection) -> dict[str, bool]:
    """`relrowsecurity` for every table the models know about.

    Filtered to `Base.metadata.tables` so `alembic_version` — a table only the
    migrated database has, and nothing this test is about — never shows up as
    a spurious mismatch.
    """
    rows = connection.execute(
        text(
            "SELECT c.relname, c.relrowsecurity FROM pg_class c "
            "JOIN pg_namespace n ON n.oid = c.relnamespace "
            "WHERE n.nspname = 'public' AND c.relkind = 'r'"
        )
    )
    return {
        row.relname: row.relrowsecurity
        for row in rows
        if row.relname in Base.metadata.tables
    }


def _function_body(connection: Connection, name: str) -> str:
    row = connection.execute(
        text(
            "SELECT prosrc FROM pg_proc p "
            "JOIN pg_namespace n ON n.oid = p.pronamespace "
            "WHERE n.nspname = 'public' AND p.proname = :name"
        ),
        {"name": name},
    ).one()
    return row.prosrc


def _without_comments(body: str) -> str:
    """A function body with its comment-only lines dropped.

    `prosrc` is Postgres's verbatim record of the text it was given, comments
    included, so a comment added to `db/notify_ddl.py` for a reader's benefit
    — with no change to what the function does — would otherwise show up as
    drift against a migration frozen before the comment existed. The module
    docstrings are explicit that a frozen copy must not change *meaning*
    because the live module later does; a comment carries no runtime meaning,
    so it is excluded here on purpose. Nothing else is: a changed guard, a
    changed predicate, a changed literal all survive this and still fail.
    """
    return "\n".join(
        line.rstrip() for line in body.splitlines() if not line.strip().startswith("--")
    ).strip()


def _trigger_def(connection: Connection, table: str, trigger: str) -> str:
    row = connection.execute(
        text(
            "SELECT pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t "
            "WHERE t.tgrelid = CAST(:table AS regclass) "
            "AND t.tgname = :trigger AND NOT t.tgisinternal"
        ),
        {"table": table, "trigger": trigger},
    ).one()
    return row.definition


@dataclass(frozen=True)
class _DDLSnapshot:
    policies: dict[str, tuple[str | None, str | None]]
    rls_enabled: dict[str, bool]
    require_tenant_id_body: str
    notify_function_body: str
    notify_trigger_def: str


def _snapshot(connection: Connection) -> _DDLSnapshot:
    return _DDLSnapshot(
        policies=_policies(connection),
        rls_enabled=_rls_enabled(connection),
        require_tenant_id_body=_function_body(connection, REQUIRE_TENANT_FUNCTION_NAME),
        notify_function_body=_function_body(connection, NOTIFY_FUNCTION_NAME),
        notify_trigger_def=_trigger_def(connection, "messages", NOTIFY_TRIGGER_NAME),
    )


def _diff(a: dict[str, Any], b: dict[str, Any]) -> str:
    keys = sorted(set(a) | set(b))
    return "\n".join(
        f"  {k}: migration={a.get(k)!r} create_all={b.get(k)!r}"
        for k in keys
        if a.get(k) != b.get(k)
    )


@pytest.fixture
async def ddl_parity_urls(postgres_url: str) -> Any:
    """Two empty databases: one for the real Alembic chain, one for `create_all`."""
    admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
    async with admin.connect() as connection:
        for name in (_MIGRATED_DB, _CREATE_ALL_DB):
            await connection.execute(text(f'DROP DATABASE IF EXISTS "{name}"'))
            await connection.execute(text(f'CREATE DATABASE "{name}"'))
    await admin.dispose()

    base, _, _ = postgres_url.rpartition("/")
    try:
        yield f"{base}/{_MIGRATED_DB}", f"{base}/{_CREATE_ALL_DB}"
    finally:
        admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
        async with admin.connect() as connection:
            for name in (_MIGRATED_DB, _CREATE_ALL_DB):
                await connection.execute(text(f'DROP DATABASE IF EXISTS "{name}"'))
        await admin.dispose()


async def test_migration_ddl_matches_the_live_copy(ddl_parity_urls: Any) -> None:
    migrated_url, create_all_url = ddl_parity_urls

    migrated_engine = create_async_engine(migrated_url)
    create_all_engine = create_async_engine(create_all_url)
    try:
        async with migrated_engine.begin() as connection:
            await connection.run_sync(_upgrade_to_head)
        async with create_all_engine.begin() as connection:
            await connection.run_sync(_create_all)

        async with migrated_engine.connect() as connection:
            migrated = await connection.run_sync(_snapshot)
        async with create_all_engine.connect() as connection:
            live = await connection.run_sync(_snapshot)
    finally:
        await migrated_engine.dispose()
        await create_all_engine.dispose()

    # A sanity floor on the live side: if this were ever empty, every
    # assertion below would pass vacuously against a schema with no policies
    # at all, which is exactly the failure this test exists to catch.
    assert len(live.policies) >= 30, (
        "create_all did not attach any tenant_isolation policies — "
        "db/rls_ddl.py is not wired into Base.metadata"
    )

    assert migrated.policies == live.policies, (
        "the migration's frozen tenant_isolation policies (USING / WITH CHECK) "
        "no longer match db/rls_ddl.py's live copy:\n"
        + _diff(migrated.policies, live.policies)
    )
    assert migrated.rls_enabled == live.rls_enabled, (
        "row-level security is enabled on a different set of tables in the "
        "migrated database than db/rls_ddl.py's live copy would enable it on:\n"
        + _diff(migrated.rls_enabled, live.rls_enabled)
    )
    assert _without_comments(migrated.require_tenant_id_body) == _without_comments(
        live.require_tenant_id_body
    ), (
        "the migration's frozen require_tenant_id() body no longer matches "
        "db/rls_ddl.py's live copy:\n"
        f"  migration:  {migrated.require_tenant_id_body!r}\n"
        f"  create_all: {live.require_tenant_id_body!r}"
    )
    assert _without_comments(migrated.notify_function_body) == _without_comments(
        live.notify_function_body
    ), (
        "the migration's frozen switch_notify_message() body no longer "
        "matches db/notify_ddl.py's live copy:\n"
        f"  migration:  {migrated.notify_function_body!r}\n"
        f"  create_all: {live.notify_function_body!r}"
    )
    assert migrated.notify_trigger_def == live.notify_trigger_def, (
        "the migration's frozen messages_notify trigger definition no longer "
        "matches db/notify_ddl.py's live copy:\n"
        f"  migration:  {migrated.notify_trigger_def!r}\n"
        f"  create_all: {live.notify_trigger_def!r}"
    )
