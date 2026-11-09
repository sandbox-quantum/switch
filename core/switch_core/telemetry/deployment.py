"""The deployment's identity, its install clock, and once-ever milestones.

Facts about the installation, not about any tenant in it — so these tables
carry no tenant column and no policy, and are read on a session with nothing
bound, the same shape `users` is read in (`db/session_scope.py`). The modules
are named in `tests/switch_core/db/test_tenant_exemption_allowlist.py`.

`installed_at` is null for a deployment that predates this, and
:func:`seconds_since_install` then returns `None`, which every milestone call
site treats as "do not report".

Milestones are claimed whether telemetry is on or not, so a deployment that
switches it on later does not announce, months in, a "first" it passed while
it was off. What it passed before claims were taken while off is settled from
the database's own evidence (:func:`settle_from_evidence`).
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Literal

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import DeploymentIdentity, TelemetryMilestone

logger = logging.getLogger(__name__)

# The prefix of the claims `session_started` takes per session
# (`telemetry/session_start.py`), here because the milestones below read them.
SESSION_START_CLAIM_PREFIX = "session_started:"

# The prefix of the claim a connector's first connect takes, whether telemetry
# is on or not (`bridges/collaboration/lifecycle_service.py`), followed by the
# connector's id.
CONNECTOR_ADDED_PREFIX = "connector_added:"

# Milestones added after deployments were already running, each with the
# claims that show a deployment passed it before it existed: exact milestone
# names, or a prefix ending in `*`. `settle_superseded_milestones` claims them
# without reporting, so a deployment that did this long ago is never reported
# as doing it for the first time now.
# Claimed beside each superseded milestone once it has been settled, so it is
# settled only once (`settle_superseded_milestones`).
SETTLED_PREFIX = "settled:"

# Claimed beside the evidence settlement once it has run on a deployment, so it
# runs once there unless telemetry is switched on again (`settle_from_evidence`).
EVIDENCE_SETTLED = f"{SETTLED_PREFIX}from_evidence"

# The milestones the database can show a deployment has passed. Not
# `deployment_installed`, which is the install itself and is always reported.
EVIDENCED_MILESTONES = (
    "first_room_created",
    "first_room_active",
    "first_agent_registered",
    "first_agent_connected",
    "first_agent_session",
    "first_connector_added",
)

SUPERSEDED_MILESTONES: dict[str, tuple[str, ...]] = {
    # The same moment as `first_session_started`, which is no longer sent but
    # is still claimed on a deployment that sent it, under the name that says
    # it is a connection.
    "first_agent_connected": ("first_session_started",),
    # A person using a room with an agent in it, or a session reported in the
    # last week (those claims are kept that long), means sessions have run.
    "first_agent_session": ("first_room_active", f"{SESSION_START_CLAIM_PREFIX}*"),
}


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


async def record_telemetry_switch(
    session_factory: async_sessionmaker[AsyncSession], *, enabled: bool
) -> tuple[datetime | None, bool]:
    """Keep `telemetry_enabled_since` in step with this boot's setting.

    With telemetry on, sets it to now if it is empty and leaves it alone
    otherwise; with telemetry off, empties it, so the next boot with it on
    starts it again. Returns `(since, switched_on)`: when reporting began, or
    None while it is off, and whether this boot is the one that switched it on
    — the deployment was off, or new, until now.
    """
    async with session_factory() as session:
        if not enabled:
            await session.execute(
                update(DeploymentIdentity).values(telemetry_enabled_since=None)
            )
            await session.commit()
            return None, False
        started = await session.scalar(
            update(DeploymentIdentity)
            .where(DeploymentIdentity.telemetry_enabled_since.is_(None))
            .values(telemetry_enabled_since=func.now())
            .returning(DeploymentIdentity.telemetry_enabled_since)
        )
        if started is None:
            started = await session.scalar(
                select(DeploymentIdentity.telemetry_enabled_since)
            )
            await session.commit()
            return started, False
        await session.commit()
        return started, True


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


async def prune_claims(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    prefix: str,
    claimed_before: datetime,
) -> int:
    """Delete claims named `prefix...` taken before `claimed_before`.

    Only for claims kept to absorb a repeat, never for a once-ever milestone:
    pruning one of those reports it again. Returns how many went.
    """
    async with session_factory() as session:
        result = await session.execute(
            delete(TelemetryMilestone).where(
                TelemetryMilestone.name.startswith(prefix, autoescape=True),
                TelemetryMilestone.emitted_at < claimed_before,
            )
        )
        await session.commit()
    return int(result.rowcount or 0)  # type: ignore[attr-defined]


async def milestone_claimed(
    session_factory: async_sessionmaker[AsyncSession], name: str
) -> Literal["true", "false", "unknown"]:
    """Whether `name` has already been reported, without claiming it.

    For the one caller that needs to know a thing once happened without
    taking the claim itself — a connector's removal asking whether it ever
    connected. Returns a tri-state rather than a bool: `"unknown"` on a failed
    lookup, since a lookup that could not run is not evidence the milestone
    was never claimed, and the caller reports it as a telemetry property that
    must say so rather than guess.

    Distinct from `claim_milestone`, whose `False` means "not yet claimed" and
    is always the safe answer for its callers (each takes the claim itself, so
    losing a race or a lookup only means reporting nothing rather than
    reporting wrongly) — that contract is unrelated to this one and is not
    changed here.
    """
    try:
        async with session_factory() as session:
            found = await session.execute(
                select(TelemetryMilestone.name).where(TelemetryMilestone.name == name)
            )
            return "true" if found.scalar_one_or_none() is not None else "false"
    except Exception:
        logger.warning(
            "Could not read the %s telemetry milestone; reporting it as unknown.",
            name,
            exc_info=True,
        )
        return "unknown"


async def take_claim(
    session_factory: async_sessionmaker[AsyncSession], name: str
) -> bool:
    """Take the right to report `name`, once, for this deployment. True if
    this caller took it, False if it was already taken; raises if the
    database could not say.

    The insert is the guard: the name is the primary key, so a second caller
    collides in the database rather than racing a read-then-write.
    """
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


async def claim_milestone(
    session_factory: async_sessionmaker[AsyncSession], name: str
) -> bool:
    """`take_claim`, False on a failure as well — a lost milestone beats a
    failed request."""
    try:
        return await take_claim(session_factory, name)
    except Exception:
        logger.exception(
            "Could not record the %s telemetry milestone; not reporting it.", name
        )
        return False


async def claims_named(
    session_factory: async_sessionmaker[AsyncSession], prefix: str
) -> list[str]:
    """Every claim whose name starts with `prefix`, the prefix taken off."""
    async with session_factory() as session:
        names = await session.scalars(
            select(TelemetryMilestone.name).where(
                TelemetryMilestone.name.startswith(prefix, autoescape=True)
            )
        )
        return [name[len(prefix) :] for name in names]


async def settle_from_evidence(
    session_factory: async_sessionmaker[AsyncSession],
    find_passed: Callable[[], Awaitable[set[str]]],
    *,
    switched_on: bool,
) -> list[str]:
    """Claim, without reporting, each milestone the database shows this
    deployment has already passed (`find_passed`, a subset of
    `EVIDENCED_MILESTONES`). Returns the names it claimed.

    Run at boot, before anything can report one. Once per deployment, at the
    first boot that has this, for what happened before milestones were
    claimed while telemetry was off; and again at every boot that switches
    telemetry on (`switched_on`), for the one milestone nothing can claim
    while it is off: a room first used then, which only the snapshot pass
    notices, and it does not run while telemetry is off. On a new deployment
    there is no evidence, so each milestone is reported the first time it
    happens. A failure claims nothing and is logged, leaving the milestone to
    be reported when it next happens.
    """
    try:
        if not switched_on and await claims_named(session_factory, EVIDENCE_SETTLED):
            return []
        passed = await find_passed()
        settled = [
            milestone
            for milestone in EVIDENCED_MILESTONES
            if milestone in passed and await take_claim(session_factory, milestone)
        ]
        # Last, so a settlement that failed part-way runs again at next boot.
        await take_claim(session_factory, EVIDENCE_SETTLED)
    except Exception:
        logger.exception(
            "Could not settle telemetry milestones this deployment had already "
            "passed; each will be reported when it next happens."
        )
        return []
    if settled:
        logger.info(
            "Telemetry milestones already passed, claimed without reporting: %s",
            ", ".join(settled),
        )
    return settled


async def settle_superseded_milestones(
    session_factory: async_sessionmaker[AsyncSession],
) -> list[str]:
    """Claim, without reporting, each `SUPERSEDED_MILESTONES` entry this
    deployment had already passed when they were added. Returns the names it
    claimed.

    Once per deployment, at the first boot that has them, before anything can
    report one: on a new deployment there is no evidence yet, so each is
    reported normally the first time it happens. Only once, because evidence
    written later is the milestone happening, not history: with several
    processes, one booting while another takes the deployment's first session
    would otherwise read that session's claim as history and claim the
    milestone out from under its report. A failure claims nothing and is
    logged, leaving the milestone to be reported when it next happens — late
    rather than lost.
    """
    settled: list[str] = []
    try:
        async with session_factory() as session:
            for milestone, evidence in SUPERSEDED_MILESTONES.items():
                marker = f"{SETTLED_PREFIX}{milestone}"
                if (
                    await session.scalar(
                        pg_insert(TelemetryMilestone)
                        .values(name=marker)
                        .on_conflict_do_nothing(index_elements=["name"])
                        .returning(TelemetryMilestone.name)
                    )
                    is None
                ):
                    continue
                exact = [name for name in evidence if not name.endswith("*")]
                prefixes = [name[:-1] for name in evidence if name.endswith("*")]
                found = await session.scalar(
                    select(TelemetryMilestone.name)
                    .where(
                        or_(
                            TelemetryMilestone.name.in_(exact),
                            *(
                                TelemetryMilestone.name.startswith(
                                    prefix, autoescape=True
                                )
                                for prefix in prefixes
                            ),
                        )
                    )
                    .limit(1)
                )
                if found is None:
                    continue
                claimed = await session.scalar(
                    pg_insert(TelemetryMilestone)
                    .values(name=milestone)
                    .on_conflict_do_nothing(index_elements=["name"])
                    .returning(TelemetryMilestone.name)
                )
                if claimed is not None:
                    settled.append(milestone)
            await session.commit()
    except Exception:
        logger.exception(
            "Could not settle telemetry milestones superseded by newer ones; "
            "each will be reported when it next happens."
        )
        return []
    if settled:
        logger.info(
            "Telemetry milestones already passed before they existed, claimed "
            "without reporting: %s",
            ", ".join(settled),
        )
    return settled
