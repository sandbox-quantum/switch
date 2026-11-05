"""Scheduled messages: Switch posting in a room, at a set time, to its agents.

A schedule belongs to a room and holds the text, the agents it addresses and
when it fires: once at ``run_at``, or on a five-field ``cron`` rule read in an
IANA ``timezone``, so "every weekday at 9:00" stays at 9:00 across a daylight
saving change. When it fires, Switch posts the text in the room as the
platform, with the authority of the person who last edited the schedule, and
mentions each agent, which then gets it like any other mention.

Every switch-core process runs the sweep (`RoomScheduler.fire_due`); a due
schedule is claimed with `FOR UPDATE SKIP LOCKED` and moved to its next run in
the transaction that claims it, so each run fires once however many processes
are running.

**A missed run fires once, late.** A schedule whose time passed while no
process was running fires at the next sweep, and its next run is counted from
then, so a server that was down for a week posts one message, not one per
missed day.

**An agent no longer in the room is dropped** from the schedule when it next
fires, with a notice in the room. A schedule left addressing nobody, or in a
room that has been archived, is paused with the reason, which Console shows
beside it.
"""

from __future__ import annotations

import logging
from collections.abc import Collection
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError, available_timezones

from croniter import croniter
from sqlalchemy import func, select, update

from switch_core.clients.actor import SystemActor
from switch_core.clients.admin_messages import AdminMessageType, OnBehalfOf
from switch_core.db.models import Agent, RoomSchedule, User
from switch_core.db.session_scope import tenant_session

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.clients.client_lifecycle_service import ClientLifecycleService
    from switch_core.db.stores.room_schedule_store import RoomScheduleStore
    from switch_core.db.stores.room_store import RoomStore
    from switch_core.db.stores.user_store import UserStore

logger = logging.getLogger(__name__)

# How often every process looks for due schedules (`main.py`). Rules are to
# the minute, so a firing lands within this many seconds of its time.
SCHEDULE_SWEEP_SECONDS = 10


class ScheduleRefused(ValueError):
    """A change to a schedule that cannot be made: the message says why."""


class ScheduleTimingError(ScheduleRefused):
    """A schedule's timing that cannot be used: the message says why."""


class ScheduleNotFound(LookupError):
    """No such schedule in this room."""


def check_timezone(name: str) -> ZoneInfo:
    if name not in available_timezones():
        raise ScheduleTimingError(f"Unknown timezone {name!r}")
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError as e:
        raise ScheduleTimingError(f"Unknown timezone {name!r}") from e


def check_cron(rule: str) -> str:
    """The rule, normalised to single spaces, if it is a five-field cron rule.

    Five fields only: a sixth would be read as seconds, which the sweep cannot
    keep to.
    """
    fields = rule.split()
    if len(fields) != 5 or not croniter.is_valid(" ".join(fields)):
        raise ScheduleTimingError(
            f"{rule!r} is not a cron rule of five fields (minute hour day month weekday)"
        )
    return " ".join(fields)


def next_cron_run(rule: str, timezone: str, after: datetime) -> datetime:
    """The first time strictly after `after` that `rule` matches, read as wall
    time in `timezone`, returned in UTC."""
    zone = check_timezone(timezone)
    local = after.astimezone(zone)
    return croniter(rule, local).get_next(datetime).astimezone(UTC)


def first_run(
    *, run_at: datetime | None, cron: str | None, timezone: str, now: datetime
) -> datetime:
    """When a schedule with this timing fires first, raising when it never
    would. A one-off must be in the future; it is stored as given."""
    check_timezone(timezone)
    if (run_at is None) == (cron is None):
        raise ScheduleTimingError("Give either a one-off time or a cron rule")
    if run_at is not None:
        if run_at.tzinfo is None:
            raise ScheduleTimingError("A one-off time must carry its UTC offset")
        if run_at <= now:
            raise ScheduleTimingError("A one-off time must be in the future")
        return run_at.astimezone(UTC)
    assert cron is not None
    return next_cron_run(check_cron(cron), timezone, now)


def scheduled_text(body: str, agent_names: list[str], author_name: str) -> str:
    mentions = " ".join(f"@{name}" for name in agent_names)
    return f"{mentions} {body}\n\n_Scheduled by {author_name}_"


@dataclass(frozen=True)
class ScheduleAuthor:
    """Who sets a schedule: a person, or an agent (with its owner as
    ``user_id``), whose message is then judged as that agent speaking."""

    user_id: str
    agent_id: str | None


@dataclass(frozen=True)
class ScheduleEdit:
    """A change to a schedule; a field left None is left as it is.

    ``timing`` replaces the one-off time and the rule together, as
    ``(run_at, cron)`` with exactly one set; ``timezone`` may change alone.
    """

    agent_ids: Collection[str] | None
    body: str | None
    timing: tuple[datetime | None, str | None] | None
    timezone: str | None
    paused: bool | None


@dataclass(frozen=True)
class ScheduleView:
    """A schedule with the names a reader needs: its agents' and its author's."""

    schedule: RoomSchedule
    agents: list[tuple[str, str]]
    author_name: str


class RoomSchedules:
    """The rules for changing a room's schedules, shared by the gateway and
    the agent tools. Callers authorize first; nothing here checks who may."""

    def __init__(
        self, schedule_store: RoomScheduleStore, room_store: RoomStore
    ) -> None:
        self._schedules = schedule_store
        self._rooms = room_store

    async def create(
        self,
        session: AsyncSession,
        *,
        room_id: str,
        author: ScheduleAuthor,
        agent_ids: Collection[str],
        body: str,
        run_at: datetime | None,
        cron: str | None,
        timezone: str,
        now: datetime,
    ) -> RoomSchedule:
        await self._require_agents_in_room(session, room_id, agent_ids)
        cron = check_cron(cron) if cron is not None else None
        next_run_at = first_run(run_at=run_at, cron=cron, timezone=timezone, now=now)
        return await self._schedules.create(
            session,
            room_id=room_id,
            author_id=author.user_id,
            author_agent_id=author.agent_id,
            body=_checked_body(body),
            run_at=run_at,
            cron=cron,
            timezone=timezone,
            next_run_at=next_run_at,
            agent_ids=agent_ids,
        )

    async def edit(
        self,
        session: AsyncSession,
        *,
        room_id: str,
        schedule_id: str,
        author: ScheduleAuthor,
        edit: ScheduleEdit,
        now: datetime,
    ) -> RoomSchedule:
        """Apply `edit`. Setting the text or the agents makes `author` the one
        the message speaks for; pausing or retiming does not."""
        schedule = await self.get(session, room_id, schedule_id)
        if edit.agent_ids is not None:
            await self._require_agents_in_room(session, room_id, edit.agent_ids)
            await self._schedules.set_agents(session, schedule.id, edit.agent_ids)
        if edit.body is not None:
            schedule.body = _checked_body(edit.body)
        if edit.agent_ids is not None or edit.body is not None:
            schedule.author_id = author.user_id
            schedule.author_agent_id = author.agent_id

        retimed = edit.timing is not None or edit.timezone is not None
        if edit.timing is not None:
            run_at, cron = edit.timing
            schedule.run_at = run_at
            schedule.cron = check_cron(cron) if cron is not None else None
        if edit.timezone is not None:
            schedule.timezone = edit.timezone
        if retimed:
            schedule.next_run_at = first_run(
                run_at=schedule.run_at,
                cron=schedule.cron,
                timezone=schedule.timezone,
                now=now,
            )
        if edit.paused is not None and edit.paused != schedule.paused:
            schedule.paused = edit.paused
            if not edit.paused and schedule.cron is not None and not retimed:
                # Runs that fell due while paused are skipped, not caught up.
                schedule.next_run_at = next_cron_run(
                    schedule.cron, schedule.timezone, now
                )

        if not schedule.paused and not (
            await self._schedules.agent_ids(session, [schedule.id])
        ).get(schedule.id):
            raise ScheduleRefused(
                "A schedule must address at least one agent in the room"
            )
        changed_more_than_pausing = (
            edit.agent_ids is not None or edit.body is not None or retimed
        )
        if changed_more_than_pausing or edit.paused is False:
            schedule.last_error = None
        return schedule

    async def delete(
        self, session: AsyncSession, room_id: str, schedule_id: str
    ) -> None:
        await self._schedules.delete(
            session, await self.get(session, room_id, schedule_id)
        )

    async def get(
        self, session: AsyncSession, room_id: str, schedule_id: str
    ) -> RoomSchedule:
        schedule = await self._schedules.get(session, room_id, schedule_id)
        if schedule is None:
            raise ScheduleNotFound(schedule_id)
        return schedule

    async def in_room(self, session: AsyncSession, room_id: str) -> list[ScheduleView]:
        """A room's schedules, oldest first, with their names."""
        return await self.views(
            session, await self._schedules.list_for_room(session, room_id)
        )

    async def views(
        self, session: AsyncSession, schedules: list[RoomSchedule]
    ) -> list[ScheduleView]:
        agent_ids = await self._schedules.agent_ids(session, [s.id for s in schedules])
        wanted = {a for ids in agent_ids.values() for a in ids} | {
            s.author_agent_id for s in schedules if s.author_agent_id is not None
        }
        agent_rows = await session.execute(
            select(Agent.id, Agent.name).where(Agent.id.in_(wanted))
        )
        agent_names = {agent_id: name for agent_id, name in agent_rows.all()}
        user_rows = await session.execute(
            select(User.id, User.name).where(
                User.id.in_({s.author_id for s in schedules})
            )
        )
        user_names = {user_id: name for user_id, name in user_rows.all()}
        return [
            ScheduleView(
                schedule=s,
                agents=[(a, agent_names.get(a, a)) for a in agent_ids.get(s.id, [])],
                author_name=(
                    agent_names.get(s.author_agent_id, s.author_agent_id)
                    if s.author_agent_id is not None
                    else user_names.get(s.author_id, s.author_id)
                ),
            )
            for s in schedules
        ]

    async def agent_ids_by_name(
        self, session: AsyncSession, room_id: str, names: Collection[str]
    ) -> list[str]:
        """The ids of the room's agents with these names, refusing any name
        that is not an agent in the room."""
        in_room = await self._rooms.get_agent_ids(session, room_id)
        rows = await session.execute(
            select(Agent.id, Agent.name).where(Agent.id.in_(in_room))
        )
        by_name = {name.lower(): agent_id for agent_id, name in rows.all()}
        wanted = [name.lstrip("@").lower() for name in names]
        missing = sorted(name for name in wanted if name not in by_name)
        if missing:
            raise ScheduleRefused("Not agents in this room: " + ", ".join(missing))
        return [by_name[name] for name in wanted]

    async def _require_agents_in_room(
        self, session: AsyncSession, room_id: str, agent_ids: Collection[str]
    ) -> None:
        if not agent_ids:
            raise ScheduleRefused(
                "A schedule must address at least one agent in the room"
            )
        missing = set(agent_ids) - set(
            await self._rooms.get_agent_ids(session, room_id)
        )
        if missing:
            raise ScheduleRefused("Not in this room: " + ", ".join(sorted(missing)))


def _checked_body(body: str) -> str:
    if not body.strip():
        raise ScheduleRefused("A schedule needs a message to send")
    return body.strip()


class RoomScheduler:
    """Fires the schedules that are due, in every tenant."""

    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        client_lifecycle: ClientLifecycleService,
        schedule_store: RoomScheduleStore,
        room_store: RoomStore,
        user_store: UserStore,
    ) -> None:
        self._session_factory = session_factory
        self._client_lifecycle = client_lifecycle
        self._schedules = schedule_store
        self._rooms = room_store
        self._users = user_store

    async def fire_due(self, tenant_id: str) -> int:
        """Fire every schedule of `tenant_id` that is due, and return how many
        were claimed."""
        admin = self._admin(tenant_id)
        if admin is None:
            # Not running in this process yet (a tenant made since boot); the
            # processes that have it fire them, and this one does once it starts.
            return 0
        fired = 0
        while await self._fire_one(tenant_id, admin):
            fired += 1
        return fired

    async def _fire_one(self, tenant_id: str, admin: SystemActor) -> bool:
        """Claim one due schedule, move it on and post it. False when none
        was due."""
        async with tenant_session(self._session_factory, tenant_id) as session:
            schedule = await self._schedules.claim_due(session)
            if schedule is None:
                return False
            schedule_id = schedule.id
            now = (await session.execute(select(func.clock_timestamp()))).scalar_one()
            schedule.last_run_at = now
            try:
                schedule.next_run_at = (
                    next_cron_run(schedule.cron, schedule.timezone, now)
                    if schedule.cron is not None
                    else None
                )
            except ScheduleTimingError as e:
                # Paused rather than left due, where it would be claimed first
                # on every sweep and hold up the tenant's other schedules.
                logger.error("Paused room schedule %s: %s", schedule_id, e)
                schedule.paused = True
                schedule.last_error = str(e)
                await session.commit()
                return True
            room = await self._rooms.get(session, schedule.room_id)
            assert room is not None  # the row goes with its room
            wanted = (await self._schedules.agent_ids(session, [schedule.id])).get(
                schedule.id, []
            )
            in_room = set(await self._rooms.get_agent_ids(session, room.id))
            agent_rows = await session.execute(
                select(Agent.id, Agent.name).where(Agent.id.in_(wanted))
            )
            names = {agent_id: name for agent_id, name in agent_rows.all()}
            targets = sorted(names[a] for a in wanted if a in in_room)
            gone = [a for a in wanted if a not in in_room]
            if gone:
                await self._schedules.remove_agents(session, schedule.id, gone)
            problem: str | None = None
            if room.archived_at is not None:
                problem = "The room is archived."
            elif not targets:
                problem = "None of the agents it addresses is in the room any more."
            if problem is not None:
                schedule.paused = True
            schedule.last_error = problem
            author = await self._users.get(session, schedule.author_id)
            assert author is not None  # the row goes with its author
            speaker = (
                await session.get(Agent, schedule.author_agent_id)
                if schedule.author_agent_id is not None
                else None
            )
            body = schedule.body
            transport_room_id = room.transport_room_id
            archived = room.archived_at is not None
            await session.commit()

        if gone and not archived:
            gone_names = ", ".join(names.get(a, a) for a in gone)
            await self._notice(
                admin,
                transport_room_id,
                f"A scheduled message no longer addresses {gone_names}, "
                "who left this room.",
            )
        if problem is not None:
            logger.warning("Paused room schedule %s: %s", schedule_id, problem)
            if not archived:
                await self._notice(
                    admin,
                    transport_room_id,
                    f"A scheduled message was paused. {problem}",
                )
            return True

        # Set by an agent, the message speaks for that agent and is judged as
        # it speaking: never with its owner's authority.
        on_behalf_of = (
            OnBehalfOf(author.id, speaker.name, speaker.id)
            if speaker is not None
            else OnBehalfOf(author.id, author.name)
        )
        event_id = await admin.send_platform_message(
            transport_room_id,
            scheduled_text(body, targets, on_behalf_of.name),
            on_behalf_of=on_behalf_of,
        )
        if event_id is None:
            logger.error("Room schedule %s could not post its message", schedule_id)
            async with tenant_session(self._session_factory, tenant_id) as session:
                await session.execute(
                    update(RoomSchedule)
                    .where(RoomSchedule.id == schedule_id)
                    .values(last_error="Switch could not post the message.")
                )
                await session.commit()
        return True

    def _admin(self, tenant_id: str) -> SystemActor | None:
        admins = self._client_lifecycle.get_by_type("admin", tenant_id)
        return next((c for c in admins if isinstance(c, SystemActor)), None)

    async def _notice(self, admin: SystemActor, room_id: str, text: str) -> None:
        try:
            await admin.send_admin(
                room_id,
                text,
                message_type=AdminMessageType.SCHEDULE_NOTICE,
                thread_root_id=None,
            )
        except Exception:  # noqa: BLE001 - the schedule has moved on either way
            logger.warning(
                "Could not post a schedule notice in %s", room_id, exc_info=True
            )
