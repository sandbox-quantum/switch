"""Upgrade a database that ran hosted agents on the old server-side session tables.

`alembic upgrade head` is free to order `b9e4d2a71c05`, which drops those
tables, before the cutover-manifest revision that reads them; the manifest
revision then refuses and the upgrade rolls back. This runs the manifest
revision first, and only once every hosted launch is stopped, so no worker
writes to a volume while its state is captured. A database without those
tables upgrades exactly as `switch-migrate` would.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from alembic import command as alembic_command
from alembic.config import Config as AlembicConfig
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.config import SwitchConfig
from switch_core.db.boot_lock import boot_lock
from switch_core.logging_config import configure_logging
from switch_core.main import _migrate_and_grant
from switch_core.version import switch_core_version

logger = logging.getLogger(__name__)

MANIFEST_REVISION = "a3c9e5f71d28"


class CutoverRefused(RuntimeError):
    """A hosted launch is not stopped, so its volume could still change."""


async def running_launches(config: SwitchConfig) -> list[str] | None:
    """Launches not yet stopped for good; None when the old session tables are gone."""
    engine = create_async_engine(
        config.owner_database_url or config.database_url, poolclass=NullPool
    )
    try:
        async with engine.connect() as conn:
            present = await conn.scalar(
                text(
                    "SELECT to_regclass('sdk_sessions') IS NOT NULL "
                    "AND to_regclass('hosted_launches') IS NOT NULL"
                )
            )
            if not present:
                return None
            rows = await conn.scalars(
                text(
                    "SELECT id FROM hosted_launches "
                    "WHERE state NOT IN ('deleting', 'deleted') "
                    "AND NOT (state = 'stopped' AND desired_state = 'stopped' "
                    "AND sleeping = false) ORDER BY id"
                )
            )
            return list(rows)
    finally:
        await engine.dispose()


async def upgrade(config: SwitchConfig) -> None:
    running = await running_launches(config)
    if running:
        raise CutoverRefused(
            f"{len(running)} hosted launch(es) are not stopped: {', '.join(running)}. "
            "Stop each one with an explicit Stop (desired state stopped, not "
            "sleeping), wait for state stopped, then run this again."
        )
    if running is not None:
        alembic_cfg = AlembicConfig(
            str(Path(__file__).resolve().parent.parent / "alembic.ini")
        )
        async with boot_lock(config):
            await asyncio.to_thread(
                alembic_command.upgrade, alembic_cfg, MANIFEST_REVISION
            )
        logger.warning(
            "Captured the hosted cutover manifest at %s; upgrading to head",
            MANIFEST_REVISION,
        )
    await _migrate_and_grant(config)


def main() -> None:
    config = SwitchConfig()
    configure_logging(config, switch_core_version())
    asyncio.run(upgrade(config))


if __name__ == "__main__":
    main()
