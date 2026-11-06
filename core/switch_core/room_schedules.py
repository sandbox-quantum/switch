"""Scheduled messages: what Switch posts to a room's agents, and when.

A schedule belongs to a room and holds the agents to address, the message, and
either a one-off moment (`once`) or a five-field cron expression read in an
IANA timezone (`cron`, see `schedule_timing.py`). When it fires, Switch's admin
client posts the message in the room, naming the agents with `@name` like any
person would, so each of them receives it as an ordinary mention.

**Who may change a room's schedules** is decided by the callers, not here: the
gateway routes and the agent operations both require the room's owner or a
workspace admin (`authz.can_manage`) before calling in. Write access is not
enough, because rooms are publicly writable by default and a schedule keeps
posting in Switch's name. Anyone who may read the room may list them. The
message speaks with the authority of the person who last changed what is sent
(`updated_by_user_id`), so an agent whose policy admits only its owner answers
a schedule its owner wrote, and no more than that.

**A missed run** is run late, once, when Switch finds it due within
`MISSED_RUN_GRACE` of its time (a restart, an outage). Later than that it is
skipped and recorded as `missed`. Either way a recurring schedule moves on to
its next occurrence after now, so a long outage never fires one message per
tick it missed, and a one-off is finished.

**An agent removed from the room** drops out of the audience when the
schedule fires: the message addresses those still there (`partial`). When none
is left the run is skipped, recorded as `skipped`, and the schedule is paused
so it does not go on posting to nobody.

**Several processes** poll at once. A due schedule is claimed with
`SELECT … FOR UPDATE SKIP LOCKED` and moved on to its next time in the same
transaction, before anything is posted, so one run is posted by one process.
The price is that a process dying between the claim and the post loses that
run rather than repeating it.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from switch_core.clients.actor import SystemActor
from switch_core.clients.admin_messages import OnBehalfOf
from switch_core.db.models import RoomSchedule
from switch_core.db.session_scope import tenant_session
from switch_core.schedule_timing import next_cron_run, parse_cron, parse_timezone

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.clients.client_lifecycle_service import ClientLifecycleService
    from switch_core.db.models import Room
    from switch_core.db.stores.agent_store import AgentStore
    from switch_core.db.stores.room_schedule_store import RoomScheduleStore
    from switch_core.db.stores.room_store import RoomStore
    from switch_core.db.stores.user_store import UserStore

logger = logging.getLogger(__name__)

SCHEDULE_ONCE = "once"
SCHEDULE_CRON = "cron"

OUTCOME_POSTED = "posted"
OUTCOME_PARTIAL = "partial"
OUTCOME_SKIPPED = "skipped"
OUTCOME_MISSED = "missed"
OUTCOME_FAILED = "failed"

#: How long after its time a due run is still posted. Longer overdue, it is skipped.
MISSED_RUN_GRACE = timedelta(hours=24)

#: How often each process looks for due schedules; a run is posted within this
#: long of its time.
POLL_SECONDS = 15.0

MAX_SCHEDULES_PER_ROOM = 50
MAX_MESSAGE_CHARS = 4000
_CLAIM_BATCH = 50


def utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class _Claimed:
    """A run this process claimed: what to post, read before the claim's
    transaction ended."""

    schedule_id: str
    room_id: str
    agent_ids: list[str]
    message: str
    acting_user_id: str | None


@dataclass(frozen=True)
class _Result:
    outcome: str
    error: str | None
    pause: bool = False


class RoomScheduleService:
    """Creating, changing and firing a room's schedules."""

    def __init__(
        self,
        *,
        schedule_store: RoomScheduleStore,
        room_store: RoomStore,
        agent_store: AgentStore,
        user_store: UserStore,
        client_lifecycle: ClientLifecycleService,
        session_factory: async_sessionmaker[AsyncSession],
        clock: Callable[[], datetime],
    ) -> None:
        self._schedules = schedule_store
        self._room_store = room_store
        self._agent_store = agent_store
        self._user_store = user_store
        self._client_lifecycle = client_lifecycle
        self._session_factory = session_factory
        self._clock = clock

    # ── Managing ──────────────────────────────────────────────────────────────

    async def list_for_room(
        self, session: AsyncSession, room_id: str
    ) -> list[RoomSchedule]:
        return await self._schedules.list_for_room(session, room_id)

    async def create(
        self,
        session: AsyncSession,
        room: Room,
        *,
        agent_ids: list[str],
        message: str,
        schedule_type: str,
        cron_expression: str | None,
        run_at: datetime | None,
        timezone: str,
        acting_user_id: str | None,
    ) -> RoomSchedule:
        """Add a schedule to `room`. ValueError says what is wrong with it."""
        if await self._schedules.count_for_room(session, room.id) >= (
            MAX_SCHEDULES_PER_ROOM
        ):
            raise ValueError(
                f"A room has at most {MAX_SCHEDULES_PER_ROOM} schedules; "
                "delete one first"
            )
        agents = await self._room_agents(session, room.id, agent_ids)
        text = _clean_message(message)
        cron, run_at_utc = _timing(schedule_type, cron_expression, run_at, timezone)
        next_run_at = _next_run(
            schedule_type, cron, run_at_utc, timezone, self._clock()
        )
        return await self._schedules.add(
            session,
            RoomSchedule(
                room_id=room.id,
                created_by_user_id=acting_user_id,
                updated_by_user_id=acting_user_id,
                agent_ids=agents,
                message=text,
                schedule_type=schedule_type,
                cron_expression=cron,
                run_at=run_at_utc,
                timezone=timezone,
                enabled=True,
                next_run_at=next_run_at,
            ),
        )

    async def update(
        self,
        session: AsyncSession,
        room: Room,
        schedule_id: str,
        *,
        agent_ids: list[str] | None,
        message: str | None,
        schedule_type: str | None,
        cron_expression: str | None,
        run_at: datetime | None,
        timezone: str | None,
        enabled: bool | None,
        acting_user_id: str | None,
    ) -> RoomSchedule:
        """Change a schedule; a field left None stays as it is.

        Pausing clears `next_run_at`. Resuming works the next run out again
        from now, so a schedule paused through its time does not fire the
        moment it is resumed. A timing change replaces the timing as a whole:
        switching to `cron` drops the one-off time, switching to `once` drops
        the expression.
        """
        schedule = await self._schedules.get(session, room.id, schedule_id)
        if schedule is None:
            raise LookupError(f"Schedule not found: {schedule_id}")
        now = self._clock()

        sent_changed = False
        if agent_ids is not None:
            agents = await self._room_agents(session, room.id, agent_ids)
            sent_changed = sent_changed or agents != schedule.agent_ids
            schedule.agent_ids = agents
        if message is not None:
            text = _clean_message(message)
            sent_changed = sent_changed or text != schedule.message
            schedule.message = text
        if sent_changed:
            schedule.updated_by_user_id = acting_user_id

        new_type = schedule_type or schedule.schedule_type
        new_zone = timezone or schedule.timezone
        cron, run_at_utc = _timing(
            new_type,
            cron_expression
            or (schedule.cron_expression if new_type == SCHEDULE_CRON else None),
            run_at or (schedule.run_at if new_type == SCHEDULE_ONCE else None),
            new_zone,
        )
        timing_changed = (
            new_type,
            cron,
            run_at_utc,
            new_zone,
        ) != (
            schedule.schedule_type,
            schedule.cron_expression,
            schedule.run_at,
            schedule.timezone,
        )
        schedule.schedule_type = new_type
        schedule.cron_expression = cron
        schedule.run_at = run_at_utc
        schedule.timezone = new_zone

        if enabled is not None:
            schedule.enabled = enabled
        if not schedule.enabled:
            schedule.next_run_at = None
        elif timing_changed or schedule.next_run_at is None:
            schedule.next_run_at = _next_run(new_type, cron, run_at_utc, new_zone, now)
        await session.flush()
        await session.refresh(schedule)
        return schedule

    async def delete(self, session: AsyncSession, room: Room, schedule_id: str) -> None:
        schedule = await self._schedules.get(session, room.id, schedule_id)
        if schedule is None:
            raise LookupError(f"Schedule not found: {schedule_id}")
        await self._schedules.delete(session, schedule)

    async def _room_agents(
        self, session: AsyncSession, room_id: str, agent_ids: list[str]
    ) -> list[str]:
        """`agent_ids` without repeats, each of which must be in the room."""
        unique = list(dict.fromkeys(agent_ids))
        if not unique:
            raise ValueError("Choose at least one agent to address")
        in_room = set(await self._room_store.get_agent_ids(session, room_id))
        outside = [agent_id for agent_id in unique if agent_id not in in_room]
        if outside:
            raise ValueError(
                "Agents must be in the room to be addressed: " + ", ".join(outside)
            )
        return unique

    # ── Firing ────────────────────────────────────────────────────────────────

    async def run_due(self, tenant_id: str) -> int:
        """Post what is due in `tenant_id` now; how many were posted.

        Called every `POLL_SECONDS` for each tenant by the loop in `main.py`,
        which is what knows which tenants exist.
        """
        now = self._clock()
        posted = 0
        while True:
            async with tenant_session(self._session_factory, tenant_id) as session:
                claimed, seen = await self._claim(session, now)
                await session.commit()
            for run in claimed:
                result = await self._post(tenant_id, run)
                if result.outcome in (OUTCOME_POSTED, OUTCOME_PARTIAL):
                    posted += 1
                await self._record(tenant_id, run, now, result)
            if seen < _CLAIM_BATCH:
                return posted

    async def _claim(
        self, session: AsyncSession, now: datetime
    ) -> tuple[list[_Claimed], int]:
        """Lock the due schedules and move each past `now`, so no poll, here
        or in another process, takes it again. What is not too late to post
        is returned, with how many rows were looked at."""
        rows = await self._schedules.claim_due(session, now, _CLAIM_BATCH)
        claimed: list[_Claimed] = []
        for schedule in rows:
            due_at = schedule.next_run_at
            if due_at is None:
                continue
            if schedule.schedule_type == SCHEDULE_CRON and schedule.cron_expression:
                try:
                    schedule.next_run_at = next_cron_run(
                        schedule.cron_expression, schedule.timezone, now
                    )
                except ValueError as e:
                    logger.error("Pausing room schedule %s: %s", schedule.id, e)
                    schedule.enabled = False
                    schedule.next_run_at = None
                    schedule.last_outcome = OUTCOME_FAILED
                    schedule.last_error = str(e)
                    continue
            else:
                schedule.enabled = False
                schedule.next_run_at = None
            if now - due_at > MISSED_RUN_GRACE:
                logger.warning(
                    "Skipping room schedule %s: due %s, over %s ago",
                    schedule.id,
                    due_at.isoformat(),
                    MISSED_RUN_GRACE,
                )
                schedule.last_outcome = OUTCOME_MISSED
                schedule.last_error = (
                    f"Not run: it was due {due_at.isoformat()} and Switch "
                    f"did not get to it within {MISSED_RUN_GRACE}"
                )
                continue
            claimed.append(
                _Claimed(
                    schedule_id=schedule.id,
                    room_id=schedule.room_id,
                    agent_ids=list(schedule.agent_ids),
                    message=schedule.message,
                    acting_user_id=schedule.updated_by_user_id,
                )
            )
        return claimed, len(rows)

    async def _post(self, tenant_id: str, run: _Claimed) -> _Result:
        async with tenant_session(self._session_factory, tenant_id) as session:
            room = await self._room_store.get(session, run.room_id)
            if room is None:
                return _Result(OUTCOME_SKIPPED, "The room no longer exists", True)
            if room.archived_at is not None:
                return _Result(OUTCOME_SKIPPED, "The room is archived")
            in_room = set(await self._room_store.get_agent_ids(session, room.id))
            present = [a for a in run.agent_ids if a in in_room]
            agents = await self._agent_store.get_many(session, present)
            user = (
                await self._user_store.get(session, run.acting_user_id)
                if run.acting_user_id is not None
                else None
            )
            transport_room_id = room.transport_room_id
        if not agents:
            return _Result(
                OUTCOME_SKIPPED,
                "None of the addressed agents is in the room any more",
                True,
            )
        names = sorted(agent.name for agent in agents)
        admin = next(
            (
                client
                for client in self._client_lifecycle.get_by_type("admin", tenant_id)
                if isinstance(client, SystemActor)
            ),
            None,
        )
        if admin is None:
            return _Result(
                OUTCOME_FAILED, "This server has no admin client to post with"
            )
        body = " ".join(f"@{name}" for name in names) + " " + run.message
        try:
            event_id = await admin.send_platform_message(
                transport_room_id,
                body,
                on_behalf_of=OnBehalfOf(user.id, user.name) if user else None,
            )
        except Exception as e:
            logger.exception("Room schedule %s could not post", run.schedule_id)
            return _Result(OUTCOME_FAILED, str(e))
        if event_id is None:
            return _Result(OUTCOME_FAILED, "Switch could not post the message")
        if len(agents) < len(run.agent_ids):
            gone = len(run.agent_ids) - len(agents)
            return _Result(
                OUTCOME_PARTIAL,
                f"{gone} addressed agent(s) no longer in the room were left out",
            )
        return _Result(OUTCOME_POSTED, None)

    async def _record(
        self, tenant_id: str, run: _Claimed, now: datetime, result: _Result
    ) -> None:
        async with tenant_session(self._session_factory, tenant_id) as session:
            schedule = await self._schedules.get(session, run.room_id, run.schedule_id)
            if schedule is None:
                return
            schedule.last_run_at = now
            schedule.last_outcome = result.outcome
            schedule.last_error = result.error
            if result.pause:
                schedule.enabled = False
                schedule.next_run_at = None
            await session.commit()


def schedule_to_dict(schedule: RoomSchedule) -> dict[str, Any]:
    """A schedule as plain JSON, times as ISO 8601 strings in UTC."""

    def iso(moment: datetime | None) -> str | None:
        return moment.astimezone(UTC).isoformat() if moment is not None else None

    return {
        "id": schedule.id,
        "room_id": schedule.room_id,
        "agent_ids": list(schedule.agent_ids),
        "message": schedule.message,
        "schedule_type": schedule.schedule_type,
        "cron_expression": schedule.cron_expression,
        "run_at": iso(schedule.run_at),
        "timezone": schedule.timezone,
        "enabled": schedule.enabled,
        "next_run_at": iso(schedule.next_run_at),
        "last_run_at": iso(schedule.last_run_at),
        "last_outcome": schedule.last_outcome,
        "last_error": schedule.last_error,
        "created_by_user_id": schedule.created_by_user_id,
        "updated_by_user_id": schedule.updated_by_user_id,
        "created_at": iso(schedule.created_at),
        "updated_at": iso(schedule.updated_at),
    }


def parse_schedule_time(text: str | None) -> datetime | None:
    """An ISO 8601 date and time from an agent's call, or ValueError saying it
    is not one."""
    if text is None:
        return None
    try:
        return datetime.fromisoformat(text)
    except ValueError as e:
        raise ValueError(
            f"run_at {text!r} is not an ISO 8601 date and time, such as 2026-12-01T09:00"
        ) from e


def _clean_message(message: str) -> str:
    text = message.strip()
    if not text:
        raise ValueError("The message is empty")
    if len(text) > MAX_MESSAGE_CHARS:
        raise ValueError(f"The message is over {MAX_MESSAGE_CHARS} characters")
    return text


def _timing(
    schedule_type: str,
    cron_expression: str | None,
    run_at: datetime | None,
    timezone: str,
) -> tuple[str | None, datetime | None]:
    """The timing as stored: `(cron_expression, run_at in UTC)`.

    A one-off time with no offset is read as wall-clock time in `timezone`.
    ValueError says what is wrong with it.
    """
    zone = parse_timezone(timezone)
    if schedule_type == SCHEDULE_CRON:
        if cron_expression is None:
            raise ValueError("A recurring schedule needs a cron expression")
        parse_cron(cron_expression)
        return cron_expression.strip(), None
    if schedule_type == SCHEDULE_ONCE:
        if run_at is None:
            raise ValueError("A one-off schedule needs a date and time")
        if run_at.tzinfo is None:
            run_at = run_at.replace(tzinfo=zone)
        return None, run_at.astimezone(UTC)
    raise ValueError(f"Unknown schedule type {schedule_type!r}: use once or cron")


def _next_run(
    schedule_type: str,
    cron_expression: str | None,
    run_at: datetime | None,
    timezone: str,
    now: datetime,
) -> datetime:
    if schedule_type == SCHEDULE_CRON and cron_expression is not None:
        return next_cron_run(cron_expression, timezone, now)
    if run_at is None or run_at <= now:
        raise ValueError("The date and time is in the past")
    return run_at
