"""`f68b679599ab` keeps services on for the workspaces that had members.

`test_migration_parity.py` replays the chain into an empty database, so it
cannot see what the revision does to an existing deployment's tenants. This
seeds one workspace with a member and one without, stops the chain one
revision short, runs it, and reads the column it adds.
"""

from __future__ import annotations

from sqlalchemy import text

from tests.switch_core.test_migration_operator_owns_tenant_zero import (
    _drop_fixture,
    _fixture_engine,
    _upgrade_to,
)

_PRE_MIGRATION_REVISION = "c7715ebb95c9"
_MIGRATION_UNDER_TEST = "f68b679599ab"
_TENANT_ZERO_ID = "00000000-0000-0000-0000-000000000000"


async def test_a_workspace_with_members_stays_on_and_one_without_starts_off(
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
                    VALUES ('ada', 'Ada', 'ada@example.com', 'user', 'bcrypt-hash',
                            NULL)
                    """
                )
            )
            await connection.execute(
                text(
                    f"""
                    INSERT INTO tenant_members (tenant_id, user_id, role)
                    VALUES ('{_TENANT_ZERO_ID}', 'ada', 'owner')
                    """
                )
            )
            await connection.execute(
                text(
                    "INSERT INTO tenants (id, slug, name) "
                    "VALUES ('empty', 'empty', 'Empty')"
                )
            )

        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_MIGRATION_UNDER_TEST))

        async with engine.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO tenants (id, slug, name) VALUES ('new', 'new', 'New')"
                )
            )

        async with engine.connect() as connection:
            rows = await connection.execute(
                text("SELECT id, services_on_by_default FROM tenants")
            )
            on = {row.id: row.services_on_by_default for row in rows}
    finally:
        await engine.dispose()
        await _drop_fixture(postgres_url)

    assert on == {_TENANT_ZERO_ID: True, "empty": False, "new": False}
