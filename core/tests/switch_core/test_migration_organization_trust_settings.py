"""`b7d24e9c1f53` copies the server's Switch Trust policy into every
organization, so nothing checked before the upgrade goes unchecked after it.

`test_migration_parity.py` replays the chain into an empty database, which
has no policy to copy. This seeds one, stops the chain one revision short,
runs it, and reads what each organization got.
"""

from __future__ import annotations

from sqlalchemy import text

from tests.switch_core.test_migration_operator_owns_tenant_zero import (
    _drop_fixture,
    _fixture_engine,
    _upgrade_to,
)

_PRE_MIGRATION_REVISION = "d7a3c1e9f205"
_MIGRATION_UNDER_TEST = "b7d24e9c1f53"


async def _organizations_after(
    postgres_url: str, server_policy: str | None
) -> tuple[set[str], dict]:
    """Every organization there is, and what each was given."""
    engine = await _fixture_engine(postgres_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_PRE_MIGRATION_REVISION))

        async with engine.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO organizations (id, slug, name) "
                    "VALUES ('acme', 'acme', 'Acme')"
                )
            )
            if server_policy is not None:
                await connection.execute(text(server_policy))

        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_MIGRATION_UNDER_TEST))

        async with engine.connect() as connection:
            organizations = set(
                await connection.scalars(text("SELECT id FROM organizations"))
            )
            rows = await connection.execute(
                text(
                    "SELECT organization_id, endpoint, policy_id, policy_name, "
                    "api_key_encrypted, updated_by FROM organization_trust_settings"
                )
            )
            return organizations, {
                row.organization_id: (
                    row.endpoint,
                    row.policy_id,
                    row.policy_name,
                    row.api_key_encrypted,
                    row.updated_by,
                )
                for row in rows
            }
    finally:
        await engine.dispose()
        await _drop_fixture(postgres_url)


async def test_the_servers_policy_is_copied_into_every_organization(
    postgres_url: str,
) -> None:
    organizations, copied = await _organizations_after(
        postgres_url,
        "INSERT INTO trust_settings (id, endpoint, policy_id, api_key_encrypted) "
        "VALUES ('global', 'https://trust.example', 'pol_1', 'enc:v1$token')",
    )

    # The default organization the chain made, and the one seeded here.
    assert len(organizations) == 2 and "acme" in organizations
    expected = ("https://trust.example", "pol_1", None, "enc:v1$token", None)
    assert copied == dict.fromkeys(organizations, expected)


async def test_no_policy_on_the_server_connects_none(postgres_url: str) -> None:
    _, copied = await _organizations_after(postgres_url, None)

    assert copied == {}


async def test_a_server_policy_missing_its_key_checked_nothing_and_is_not_copied(
    postgres_url: str,
) -> None:
    _, copied = await _organizations_after(
        postgres_url,
        "INSERT INTO trust_settings (id, endpoint, policy_id, api_key_encrypted) "
        "VALUES ('global', 'https://trust.example', 'pol_1', NULL)",
    )

    assert copied == {}
