"""Older links to accounts many people post as are dropped (CHOO-3881).

Links made before confirmation existed keep working, unverified. Not those on
Telegram's stand-ins or Slack's app and bot ids, which nobody could ever
confirm and which recognise everyone posting as them as the claimant:
`22e1d92cfd4c` deletes those, and only those.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from alembic.config import Config
from alembic.runtime.environment import EnvironmentContext
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, text
from sqlalchemy.ext.asyncio import create_async_engine

from switch_core.db.models import TENANT_ZERO_ID

_CORE = Path(__file__).resolve().parents[2]
_MIGRATION_DB = "migration_drop_links_to_shared_accounts"

_MIGRATION_UNDER_TEST = "22e1d92cfd4c"


def _script_directory(config: Config) -> ScriptDirectory:
    config.set_main_option("script_location", str(_CORE / "switch_core" / "migrations"))
    return ScriptDirectory.from_config(config)


def _pre_migration_revision() -> str:
    config = Config(str(_CORE / "alembic.ini"))
    down = _script_directory(config).get_revision(_MIGRATION_UNDER_TEST).down_revision
    assert isinstance(down, str)
    return down


def _migrate(revision: str) -> Any:
    def migrate(connection: Connection) -> None:
        config = Config(str(_CORE / "alembic.ini"))
        script = _script_directory(config)

        def do_migrate(current_revision: str, context: Any) -> Any:
            return script._upgrade_revs(revision, current_revision)

        with EnvironmentContext(config, script, fn=do_migrate) as environment:
            environment.configure(connection=connection)
            with environment.begin_transaction():
                environment.run_migrations()

    return migrate


# (bridge type, the account's platform id, whether its claim should survive)
_ACCOUNTS = [
    ("telegram", "1087968824", False),
    ("telegram", "136817688", False),
    ("telegram", "777000", False),
    ("telegram", "424242", True),
    ("slack", "B0123ABCD", False),
    ("slack", "USLACKBOT", False),
    ("slack", "U0123ABCD", True),
    ("discord", "1087968824", True),
]


async def test_only_links_to_shared_accounts_are_deleted(postgres_url: str) -> None:
    admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
    async with admin.connect() as connection:
        await connection.execute(text(f'DROP DATABASE IF EXISTS "{_MIGRATION_DB}"'))
        await connection.execute(text(f'CREATE DATABASE "{_MIGRATION_DB}"'))
    base, _, _ = postgres_url.rpartition("/")
    engine = create_async_engine(f"{base}/{_MIGRATION_DB}")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_pre_migration_revision()))
        async with engine.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO users (id, name, email, role) VALUES "
                    "('u1', 'ada', 'ada@example.invalid', 'user'), "
                    "('u2', 'bob', 'bob@example.invalid', 'user')"
                )
            )
            for index, (bridge_type, external_id, _keep) in enumerate(_ACCOUNTS):
                params = {"t": TENANT_ZERO_ID, "i": str(index), "type": bridge_type}
                await connection.execute(
                    text(
                        "INSERT INTO clients (id, tenant_id, matrix_user_id, "
                        "display_name, type) VALUES ('bc' || :i, :t, :mxid, "
                        "'bridge', 'bridge')"
                    ),
                    {**params, "mxid": f"@bridge-{index}:test"},
                )
                await connection.execute(
                    text(
                        "INSERT INTO collaboration_bridges (id, tenant_id, type, "
                        "display_name, client_id, status) VALUES ('b' || :i, :t, "
                        ":type, 'bridge', 'bc' || :i, 'active')"
                    ),
                    params,
                )
                await connection.execute(
                    text(
                        "INSERT INTO clients (id, tenant_id, matrix_user_id, "
                        "display_name, type) VALUES ('ec' || :i, :t, :mxid, "
                        "'person', 'user')"
                    ),
                    {**params, "mxid": f"@person-{index}:test"},
                )
                await connection.execute(
                    text(
                        "INSERT INTO external_users (id, tenant_id, bridge_id, "
                        "external_user_id, external_username, client_id) VALUES "
                        "('e' || :i, :t, 'b' || :i, :ext, 'person', 'ec' || :i)"
                    ),
                    {**params, "ext": external_id},
                )
                await connection.execute(
                    text(
                        "INSERT INTO external_user_claims (tenant_id, "
                        "external_user_id, user_id) VALUES (:t, 'e' || :i, 'u1')"
                    ),
                    params,
                )
                # And a link to it waiting for its code, as an admin's
                # "require confirmation" leaves one.
                await connection.execute(
                    text(
                        "INSERT INTO external_user_link_requests (tenant_id, "
                        "external_user_id, user_id) VALUES (:t, 'e' || :i, 'u2')"
                    ),
                    params,
                )

        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_MIGRATION_UNDER_TEST))

        async with engine.begin() as connection:
            claims = set(
                (
                    await connection.execute(
                        text("SELECT external_user_id FROM external_user_claims")
                    )
                ).scalars()
            )
            requests = set(
                (
                    await connection.execute(
                        text("SELECT external_user_id FROM external_user_link_requests")
                    )
                ).scalars()
            )
        kept = {f"e{index}" for index, (_t, _e, keep) in enumerate(_ACCOUNTS) if keep}
        assert claims == kept
        assert requests == kept
    finally:
        await engine.dispose()
        async with admin.connect() as connection:
            await connection.execute(text(f'DROP DATABASE IF EXISTS "{_MIGRATION_DB}"'))
        await admin.dispose()
