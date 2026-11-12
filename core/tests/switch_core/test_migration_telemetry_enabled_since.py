"""An upgraded server reads as reporting since it began, not since its last pass.

The period counts are dated no earlier than `telemetry_enabled_since`, and a
period that began before it is partial. The `861ff8767cf4` migration backfills
it for a server that already reports, from the best evidence of when that
began: when it claimed `deployment_installed` (a released server does at its
first boot with telemetry on), else its install, else its last snapshot. One
with no sign of ever having reported is left empty for its first boot with
telemetry on to set.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from tests.switch_core.test_migration_oidc_identities_backfill import _upgrade_to

_DB = "migration_telemetry_enabled_since"
_PRE_MIGRATION_REVISION = "d3a8f1c62b07"
_MIGRATION_UNDER_TEST = "861ff8767cf4"

_INSTALLED = datetime(2026, 3, 1, tzinfo=UTC)
_FIRST_REPORTED = datetime(2026, 4, 1, tzinfo=UTC)
_LAST_SNAPSHOT = datetime(2026, 11, 8, tzinfo=UTC)


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


@pytest.mark.parametrize(
    ("installed_at", "claimed_installed", "last_snapshot", "expected"),
    [
        pytest.param(
            _INSTALLED, True, _LAST_SNAPSHOT, _FIRST_REPORTED, id="claimed-install"
        ),
        pytest.param(_INSTALLED, False, _LAST_SNAPSHOT, _INSTALLED, id="install"),
        pytest.param(None, False, _LAST_SNAPSHOT, _LAST_SNAPSHOT, id="last-snapshot"),
        pytest.param(_INSTALLED, False, None, None, id="never-reported"),
    ],
)
async def test_reporting_is_dated_from_when_it_began(
    migration_url: str,
    installed_at: datetime | None,
    claimed_installed: bool,
    last_snapshot: datetime | None,
    expected: datetime | None,
) -> None:
    engine = create_async_engine(migration_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_PRE_MIGRATION_REVISION))

        async with engine.begin() as connection:
            await connection.execute(
                text("UPDATE deployment_identity SET installed_at = :at"),
                {"at": installed_at},
            )
            if claimed_installed:
                await connection.execute(
                    text(
                        "INSERT INTO telemetry_milestones (name, emitted_at) "
                        "VALUES ('deployment_installed', :at)"
                    ),
                    {"at": _FIRST_REPORTED},
                )
            if last_snapshot is not None:
                await connection.execute(
                    text(
                        "INSERT INTO telemetry_snapshot_watermark (id, last_sent_at) "
                        "VALUES (1, :at)"
                    ),
                    {"at": last_snapshot},
                )

        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to(_MIGRATION_UNDER_TEST))

        async with engine.connect() as connection:
            since = (
                await connection.execute(
                    text("SELECT telemetry_enabled_since FROM deployment_identity")
                )
            ).scalar_one()
    finally:
        await engine.dispose()

    assert since == expected
