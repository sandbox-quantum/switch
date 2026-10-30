"""`238c68b7306e` gives every existing workspace an organization of its own.

Seeds two workspaces, one with an owner, an admin and a member and one with
nobody, stops the chain one revision short, runs it, and reads what it made:
one organization per workspace, named as it is, its owners as `org_admin`
and everyone else, admins included, as `member`.
"""

from __future__ import annotations

from sqlalchemy import text

from tests.switch_core.test_migration_operator_owns_tenant_zero import (
    _drop_fixture,
    _fixture_engine,
    _upgrade_to,
)

_PRE_MIGRATION_REVISION = "e5a9c3d71f08"
_MIGRATION_UNDER_TEST = "238c68b7306e"
_TENANT_ZERO_ID = "00000000-0000-0000-0000-000000000000"


async def test_every_workspace_gets_an_organization_and_its_owners_run_it(
    postgres_url: str,
) -> None:
    engine = await _fixture_engine(postgres_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_PRE_MIGRATION_REVISION))

        async with engine.begin() as connection:
            for user in ("ada", "bob", "cy"):
                await connection.execute(
                    text(
                        "INSERT INTO users (id, name, email, role, password_hash, metadata) "
                        f"VALUES ('{user}', '{user}', '{user}@example.com', 'user', "
                        "'bcrypt-hash', NULL)"
                    )
                )
            for user, role in (("ada", "owner"), ("bob", "admin"), ("cy", "member")):
                await connection.execute(
                    text(
                        "INSERT INTO tenant_members (tenant_id, user_id, role) "
                        f"VALUES ('{_TENANT_ZERO_ID}', '{user}', '{role}')"
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

        async with engine.connect() as connection:
            workspaces = {
                row.id: (row.slug, row.name)
                for row in await connection.execute(
                    text(
                        "SELECT tenants.id, organizations.slug, organizations.name "
                        "FROM tenants JOIN organizations "
                        "ON organizations.id = tenants.organization_id"
                    )
                )
            }
            organizations = (
                await connection.execute(text("SELECT count(*) FROM organizations"))
            ).scalar_one()
            members = {
                row.user_id: row.role
                for row in await connection.execute(
                    text(
                        "SELECT organization_members.user_id, organization_members.role "
                        "FROM organization_members JOIN tenants "
                        "ON tenants.organization_id = organization_members.organization_id "
                        f"WHERE tenants.id = '{_TENANT_ZERO_ID}'"
                    )
                )
            }
            empty_members = (
                await connection.execute(
                    text(
                        "SELECT count(*) FROM organization_members JOIN tenants "
                        "ON tenants.organization_id = organization_members.organization_id "
                        "WHERE tenants.id = 'empty'"
                    )
                )
            ).scalar_one()
    finally:
        await engine.dispose()
        await _drop_fixture(postgres_url)

    assert organizations == 2
    assert workspaces[_TENANT_ZERO_ID][0] == "default"
    assert workspaces["empty"] == ("empty", "Empty")
    assert members == {"ada": "org_admin", "bob": "member", "cy": "member"}
    assert empty_members == 0
