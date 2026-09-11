"""The operator/workspace-admin role split migration moves real data correctly.

`test_migration_parity.py` replays the chain into an *empty* database, so it
can never catch a bug in what `8ef6d4038ecc` does to an existing deployment's
rows — a promoted-then-forgotten operator whose `tenant_members` row still
says `member` would pass every other test and only show up against real data.
This seeds tenant zero the way a deployment with that exact staleness would
look, stops the chain one revision short of the migration under test, runs
it, and inspects what came out.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from alembic.config import Config
from alembic.runtime.environment import EnvironmentContext
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, text
from sqlalchemy.ext.asyncio import create_async_engine

_CORE = Path(__file__).resolve().parents[2]
_MIGRATION_DB = "migration_operator_owns_tenant_zero"

_PRE_MIGRATION_REVISION = "a3f61c02d5be"
_MIGRATION_UNDER_TEST = "8ef6d4038ecc"
_TENANT_ZERO_ID = "00000000-0000-0000-0000-000000000000"


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


async def _fixture_engine(postgres_url: str) -> Any:
    admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
    async with admin.connect() as connection:
        await connection.execute(text(f'DROP DATABASE IF EXISTS "{_MIGRATION_DB}"'))
        await connection.execute(text(f'CREATE DATABASE "{_MIGRATION_DB}"'))
    await admin.dispose()
    base, _, _ = postgres_url.rpartition("/")
    return create_async_engine(f"{base}/{_MIGRATION_DB}")


async def _drop_fixture(postgres_url: str) -> None:
    admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
    async with admin.connect() as connection:
        await connection.execute(text(f'DROP DATABASE IF EXISTS "{_MIGRATION_DB}"'))
    await admin.dispose()


async def test_a_promoted_operators_stale_member_row_becomes_owner(
    postgres_url: str,
) -> None:
    """The gap the migration exists for: `users.role` was promoted to
    `admin` by direct SQL after the `tenant_members` row already existed as
    `member` — nothing before this migration ever revisited it."""
    engine = await _fixture_engine(postgres_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_PRE_MIGRATION_REVISION))

        async with engine.begin() as connection:
            await connection.execute(
                text(
                    """
                    INSERT INTO users (id, name, email, role, password_hash, metadata)
                    VALUES ('promoted-op', 'Promoted', 'promoted@example.com',
                            'admin', 'bcrypt-hash', NULL)
                    """
                )
            )
            await connection.execute(
                text(
                    f"""
                    INSERT INTO tenant_members (tenant_id, user_id, role)
                    VALUES ('{_TENANT_ZERO_ID}', 'promoted-op', 'member')
                    """
                )
            )

        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_MIGRATION_UNDER_TEST))

        async with engine.connect() as connection:
            role = (
                await connection.execute(
                    text(
                        "SELECT role FROM tenant_members "
                        "WHERE tenant_id = :t AND user_id = 'promoted-op'"
                    ),
                    {"t": _TENANT_ZERO_ID},
                )
            ).scalar_one()
    finally:
        await engine.dispose()
        await _drop_fixture(postgres_url)

    assert role == "owner"


async def test_an_operator_with_no_membership_row_at_all_gets_one(
    postgres_url: str,
) -> None:
    """`UserStore.ensure_membership` should make this unreachable, but
    nothing at the database level enforces it — the migration closes the gap
    rather than assuming application code always ran first."""
    engine = await _fixture_engine(postgres_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_PRE_MIGRATION_REVISION))

        async with engine.begin() as connection:
            await connection.execute(
                text(
                    """
                    INSERT INTO users (id, name, email, role, password_hash, metadata)
                    VALUES ('orphan-op', 'Orphan', 'orphan@example.com',
                            'admin', 'bcrypt-hash', NULL)
                    """
                )
            )

        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_MIGRATION_UNDER_TEST))

        async with engine.connect() as connection:
            role = (
                await connection.execute(
                    text(
                        "SELECT role FROM tenant_members "
                        "WHERE tenant_id = :t AND user_id = 'orphan-op'"
                    ),
                    {"t": _TENANT_ZERO_ID},
                )
            ).scalar_one()
    finally:
        await engine.dispose()
        await _drop_fixture(postgres_url)

    assert role == "owner"


async def test_a_plain_members_row_is_left_exactly_as_it_is(
    postgres_url: str,
) -> None:
    """Nothing else moves: a non-operator's membership row is not this
    migration's business, whatever role it happens to hold."""
    engine = await _fixture_engine(postgres_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_PRE_MIGRATION_REVISION))

        async with engine.begin() as connection:
            await connection.execute(
                text(
                    """
                    INSERT INTO users (id, name, email, role, password_hash, metadata)
                    VALUES ('plain-member', 'Plain', 'plain@example.com',
                            'user', 'bcrypt-hash', NULL)
                    """
                )
            )
            await connection.execute(
                text(
                    f"""
                    INSERT INTO tenant_members (tenant_id, user_id, role)
                    VALUES ('{_TENANT_ZERO_ID}', 'plain-member', 'member')
                    """
                )
            )

        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_MIGRATION_UNDER_TEST))

        async with engine.connect() as connection:
            role = (
                await connection.execute(
                    text(
                        "SELECT role FROM tenant_members "
                        "WHERE tenant_id = :t AND user_id = 'plain-member'"
                    ),
                    {"t": _TENANT_ZERO_ID},
                )
            ).scalar_one()
    finally:
        await engine.dispose()
        await _drop_fixture(postgres_url)

    assert role == "member"


async def test_running_it_twice_is_a_no_op_the_second_time(
    postgres_url: str,
) -> None:
    engine = await _fixture_engine(postgres_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_PRE_MIGRATION_REVISION))

        async with engine.begin() as connection:
            await connection.execute(
                text(
                    """
                    INSERT INTO users (id, name, email, role, password_hash, metadata)
                    VALUES ('idempotent-op', 'Idempotent', 'idempotent@example.com',
                            'admin', 'bcrypt-hash', NULL)
                    """
                )
            )
            await connection.execute(
                text(
                    f"""
                    INSERT INTO tenant_members (tenant_id, user_id, role)
                    VALUES ('{_TENANT_ZERO_ID}', 'idempotent-op', 'member')
                    """
                )
            )

        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_MIGRATION_UNDER_TEST))
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_MIGRATION_UNDER_TEST))

        async with engine.connect() as connection:
            rows = (
                await connection.execute(
                    text(
                        "SELECT role FROM tenant_members "
                        "WHERE tenant_id = :t AND user_id = 'idempotent-op'"
                    ),
                    {"t": _TENANT_ZERO_ID},
                )
            ).all()
    finally:
        await engine.dispose()
        await _drop_fixture(postgres_url)

    assert [r.role for r in rows] == ["owner"]
