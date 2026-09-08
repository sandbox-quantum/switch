"""The oidc_identities backfill migration moves real data correctly.

`test_migration_parity.py` replays the chain into an *empty* database, so it
can never catch a bug in the data the `04f27f37e474` migration moves — a
lost, duplicated or misattributed row would pass every other test and only
show up against a deployment's actual `users` table. This test seeds rows the
way years of real logins would have left them, stops the chain one revision
short of the migration under test, then runs it and inspects what came out.
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
_BACKFILL_DB = "migration_oidc_identities_backfill"

_PRE_MIGRATION_REVISION = "c8e4a10b7f36"
_MIGRATION_UNDER_TEST = "04f27f37e474"


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
async def backfill_url(postgres_url: str) -> Any:
    admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
    async with admin.connect() as connection:
        await connection.execute(text(f'DROP DATABASE IF EXISTS "{_BACKFILL_DB}"'))
        await connection.execute(text(f'CREATE DATABASE "{_BACKFILL_DB}"'))
    await admin.dispose()

    base, _, _ = postgres_url.rpartition("/")
    try:
        yield f"{base}/{_BACKFILL_DB}"
    finally:
        admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
        async with admin.connect() as connection:
            await connection.execute(text(f'DROP DATABASE IF EXISTS "{_BACKFILL_DB}"'))
        await admin.dispose()


async def test_backfill_migrates_full_pairs_and_legacy_rows_and_leaves_others_alone(
    backfill_url: str,
) -> None:
    engine = create_async_engine(backfill_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_PRE_MIGRATION_REVISION))

        async with engine.begin() as connection:
            await connection.execute(
                text(
                    """
                    INSERT INTO users (id, name, email, role, password_hash, metadata)
                    VALUES
                        ('full', 'Full', 'full@example.com', 'user', NULL,
                         '{"oidc_iss": "https://idp.example", "oidc_sub": "okta|9"}'),
                        ('legacy', 'Legacy', 'legacy@example.com', 'user', NULL,
                         '{"oidc_sub": "okta|7"}'),
                        ('password', 'Password', 'password@example.com', 'user',
                         'bcrypt-hash', NULL)
                    """
                )
            )

        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_MIGRATION_UNDER_TEST))

        async with engine.connect() as connection:
            identities = (
                await connection.execute(
                    text(
                        "SELECT user_id, iss, sub FROM oidc_identities ORDER BY user_id"
                    )
                )
            ).all()
            metadata = (
                await connection.execute(
                    text("SELECT id, metadata FROM users ORDER BY id")
                )
            ).all()
    finally:
        await engine.dispose()

    assert identities == [
        ("full", "https://idp.example", "okta|9"),
        ("legacy", None, "okta|7"),
    ]

    by_id = {row.id: row.metadata for row in metadata}
    # Migrated rows lose the pair from metadata — the table is now the only
    # place it lives.
    assert by_id["full"] == {}
    assert by_id["legacy"] == {}
    # A row untouched by OIDC (no oidc_sub key, NULL metadata outright) is
    # left exactly as it was.
    assert by_id["password"] is None
