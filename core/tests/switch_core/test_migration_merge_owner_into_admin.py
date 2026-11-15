"""`a3c5e7f9b1d2` turns every workspace owner into an admin.

Seeds an `owner` membership and an `owner` invitation one revision short,
runs the revision, and checks both became `admin` and that `owner` is no
longer accepted.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from tests.switch_core.test_migration_operator_owns_tenant_zero import (
    _drop_fixture,
    _fixture_engine,
    _upgrade_to,
)

_PRE_MIGRATION_REVISION = "f68b679599ab"
_MIGRATION_UNDER_TEST = "a3c5e7f9b1d2"
_TENANT_ZERO_ID = "00000000-0000-0000-0000-000000000000"


async def test_owners_become_admins_and_owner_is_refused(postgres_url: str) -> None:
    engine = await _fixture_engine(postgres_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_PRE_MIGRATION_REVISION))

        async with engine.begin() as connection:
            for user in ("ada", "bob"):
                await connection.execute(
                    text(
                        f"""
                        INSERT INTO users (id, name, email, role, password_hash, metadata)
                        VALUES ('{user}', '{user}', '{user}@example.com', 'user',
                                'bcrypt-hash', NULL)
                        """
                    )
                )
            await connection.execute(
                text(
                    f"""
                    INSERT INTO tenant_members (tenant_id, user_id, role) VALUES
                    ('{_TENANT_ZERO_ID}', 'ada', 'owner'),
                    ('{_TENANT_ZERO_ID}', 'bob', 'member')
                    """
                )
            )
            await connection.execute(
                text(
                    f"""
                    INSERT INTO invitations (id, tenant_id, role, token_hash,
                        expires_at, uses_remaining, created_by)
                    VALUES ('inv', '{_TENANT_ZERO_ID}', 'owner', 'hash',
                        now() + interval '1 day', 1, 'ada')
                    """
                )
            )

        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_MIGRATION_UNDER_TEST))

        async with engine.connect() as connection:
            members = {
                row.user_id: row.role
                for row in await connection.execute(
                    text("SELECT user_id, role FROM tenant_members")
                )
            }
            invitation = await connection.scalar(
                text("SELECT role FROM invitations WHERE id = 'inv'")
            )

        with pytest.raises(IntegrityError):
            async with engine.begin() as connection:
                await connection.execute(
                    text(
                        "UPDATE tenant_members SET role = 'owner' WHERE user_id = 'bob'"
                    )
                )
    finally:
        await engine.dispose()
        await _drop_fixture(postgres_url)

    assert members == {"ada": "admin", "bob": "member"}
    assert invitation == "admin"
