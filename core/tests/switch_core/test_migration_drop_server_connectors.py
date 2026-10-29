"""`e223eae63078` drops the server-side connectors and what only they held.

`test_migration_parity.py` replays the chain into an empty database, so it
cannot see what the revision does to a deployment that ran a connector. This
seeds two, with the agent one registered and the registration keys they
minted, a key left by a connector removed earlier, and keys and agents that
are nobody's connector's; stops the chain one revision short, runs it, and
reads what is left. The downgrade is checked to land on the schema the
revision below built, so it can upgrade again.
"""

from __future__ import annotations

import pytest
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.switch_core.test_migration_drop_feature_flags_table import (
    _CORE,
    _migrate,
    _script_directory,
)
from tests.switch_core.test_migration_operator_owns_tenant_zero import (
    _drop_fixture,
    _fixture_engine,
    _upgrade_to,
)

_MIGRATION_UNDER_TEST = "e223eae63078"
# Whatever the revision follows, so seeding stays one revision short however
# often its `down_revision` is moved onto a newer head.
_PRE_MIGRATION_REVISION = (
    _script_directory(Config(str(_CORE / "alembic.ini")))
    .get_revision(_MIGRATION_UNDER_TEST)
    .down_revision
)
_TENANT_ZERO_ID = "00000000-0000-0000-0000-000000000000"


async def test_the_connectors_go_their_keys_are_retired_and_their_agent_is_named(
    postgres_url: str, caplog: pytest.LogCaptureFixture
) -> None:
    engine = await _fixture_engine(postgres_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_PRE_MIGRATION_REVISION))

        async with engine.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO users (id, name, email, role) "
                    "VALUES ('ada', 'Ada', 'ada@example.com', 'user')"
                )
            )
            await connection.execute(
                text(
                    "INSERT INTO api_keys (tenant_id, id, user_id, key_hash, "
                    "encrypted_key, label, type) VALUES "
                    "(:t, 'connector-key', 'ada', 'h1', 'x', 'server-connector:oc', "
                    "'registration'), "
                    "(:t, 'removed-connector-key', 'ada', 'h5', 'x', "
                    "'server-connector:gone', 'registration'), "
                    "(:t, 'relabelled-key', 'ada', 'h7', 'x', 'relabelled', "
                    "'registration'), "
                    "(:t, 'personal-key', 'ada', 'h2', 'x', 'mine', 'registration'), "
                    "(:t, 'found-key', 'ada', 'h3', 'x', 'found', 'agent'), "
                    "(:t, 'own-key', 'ada', 'h4', 'x', 'own', 'agent'), "
                    "(:t, 'nulled-key', 'ada', 'h6', 'x', 'nulled', 'agent')"
                ),
                {"t": _TENANT_ZERO_ID},
            )
            await connection.execute(
                text(
                    "INSERT INTO server_connectors (tenant_id, id, type, "
                    "display_name, api_key_id, status) "
                    "VALUES (:t, 'c1', 'opencode', 'oc', 'connector-key', 'active'), "
                    "(:t, 'c2', 'opencode', 'other', 'relabelled-key', 'active')"
                ),
                {"t": _TENANT_ZERO_ID},
            )
            await connection.execute(
                text(
                    "INSERT INTO ownership_leases (kind, key, token) "
                    "VALUES ('connector', 'c1', 1), ('client', 'found-client', 1)"
                )
            )
            await connection.execute(
                text(
                    "INSERT INTO clients (tenant_id, id, matrix_user_id, "
                    "display_name, type) VALUES "
                    "(:t, 'found-client', '@found:test', 'found', 'agent'), "
                    "(:t, 'own-client', '@own:test', 'own', 'agent'), "
                    "(:t, 'nulled-client', '@nulled:test', 'nulled', 'agent')"
                ),
                {"t": _TENANT_ZERO_ID},
            )
            await connection.execute(
                text(
                    "INSERT INTO agents (tenant_id, id, name, description, "
                    "agent_type, connector_type, integration_profile, client_id, "
                    "api_key_id, owner_id, metadata) VALUES "
                    "(:t, 'found', 'found', '', 'always_on', 'server-side:opencode', "
                    "'{}', 'found-client', 'found-key', 'ada', :found), "
                    "(:t, 'own', 'own', '', 'auto_session', 'claude-code', "
                    "'{}', 'own-client', 'own-key', 'ada', :own), "
                    "(:t, 'nulled', 'nulled', '', 'always_on', "
                    "'server-side:opencode', '{}', 'nulled-client', 'nulled-key', "
                    "'ada', :nulled)"
                ),
                {
                    "t": _TENANT_ZERO_ID,
                    "found": '{"server_connector_id": "c1", "kept": 1}',
                    # The metadata is the client's to write over HTTP: carrying
                    # the key, or a null under it, is not being a connector's.
                    "own": '{"server_connector_id": "x", "kept": 2}',
                    "nulled": '{"server_connector_id": null, "kept": 3}',
                },
            )

        with caplog.at_level("WARNING", logger="alembic.runtime.migration"):
            async with engine.begin() as connection:
                await connection.run_sync(_upgrade_to(_MIGRATION_UNDER_TEST))

        async with engine.connect() as connection:
            slug = await connection.scalar(
                text(
                    "SELECT t.slug FROM tenants t "
                    "JOIN agents a ON a.tenant_id = t.id WHERE a.id = 'found'"
                )
            )
            table = await connection.scalar(
                text("SELECT to_regclass('server_connectors')")
            )
            functions = await connection.scalar(
                text(
                    "SELECT count(*) FROM pg_proc "
                    "WHERE proname = 'tenant_of_server_connector'"
                )
            )
            keys = {
                row.id: (row.type, row.label)
                for row in await connection.execute(
                    text("SELECT id, type, label FROM api_keys")
                )
            }
            leases = set(
                (
                    await connection.execute(
                        text("SELECT kind, key FROM ownership_leases")
                    )
                ).tuples()
            )
            metadata = {
                row.id: row.metadata
                for row in await connection.execute(
                    text("SELECT id, metadata FROM agents")
                )
            }
    finally:
        await engine.dispose()
        await _drop_fixture(postgres_url)

    assert table is None
    assert functions == 0
    # Retired, not deleted: the keys connectors minted, found by their
    # connector's row or by the label a removed connector's key still carries,
    # and the agent key of the agent a connector registered. Another person's
    # registration key and the keys of agents that only look like a
    # connector's are left as they were.
    gone = " (retired: its server-side connector is gone)"
    assert keys == {
        "connector-key": ("retired", "server-connector:oc" + gone),
        "relabelled-key": ("retired", "relabelled" + gone),
        "removed-connector-key": ("retired", "server-connector:gone" + gone),
        "found-key": ("retired", "found" + gone),
        "personal-key": ("registration", "mine"),
        "own-key": ("agent", "own"),
        "nulled-key": ("agent", "nulled"),
    }
    assert "server-connector:gone" + gone in caplog.text
    # Nothing claims a connector's work any more; every other kind is left.
    assert leases == {("client", "found-client")}
    # The connector's agent stays, for an operator to delete properly, and
    # keeps the mark that says where it came from. Agents that only look like
    # one are not named.
    assert metadata == {
        "found": {"server_connector_id": "c1", "kept": 1},
        "own": {"server_connector_id": "x", "kept": 2},
        "nulled": {"server_connector_id": None, "kept": 3},
    }
    assert f"{slug}/found" in caplog.text
    assert f"{slug}/own" not in caplog.text
    assert f"{slug}/nulled" not in caplog.text


# What the revision below built for the table and its lookup, read from the
# catalogue rather than restated, so the downgrade is held to the schema itself.
_SCHEMA_QUERIES = {
    "columns": (
        "SELECT column_name, data_type, is_nullable, column_default "
        "FROM information_schema.columns WHERE table_name = 'server_connectors' "
        "ORDER BY ordinal_position"
    ),
    "constraints": (
        "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint "
        "WHERE conrelid = 'server_connectors'::regclass ORDER BY conname"
    ),
    "indexes": (
        "SELECT indexname, indexdef FROM pg_indexes "
        "WHERE tablename = 'server_connectors' ORDER BY indexname"
    ),
    "policies": (
        "SELECT policyname, cmd, qual, with_check FROM pg_policies "
        "WHERE tablename = 'server_connectors' ORDER BY policyname"
    ),
    "row_security": (
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class "
        "WHERE relname = 'server_connectors'"
    ),
    "lookup": (
        "SELECT pg_get_functiondef(p.oid) FROM pg_proc p "
        "WHERE p.proname = 'tenant_of_server_connector'"
    ),
    "rows": "SELECT count(*) FROM server_connectors",
}


async def _schema(engine: AsyncEngine) -> dict[str, list[tuple[object, ...]]]:
    async with engine.connect() as connection:
        return {
            name: [tuple(row) for row in await connection.execute(text(query))]
            for name, query in _SCHEMA_QUERIES.items()
        }


async def test_the_downgrade_lands_on_the_schema_the_revision_below_built(
    postgres_url: str,
) -> None:
    engine = await _fixture_engine(postgres_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_PRE_MIGRATION_REVISION))
        before = await _schema(engine)

        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_MIGRATION_UNDER_TEST))
        async with engine.begin() as connection:
            await connection.run_sync(_migrate(_PRE_MIGRATION_REVISION, down=True))
        after = await _schema(engine)

        # And it can go up again from there.
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_MIGRATION_UNDER_TEST))
    finally:
        await engine.dispose()
        await _drop_fixture(postgres_url)

    assert before["rows"] == [(0,)]
    assert len(before["lookup"]) == 1
    assert after == before
