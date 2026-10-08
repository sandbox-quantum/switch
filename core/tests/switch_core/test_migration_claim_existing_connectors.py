"""Connectors that already exist never report `connector_added`.

`connector_added` reports setup time, configuration saved to first connect.
A connector that existed before its first connect was tracked would report its
whole age instead, so the `2575637e78d4` migration takes the claim for every
connector already in the database. This seeds connectors across two tenants
and a claim one of them had already spent, runs the migration, and checks
every connector is claimed exactly once and nothing else is touched.
"""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from tests.switch_core.test_migration_oidc_identities_backfill import _upgrade_to

_DB = "migration_claim_existing_connectors"
_PRE_MIGRATION_REVISION = "e4a7c1d93b25"
_MIGRATION_UNDER_TEST = "2575637e78d4"


@pytest.fixture
async def migration_url(postgres_url: str) -> Any:
    admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
    async with admin.connect() as connection:
        await connection.execute(text(f'DROP DATABASE IF EXISTS "{_DB}"'))
        await connection.execute(text(f'CREATE DATABASE "{_DB}"'))
    await admin.dispose()

    base, _, _ = postgres_url.rpartition("/")
    try:
        yield f"{base}/{_DB}"
    finally:
        admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
        async with admin.connect() as connection:
            await connection.execute(text(f'DROP DATABASE IF EXISTS "{_DB}"'))
        await admin.dispose()


async def test_every_existing_connector_is_claimed_once(migration_url: str) -> None:
    engine = create_async_engine(migration_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_PRE_MIGRATION_REVISION))

        async with engine.begin() as connection:
            # The connectors' tenants and clients are beside the point here, so
            # their foreign keys are not checked while seeding.
            await connection.execute(
                text("SET LOCAL session_replication_role = replica")
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO collaboration_bridges
                        (id, type, display_name, client_id, status, tenant_id)
                    VALUES
                        ('slack-a', 'slack', 'Slack', 'client-a', 'active', 'tenant-a'),
                        ('mm-a', 'mattermost', 'Mattermost', 'client-a', 'active', 'tenant-a'),
                        ('teams-b', 'teams', 'Teams', 'client-b', 'active', 'tenant-b')
                    """
                )
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO telemetry_milestones (name)
                    VALUES ('connector_added:slack-a'), ('first_connector_added')
                    """
                )
            )

        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_MIGRATION_UNDER_TEST))

        async with engine.connect() as connection:
            claims = (
                (
                    await connection.execute(
                        text("SELECT name FROM telemetry_milestones ORDER BY name")
                    )
                )
                .scalars()
                .all()
            )
    finally:
        await engine.dispose()

    assert claims == [
        "connector_added:mm-a",
        "connector_added:slack-a",
        "connector_added:teams-b",
        "first_connector_added",
    ]
