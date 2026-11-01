from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.clients.actor import SystemActor
from switch_core.clients.admin_messages import OnBehalfOf
from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.db.models import Agent, RoomSchedule, User
from switch_core.db.stores.room_schedule_store import RoomScheduleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.scheduler.cron_util import compute_next_run

logger = logging.getLogger(__name__)


def format_scheduled_message(message: str, agent_names: Sequence[str]) -> str:
    """Ensure message explicitly addresses all present target agents with @mentions."""
    mentions_to_add: list[str] = []
    for name in agent_names:
        mention = f"@{name}"
        if mention.lower() not in message.lower():
            mentions_to_add.append(mention)
    if mentions_to_add:
        return f"{' '.join(mentions_to_add)} {message}"
    return message


class RoomScheduleRunner:
    """Background service that periodically executes due room schedules."""

    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        client_lifecycle: ClientLifecycleService | None,
        room_store: RoomStore,
        room_schedule_store: RoomScheduleStore,
        poll_interval: float = 5.0,
        late_threshold_minutes: int = 15,
    ) -> None:
        self._session_factory = session_factory
        self._client_lifecycle = client_lifecycle
        self._room_store = room_store
        self._room_schedule_store = room_schedule_store
        self.poll_interval = poll_interval
        self.late_threshold_minutes = late_threshold_minutes
        self._task: asyncio.Task[None] | None = None
        self._stopping = False

    def start(self) -> asyncio.Task[None]:
        """Start the scheduler loop as an asyncio Task."""
        if self._task is None or self._task.done():
            self._stopping = False
            self._task = asyncio.create_task(self.run())
        return self._task

    async def stop(self) -> None:
        """Stop the background runner gracefully."""
        self._stopping = True
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def run(self) -> None:
        """Main periodic polling loop."""
        logger.info(
            "RoomScheduleRunner started with poll_interval=%.1fs", self.poll_interval
        )
        while not self._stopping:
            try:
                await self.tick()
            except asyncio.CancelledError:
                break
            except Exception:
                logger.exception("Unexpected error during RoomScheduleRunner tick")
            try:
                await asyncio.sleep(self.poll_interval)
            except asyncio.CancelledError:
                break
        logger.info("RoomScheduleRunner stopped")

    async def tick(self, now: datetime | None = None) -> int:
        """Execute one polling tick for all due schedules. Returns the count executed."""
        if now is None:
            now = datetime.now(UTC)
        elif now.tzinfo is None:
            now = now.replace(tzinfo=UTC)

        async with self._session_factory() as session:
            due_schedules = await self._room_schedule_store.fetch_due_schedules(
                session, as_of=now, limit=50
            )
            if not due_schedules:
                return 0

            count = 0
            for schedule in due_schedules:
                try:
                    await self._execute_schedule(session, schedule, now=now)
                    count += 1
                except Exception:
                    logger.exception(
                        "Failed to execute schedule %s for room %s",
                        schedule.id,
                        schedule.room_id,
                    )
            await session.commit()
            return count

    async def _execute_schedule(
        self, session: AsyncSession, schedule: RoomSchedule, now: datetime
    ) -> None:
        """Process an individual due schedule and calculate its next run time."""
        room = await self._room_store.get(session, schedule.room_id)
        if room is None:
            logger.warning(
                "Room %s not found for schedule %s; pausing schedule",
                schedule.room_id,
                schedule.id,
            )
            await self._room_schedule_store.set_status(session, schedule.id, "paused")
            return

        # Check missed run policy: if severely overdue and policy is "skip", skip message delivery
        is_severely_late = False
        if schedule.next_run_at is not None:
            late_delta = now - schedule.next_run_at
            if late_delta > timedelta(minutes=self.late_threshold_minutes):
                is_severely_late = True

        should_skip_message = is_severely_late and schedule.missed_run_policy == "skip"

        if not should_skip_message:
            await self._dispatch_message(session, schedule, room)
        else:
            logger.info(
                "Skipping message dispatch for overdue schedule %s (policy='skip')",
                schedule.id,
            )

        # Advance schedule or mark completed
        if schedule.schedule_type == "one_off":
            await self._room_schedule_store.record_run(
                session,
                schedule.id,
                executed_at=now,
                next_run_at=None,
                mark_completed=True,
            )
        else:
            if not schedule.cron_expression:
                logger.error(
                    "Recurring schedule %s missing cron_expression", schedule.id
                )
                await self._room_schedule_store.set_status(
                    session, schedule.id, "paused"
                )
                return

            next_run = compute_next_run(
                schedule.cron_expression,
                schedule.timezone or "UTC",
                base_time=now,
            )
            await self._room_schedule_store.record_run(
                session,
                schedule.id,
                executed_at=now,
                next_run_at=next_run,
                mark_completed=False,
            )

    async def _dispatch_message(
        self, session: AsyncSession, schedule: RoomSchedule, room: object
    ) -> None:
        """Deliver the scheduled message to the target agents in the room."""
        # Resolve target agents
        target_ids: list[str] = schedule.target_agent_ids or []
        room_id = getattr(room, "id")
        transport_room_id = getattr(room, "transport_room_id")

        agent_ids_in_room = set(await self._room_store.get_agent_ids(session, room_id))
        present_agent_ids = [aid for aid in target_ids if aid in agent_ids_in_room]

        admin = None
        if self._client_lifecycle is not None:
            admins = self._client_lifecycle.get_by_type("admin", schedule.tenant_id)
            admin = next((c for c in admins if isinstance(c, SystemActor)), None)

        if not present_agent_ids:
            # None of the targeted agents are in the room
            logger.warning(
                "None of the target agents %s are present in room %s for schedule %s",
                target_ids,
                room_id,
                schedule.id,
            )
            if admin is not None:
                await admin.send_notice(
                    transport_room_id,
                    f"Scheduled routine '{schedule.name}' could not address target agents: none are present in this room.",
                )
            return

        # Fetch names for the present agents to format @mentions
        agent_names: list[str] = []
        for aid in present_agent_ids:
            agent = await session.get(Agent, aid)
            if agent is not None and agent.name:
                agent_names.append(agent.name)

        body = format_scheduled_message(schedule.message, agent_names)

        if admin is None:
            logger.warning(
                "No SystemActor found for tenant %s; cannot post message",
                schedule.tenant_id,
            )
            return

        # Prepare OnBehalfOf if creator is known
        on_behalf_of: OnBehalfOf | None = None
        if schedule.created_by_user_id:
            creator = await session.get(User, schedule.created_by_user_id)
            if creator is not None:
                name = (
                    getattr(creator, "name", None)
                    or getattr(creator, "email", None)
                    or creator.id
                )
                on_behalf_of = OnBehalfOf(user_id=creator.id, name=name)

        await admin.send_platform_message(
            transport_room_id,
            body,
            on_behalf_of=on_behalf_of,
        )
