"""`861ff8767cf4` adds `deployment_identity.telemetry_enabled_since` and
`cloud_machines.first_ready_at`, backfilling each from the one moment an
upgraded deployment can vouch for."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from tests.switch_core.test_migration_oidc_identities_backfill import _upgrade_to

_DB = "migration_telemetry_enabled_since"
_BEFORE = "689d7d8ff913"
_UNDER_TEST = "861ff8767cf4"
_LAST_SENT = datetime(2026, 11, 1, 9, 30, tzinfo=UTC)
_HEARTBEAT = datetime(2026, 11, 2, 10, 0, tzinfo=UTC)


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


async def test_both_columns_start_from_what_is_already_known(
    migration_url: str,
) -> None:
    engine = create_async_engine(migration_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_BEFORE))

        async with engine.begin() as connection:
            await connection.execute(
                text("SET LOCAL session_replication_role = replica")
            )
            await connection.execute(
                text(
                    "INSERT INTO telemetry_snapshot_watermark (id, last_sent_at) "
                    "VALUES (1, :at)"
                ),
                {"at": _LAST_SENT},
            )
            for machine_id, heartbeat in (("up", _HEARTBEAT), ("queued", None)):
                await connection.execute(
                    text(
                        "INSERT INTO cloud_machines (id, owner_id, state, "
                        "active_at, heartbeat_at) VALUES (:id, :id, :state, "
                        "now(), :heartbeat)"
                    ),
                    {
                        "id": machine_id,
                        "state": "ready" if heartbeat else "queued",
                        "heartbeat": heartbeat,
                    },
                )

        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_UNDER_TEST))

        async with engine.connect() as connection:
            enabled_since = await connection.scalar(
                text("SELECT telemetry_enabled_since FROM deployment_identity")
            )
            ready = dict(
                (
                    await connection.execute(
                        text("SELECT id, first_ready_at FROM cloud_machines")
                    )
                ).all()
            )
    finally:
        await engine.dispose()

    assert enabled_since == _LAST_SENT
    assert ready == {"up": _HEARTBEAT, "queued": None}


async def test_a_deployment_that_never_reported_has_no_start(
    migration_url: str,
) -> None:
    engine = create_async_engine(migration_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_UNDER_TEST))
        async with engine.connect() as connection:
            enabled_since = await connection.scalar(
                text("SELECT telemetry_enabled_since FROM deployment_identity")
            )
    finally:
        await engine.dispose()

    assert enabled_since is None
