"""The deployment's identity, its install clock, and once-ever milestones.

Facts about the installation, not about any tenant in it — so these tables
carry no tenant column and no policy, and are read on a session with nothing
bound, the same shape `users` is read in (`db/session_scope.py`). The modules
are named in `tests/switch_core/db/test_tenant_exemption_allowlist.py`.

`installed_at` is null for a deployment that predates this, and
:func:`seconds_since_install` then returns `None`, which every milestone call
site treats as "do not report".
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import DeploymentIdentity, TelemetryMilestone

logger = logging.getLogger(__name__)


class DeploymentIdentityMissingError(RuntimeError):
    """The singleton identity row is absent.

    Not repaired at runtime: the row records whether this deployment is new,
    and only the migration ran early enough to answer that.
    """


async def load_deployment_identity(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[str, datetime | None]:
    """The deployment's client id and install date.

    Returns `(client_id, installed_at)`, where `installed_at` is `None` for a
    deployment that predates this telemetry.
    """
    async with session_factory() as session:
        row = (
            await session.execute(select(DeploymentIdentity).limit(1))
        ).scalar_one_or_none()
    if row is None:
        raise DeploymentIdentityMissingError(
            "No deployment_identity row. It is seeded by the telemetry "
            "bookkeeping migration; run migrations before starting the "
            "server. It is not recreated here because only the migration ran "
            "early enough to tell a new deployment from an existing one."
        )
    return row.client_id, row.installed_at


def seconds_since_install(installed_at: datetime | None) -> float | None:
    """Elapsed seconds since install, or `None` if that is not knowable.

    `None` propagates all the way to the call site, which then reports
    nothing. Time-to-value describes only deployments watched from their first
    boot.
    """
    if installed_at is None:
        return None
    if installed_at.tzinfo is None:
        installed_at = installed_at.replace(tzinfo=UTC)
    return max((datetime.now(UTC) - installed_at).total_seconds(), 0.0)


async def milestone_claimed(
    session_factory: async_sessionmaker[AsyncSession], name: str
) -> bool:
    """Whether `name` has already been reported, without claiming it.

    For the places that need to know a thing once happened — a connector's
    removal asking whether it ever connected. False on failure.
    """
    try:
        async with session_factory() as session:
            found = await session.execute(
                select(TelemetryMilestone.name).where(TelemetryMilestone.name == name)
            )
            return found.scalar_one_or_none() is not None
    except Exception:
        logger.warning(
            "Could not read the %s telemetry milestone; treating it as unreported.",
            name,
            exc_info=True,
        )
        return False


async def claim_milestone(
    session_factory: async_sessionmaker[AsyncSession], name: str
) -> bool:
    """Take the right to report `name`, once, for this deployment.

    The insert is the guard: the name is the primary key, so a second caller
    collides in the database rather than racing a read-then-write. Returns
    False on failure — a lost milestone beats a failed request.
    """
    try:
        async with session_factory() as session:
            result = await session.execute(
                pg_insert(TelemetryMilestone)
                .values(name=name)
                .on_conflict_do_nothing(index_elements=["name"])
                .returning(TelemetryMilestone.name)
            )
            claimed = result.scalar_one_or_none() is not None
            await session.commit()
            return claimed
    except Exception:
        logger.exception(
            "Could not record the %s telemetry milestone; not reporting it.", name
        )
        return False
