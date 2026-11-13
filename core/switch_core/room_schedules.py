"""Messages Switch posts to a room's agents on a timer.

A schedule is either a recurring cron rule read in its own timezone, or a
one-off moment. When one falls due, Switch posts its text in the room,
addressed to the schedule's agents and on behalf of its author, whoever last
set what it says or to whom, so each agent answers it as it would have
answered that person.

The loop is owned work (`own_room_schedules`): one process runs it at a
time, and a run is still claimed in the database before it is posted
(`RoomScheduleStore.claim`), so a process taking over while the last one is
stopping cannot post it twice. The claim is committed before the post, so a
process that stops between the two leaves that run unsent rather than risk
sending it a second time.

Each run asks again whether its author may still change the room's settings
(its owner, a room admin or a workspace admin), the gate that let them set it. One whose author may not is paused and the room told,
so a schedule never goes on speaking for someone who has lost the room.

A run missed while no process was running is sent once, late, and says so;
the runs before it are not replayed, since the next one is worked out from
the moment the late one went out. An agent that has left the room is no
longer addressed, and a schedule with none of its agents left is paused and
the room told why.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from cronsim import CronSim, CronSimError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core import room_admins, room_policy
from switch_core.archived_workspace import is_archived
from switch_core.authz import Principal
from switch_core.clients.actor import SystemActor
from switch_core.clients.admin_messages import OnBehalfOf
from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.db.models import Room, RoomSchedule, User
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_schedule_store import RoomScheduleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.db.tenant_lookup import all_tenant_ids
from switch_core.ownership import Fence, OwnedKind, Ownership
from switch_core.room_policy import RoomCaller
from switch_core.tenant_context import no_tenant

logger = logging.getLogger(__name__)

FIRE_INTERVAL_SECONDS = 10.0
SCHEDULER_KIND = "room_schedules"
SCHEDULER_KEY = "all"
# A run sent this long after it was due says it is late: past one pass of the
# loop, it was held up by something other than the loop's own interval.
LATE_AFTER = timedelta(minutes=2)


# One platform message (Telegram's limit, the smallest): a schedule asks its
# agents something, it is not a way to post documents on a timer.
TEXT_LIMIT = 4000


class ScheduleError(ValueError):
    """A schedule that cannot be kept as given, said in terms its author can fix."""


def zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as e:
        raise ScheduleError(f"Unknown timezone {name!r}.") from e


def next_cron_run(cron: str, timezone: str, after: datetime) -> datetime:
    """The first moment after `after` that `cron` names, read as wall-clock time in `timezone`.

    A time the clocks skip (02:30 on the morning they go forward) runs at the
    first moment after the gap, and one they repeat runs once.
    """
    try:
        upcoming = CronSim(cron, after.astimezone(zone(timezone)))
        return next(upcoming).astimezone(UTC)
    except CronSimError as e:
        raise ScheduleError(f"{cron!r} is not a cron rule: {e}") from e
    except StopIteration as e:
        raise ScheduleError(f"{cron!r} never comes round again.") from e


def first_run(
    *, cron: str | None, run_at: datetime | None, timezone: str, now: datetime
) -> datetime:
    """When a schedule with this timing first fires, checking the timing is one Switch can keep."""
    zone(timezone)
    if (cron is None) == (run_at is None):
        raise ScheduleError("Give a schedule either a cron rule or a one-off time.")
    if cron is not None:
        return next_cron_run(cron, timezone, now)
    assert run_at is not None
    if run_at.tzinfo is None:
        raise ScheduleError("A one-off time needs its timezone offset.")
    if run_at <= now:
        raise ScheduleError("A one-off time has to be in the future.")
    return run_at.astimezone(UTC)


async def addressed_first_run(
    session: AsyncSession,
    rooms: RoomStore,
    room_id: str,
    *,
    agent_ids: list[str],
    cron: str | None,
    run_at: datetime | None,
    timezone: str,
    now: datetime,
) -> datetime:
    """When a schedule set this way first fires, once every agent it addresses
    is known to be in its room. The one check Console and an agent's tools
    both go through."""
    present = set(await rooms.get_agent_ids(session, room_id))
    missing = [agent_id for agent_id in agent_ids if agent_id not in present]
    if missing:
        raise ScheduleError(
            "A schedule can only address agents in its room. Not here: "
            + ", ".join(missing)
        )
    return first_run(cron=cron, run_at=run_at, timezone=timezone, now=now)


def scheduled_text(
    schedule: RoomSchedule, agent_names: list[str], *, due_at: datetime, now: datetime
) -> str:
    """What is posted for one run: the agents addressed, the text, and a note if it is late."""
    mentions = " ".join(f"@{name}" for name in agent_names)
    text = f"{mentions} {schedule.text}"
    if now - due_at < LATE_AFTER:
        return text
    local = due_at.astimezone(zone(schedule.timezone))
    return (
        f"{text}\n\n(Scheduled for {local:%Y-%m-%d %H:%M} {schedule.timezone}; "
        "sent late because Switch was not running then.)"
    )


async def skip_missed_runs(
    session: AsyncSession, schedules: RoomScheduleStore, now: datetime
) -> int:
    """Move every schedule of the bound workspace that came due while nothing
    could send it on to its next run after `now`, as resuming a paused one
    does: a recurring schedule to its next time, and a one-off that has gone
    by to none, unsent. For a workspace restored after being archived, whose
    schedules did not fire meanwhile (`RoomScheduler.fire_due`). Returns how
    many were moved; the caller commits."""
    missed = await schedules.due(session, now)
    for schedule in missed:
        schedule.next_run_at = (
            next_cron_run(schedule.cron, schedule.timezone, now)
            if schedule.cron is not None
            else None
        )
    await session.flush()
    return len(missed)


def own_room_schedules(
    ownership: Ownership,
    session_factory: async_sessionmaker[AsyncSession],
    client_lifecycle: ClientLifecycleService,
) -> OwnedKind:
    """Register the scheduler as owned work, wanted by this process; it runs
    here only while this process holds it.

    Every process has each tenant's admin actor, so whichever owns it can post
    for all of them. Each run is still claimed in the database before it is
    posted, so the moment two processes overlap as ownership moves posts it
    once.
    """
    scheduler = RoomScheduler(session_factory, client_lifecycle)
    running: dict[str, asyncio.Task[None]] = {}

    def launch(key: str) -> None:
        task = asyncio.create_task(scheduler.run(), name="room-schedules")
        running[key] = task
        task.add_done_callback(lambda done: ended(key, done))

    def ended(key: str, task: asyncio.Task[None]) -> None:
        if task.cancelled() or running.get(key) is not task:
            return
        logger.error(
            "The room scheduler stopped unexpectedly; restarting",
            exc_info=task.exception(),
        )
        launch(key)

    async def start(key: str, fence: Fence) -> None:
        launch(key)

    async def stop(key: str) -> None:
        task = running.pop(key, None)
        if task is None:
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    kind = ownership.kind(SCHEDULER_KIND, start=start, stop=stop)
    kind.want(SCHEDULER_KEY)
    return kind


class RoomScheduler:
    """Posts each due run of every tenant's schedules, claiming each in the database first."""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        client_lifecycle: ClientLifecycleService,
    ) -> None:
        self._sessions = session_factory
        self._lifecycle = client_lifecycle
        self._schedules = RoomScheduleStore()
        self._rooms = RoomStore()
        self._agents = AgentStore()
        self._users = UserStore()

    async def run(self) -> None:
        with no_tenant():
            while True:
                await asyncio.sleep(FIRE_INTERVAL_SECONDS)
                try:
                    await self.fire_due(await self._database_now())
                except Exception:
                    logger.exception("Firing room schedules failed")

    async def _may_manage(self, db: AsyncSession, room: Room, creator: User) -> bool:
        """Whether a schedule's author may still change the room's settings
        (`room_policy`'s `configure`): its owner, a room admin, or an admin."""
        where = await room_admins.standing(db, self._rooms, room.id, creator.id)
        return room_policy.allows(
            RoomCaller(
                Principal(creator.id, await self._users.administers(db, creator)),
                in_room=where.in_room,
                room_admin=where.room_admin,
            ),
            room,
            "configure",
        )

    async def _database_now(self) -> datetime:
        """The database's clock, which every pod shares, so whichever pod owns
        the loop sends a run at the same moment; a pod's own clock can drift."""
        async with self._sessions() as db:
            return (await db.execute(select(func.now()))).scalar_one()

    async def fire_due(self, now: datetime) -> None:
        """One pass over every tenant: post each run due by `now` that this process claims."""
        for tenant_id in await all_tenant_ids(self._sessions):
            admin = next(
                (
                    client
                    for client in self._lifecycle.get_by_type("admin", tenant_id)
                    if isinstance(client, SystemActor)
                ),
                None,
            )
            # Claimed here and not posted would be a run lost, so a process
            # that cannot post for the tenant leaves its runs to one that can.
            if admin is None:
                continue
            async with tenant_session(self._sessions, tenant_id) as db:
                # An archived workspace's schedules wait; the runs missed are
                # skipped when it is restored (`skip_missed_runs`).
                if await is_archived(db, tenant_id):
                    continue
                due = await self._schedules.due(db, now)
            for schedule in due:
                try:
                    await self._fire(tenant_id, admin, schedule, now)
                except Exception:
                    # One schedule's failure must not hold up the others.
                    logger.exception(
                        "Room schedule %s failed to fire in tenant %s",
                        schedule.id,
                        tenant_id,
                    )

    async def _fire(
        self, tenant_id: str, admin: SystemActor, schedule: RoomSchedule, now: datetime
    ) -> None:
        due_at = schedule.next_run_at
        assert due_at is not None
        following = (
            next_cron_run(schedule.cron, schedule.timezone, now)
            if schedule.cron is not None
            else None
        )
        async with tenant_session(self._sessions, tenant_id) as db:
            if not await self._schedules.claim(
                db, schedule.id, due_at=due_at, next_run_at=following, fired_at=now
            ):
                return
            room = await self._rooms.get(db, schedule.room_id)
            creator = await self._users.get(db, schedule.author_id)
            # The gate that let the author set it, asked again: a schedule must
            # not go on speaking for someone who has since lost the room.
            may_speak = (
                room is not None
                and creator is not None
                and await self._may_manage(db, room, creator)
            )
            present = set(await self._rooms.get_agent_ids(db, schedule.room_id))
            # One an agent set speaks as that agent, while it is still here.
            setter = (
                await self._agents.get(db, schedule.author_agent_id)
                if schedule.author_agent_id is not None
                else None
            )
            setter_gone = schedule.author_agent_id is not None and (
                setter is None or setter.id not in present
            )
            names = [
                agent.name
                for agent_id in schedule.agent_ids
                if agent_id in present
                and (agent := await self._agents.get(db, agent_id)) is not None
            ]
            if not may_speak or setter_gone or not names:
                stored = await self._schedules.get(db, schedule.id)
                assert stored is not None
                stored.paused = True
            await db.commit()
        if room is None or creator is None:
            raise RuntimeError(
                f"Schedule {schedule.id} lost its room or its author after claiming a run"
            )
        if not may_speak:
            logger.warning(
                "Paused room schedule %s: its author %s may no longer manage room %s",
                schedule.id,
                creator.id,
                room.id,
            )
            await admin.send_notice(
                room.transport_room_id,
                f"Paused a schedule: {creator.name}, who it speaks for, may no longer "
                "manage this room. Someone who may can edit it to take it over, then resume it.",
            )
            return
        if setter_gone:
            logger.warning(
                "Paused room schedule %s: the agent that set it is not in room %s",
                schedule.id,
                room.id,
            )
            await admin.send_notice(
                room.transport_room_id,
                "Paused a schedule: the agent that set it up is no longer in this room.",
            )
            return
        if not names:
            logger.warning(
                "Paused room schedule %s: none of its agents are in room %s",
                schedule.id,
                room.id,
            )
            await admin.send_notice(
                room.transport_room_id,
                "Paused a schedule: none of the agents it was for are in this room any more.",
            )
            return
        await admin.send_platform_message(
            room.transport_room_id,
            scheduled_text(schedule, names, due_at=due_at, now=now),
            on_behalf_of=(
                OnBehalfOf(creator.id, setter.name, setter.id)
                if setter is not None
                else OnBehalfOf(creator.id, creator.name)
            ),
        )
