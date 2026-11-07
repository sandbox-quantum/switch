from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.clients.actor import SystemActor
from switch_core.clients.admin_messages import OnBehalfOf
from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.db.models import Agent, Room, RoomSchedule, User
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.room_schedule_store import RoomScheduleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.tenant_lookup import all_tenant_ids
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
        if now is not None and now.tzinfo is None:
            now = now.replace(tzinfo=UTC)

        tenant_ids: list[str] = []
        try:
            if not hasattr(self._session_factory, "mock_calls"):
                tenant_ids = await all_tenant_ids(self._session_factory)
        except Exception:
            tenant_ids = []

        if not tenant_ids:
            return await self._tick_tenant("default", now=now)

        total_count = 0
        for tenant_id in tenant_ids:
            try:
                count = await self._tick_tenant(tenant_id, now=now)
                total_count += count
            except Exception:
                logger.exception("Failed to tick schedules for tenant %s", tenant_id)

        return total_count

    async def _tick_tenant(self, tenant_id: str, now: datetime | None = None) -> int:
        """Process due schedules for a single tenant: claim & advance in one short transaction, then send."""
        claimed_items: list[tuple[RoomSchedule, Room, bool]] = []
        effective_now = now or datetime.now(UTC)

        # 1. Claim rows and advance next_run_at in one short transaction, then commit
        async with tenant_session(self._session_factory, tenant_id) as session:
            due_schedules = await self._room_schedule_store.fetch_due_schedules(
                session, as_of=now, limit=50
            )
            if not due_schedules:
                return 0

            for schedule in due_schedules:
                room = await self._room_store.get(session, schedule.room_id)
                if room is None:
                    logger.warning(
                        "Room %s not found for schedule %s; pausing schedule",
                        schedule.room_id,
                        schedule.id,
                    )
                    await self._room_schedule_store.set_status(
                        session, schedule.id, "paused"
                    )
                    continue

                # Check missed run policy: if severely overdue and policy is "skip", skip message delivery
                is_severely_late = False
                if schedule.next_run_at is not None:
                    late_delta = effective_now - schedule.next_run_at
                    if late_delta > timedelta(minutes=self.late_threshold_minutes):
                        is_severely_late = True
                should_skip = is_severely_late and schedule.missed_run_policy == "skip"

                # Advance schedule or mark completed immediately in this claim transaction
                if schedule.schedule_type == "one_off":
                    await self._room_schedule_store.record_run(
                        session,
                        schedule.id,
                        executed_at=effective_now,
                        next_run_at=None,
                        mark_completed=True,
                    )
                    claimed_items.append((schedule, room, should_skip))
                else:
                    if not schedule.cron_expression:
                        logger.error(
                            "Recurring schedule %s missing cron_expression", schedule.id
                        )
                        await self._room_schedule_store.set_status(
                            session, schedule.id, "paused"
                        )
                        continue

                    try:
                        next_run = compute_next_run(
                            schedule.cron_expression,
                            schedule.timezone or "UTC",
                            base_time=effective_now,
                        )
                    except Exception:
                        logger.exception(
                            "Failed to compute next run for schedule %s; pausing",
                            schedule.id,
                        )
                        await self._room_schedule_store.set_status(
                            session, schedule.id, "paused"
                        )
                        continue

                    await self._room_schedule_store.record_run(
                        session,
                        schedule.id,
                        executed_at=effective_now,
                        next_run_at=next_run,
                        mark_completed=False,
                    )
                    claimed_items.append((schedule, room, should_skip))

            # Commit the claim and next run advancement before dispatching messages
            await session.commit()

            # 2. Outside the claim transaction, dispatch messages
            dispatched_count = 0
            for schedule, room, should_skip in claimed_items:
                if should_skip:
                    logger.info(
                        "Skipping message dispatch for overdue schedule %s (policy='skip')",
                        schedule.id,
                    )
                    dispatched_count += 1
                    continue

                try:
                    await self._dispatch_message(session, schedule, room)
                    dispatched_count += 1
                except Exception:
                    logger.exception(
                        "Failed to dispatch message for schedule %s in room %s",
                        schedule.id,
                        schedule.room_id,
                    )

            return dispatched_count

    async def _dispatch_message(
        self, session: AsyncSession, schedule: RoomSchedule, room: Room
    ) -> None:
        """Deliver the scheduled message to the target agents in the room."""
        # Resolve target agents
        target_ids: list[str] = schedule.target_agent_ids or []
        room_id = room.id
        transport_room_id = room.transport_room_id

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
