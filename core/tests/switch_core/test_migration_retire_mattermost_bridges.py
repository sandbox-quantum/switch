"""The `a7d3e5b19c42` migration retires Mattermost connectors.

A Mattermost row left active or as the default would fail every boot and
every room created without a named bridge. This seeds a default Mattermost
connector beside a Slack one, runs the migration, and checks only the
Mattermost row is made retiring and stops being the default.
"""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from tests.switch_core.test_migration_oidc_identities_backfill import _upgrade_to

_DB = "migration_retire_mattermost_bridges"
_PRE_MIGRATION_REVISION = "b7e1d4c9a2f6"
_MIGRATION_UNDER_TEST = "a7d3e5b19c42"


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


async def test_mattermost_connectors_are_retired(migration_url: str) -> None:
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
                        (id, type, display_name, client_id, status, tenant_id, is_default)
                    VALUES
                        ('mm-a', 'mattermost', 'Mattermost', 'client-a', 'active', 'tenant-a', true),
                        ('slack-b', 'slack', 'Slack', 'client-b', 'active', 'tenant-b', true)
                    """
                )
            )

        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_MIGRATION_UNDER_TEST))

        async with engine.connect() as connection:
            rows = (
                await connection.execute(
                    text(
                        "SELECT id, status, is_default FROM collaboration_bridges "
                        "ORDER BY id"
                    )
                )
            ).all()
    finally:
        await engine.dispose()

    assert [tuple(row) for row in rows] == [
        ("mm-a", "retiring", False),
        ("slack-b", "active", True),
    ]
