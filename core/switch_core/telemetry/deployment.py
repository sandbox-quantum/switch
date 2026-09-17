"""The deployment's identity, its install clock, and once-ever milestones.

Three facts about the installation rather than about any tenant in it, which is
why all three live in tables carrying no tenant column and no row-level-security
policy, and are read on a session opened straight from the factory with nothing
bound.

That is the same shape `users` and `oidc_identities` are read in, and it is
sanctioned for the same reason (`db/session_scope.py`): there is no tenant for a
policy to narrow on, so binding one would be theatre. It is *not* the old
`unscoped_session` hatch — under the restricted runtime role an unbound session
reads nothing rather than everything, and these tables are readable only because
they were never scoped in the first place. The modules here are named in
`tests/switch_core/db/test_tenant_exemption_allowlist.py` so the choice stays
reviewable.

The install clock is the subtle one. Every time-to-value figure is measured
from `installed_at`, and `installed_at` is null for any deployment that already
existed when this shipped — see the migration for why a guess is worse than
nothing. :func:`seconds_since_install` returns `None` for those, and
every milestone call site treats `None` as "do not report", so a deployment
that cannot be measured honestly stays out of the funnel rather than skewing it.
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

    The migration seeds it, so this means the schema is older than the code or
    the row was deleted by hand. Raised rather than repaired at runtime: the
    row records *whether this deployment is new*, and only the migration ran
    early enough to answer that. Re-creating it here would silently mint a
    fresh identity — a new subject in analytics, and an install date of "now"
    for a deployment that may be a year old.
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
    # A row written before this process started could carry a naive datetime
    # if the column were ever read through a driver that dropped the zone;
    # treating it as UTC is right for a `timestamptz` and avoids a comparison
    # that would raise.
    if installed_at.tzinfo is None:
        installed_at = installed_at.replace(tzinfo=UTC)
    return max((datetime.now(UTC) - installed_at).total_seconds(), 0.0)


async def milestone_claimed(
    session_factory: async_sessionmaker[AsyncSession], name: str
) -> bool:
    """Whether `name` has already been reported, without claiming it.

    The read half of :func:`claim_milestone`, for the places that need to know
    a thing once happened rather than to report that it is happening now — a
    connector's removal asking whether it ever connected, which no in-process
    set can answer across a restart.

    False on failure, like its sibling: this labels an analytics event, and a
    removal must not fail because a lookup did.
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

    True the first time and False forever after. The insert *is* the guard —
    the name is the primary key, so a second caller collides in the database
    rather than racing a read-then-write. That matters even on a single-replica
    server, where two concurrent requests can reach the same first-time event.

    A failure here returns False rather than raising: not reporting a milestone
    is a small loss, and taking down whatever real work was in progress is not.
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
