"""One database commit accepts both the firing and its room message.

No transport send belongs inside this transaction: transports commit on their
own connection, introducing a crash window on either side of the schedule commit.
"""

from collections.abc import Callable
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.clients.admin_messages import PLATFORM_MARKER
from switch_core.db.models import (
    Agent,
    Client,
    Room,
    RoomSchedule,
    RoomScheduleRun,
    RoomScheduleTarget,
    TenantMember,
    User,
    room_agents,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.user_store import UserStore
from switch_core.delivery.router import MessageRouter, Routed
from switch_core.messages.row import message_row, new_event_id
from switch_core.scheduling.timing import ScheduleTimingError, next_cron_run
from switch_core.transport.content import message_content


class RoomScheduler:
    def __init__(
        self,
        sessions: async_sessionmaker[AsyncSession],
        router: MessageRouter,
        next_run: Callable[[str, str, datetime], datetime] = next_cron_run,
    ) -> None:
        self.sessions = sessions
        self.router = router
        self.next_run = next_run

    async def fire_one(self, tenant_id: str) -> bool:
        routed = None
        async with tenant_session(self.sessions, tenant_id) as session:
            schedule = await session.scalar(
                select(RoomSchedule)
                .where(
                    RoomSchedule.tenant_id == tenant_id,
                    RoomSchedule.paused.is_(False),
                    RoomSchedule.next_run_at <= func.now(),
                )
                .order_by(RoomSchedule.next_run_at, RoomSchedule.id)
                .limit(1)
                .with_for_update(skip_locked=True)
            )
            if schedule is None:
                return False
            routed = await self.record_firing(session, schedule)
            await session.commit()
        if routed is not None:
            routed.committed()
        return True

    async def record_firing(
        self, session: AsyncSession, schedule: RoomSchedule
    ) -> Routed | None:
        """Caller holds the schedule lock and owns the commit/notification."""
        room = await session.get(Room, schedule.room_id)
        author = await session.get(User, schedule.author_id)
        role = await session.scalar(
            select(TenantMember.role).where(
                TenantMember.tenant_id == schedule.tenant_id,
                TenantMember.user_id == schedule.author_id,
            )
        )
        targets = list(
            (
                await session.scalars(
                    select(Agent)
                    .join(RoomScheduleTarget, RoomScheduleTarget.agent_id == Agent.id)
                    .join(room_agents, room_agents.c.agent_id == Agent.id)
                    .where(
                        RoomScheduleTarget.schedule_id == schedule.id,
                        RoomScheduleTarget.tenant_id == schedule.tenant_id,
                        room_agents.c.room_id == schedule.room_id,
                        room_agents.c.tenant_id == schedule.tenant_id,
                    )
                    .order_by(Agent.id)
                )
            ).all()
        )
        is_admin = author is not None and await UserStore().administers(session, author)
        creator = (
            await session.get(Agent, schedule.author_agent_id)
            if schedule.author_agent_id
            else None
        )
        creator_member = (
            await session.scalar(
                select(room_agents.c.agent_id).where(
                    room_agents.c.room_id == schedule.room_id,
                    room_agents.c.agent_id == schedule.author_agent_id,
                    room_agents.c.tenant_id == schedule.tenant_id,
                )
            )
            if schedule.author_agent_id
            else None
        )
        problem = None
        if room is None or room.archived_at is not None:
            problem = "The room is missing or archived."
        elif author is None or not (
            is_admin or (role is not None and room.owner_id == author.id)
        ):
            problem = "The schedule author can no longer manage this room."
        elif schedule.author_agent_id and (
            creator is None
            or creator.owner_id != schedule.author_id
            or creator_member is None
            or role is None
            or room.owner_id != schedule.author_id
        ):
            problem = "The creating agent can no longer manage schedules in this room."
        elif not targets:
            problem = "None of the target agents remains in the room."
        if problem:
            schedule.paused = True
            schedule.last_error = problem
            return None
        assert room is not None and author is not None
        admin = await session.scalar(
            select(Client).where(
                Client.tenant_id == schedule.tenant_id, Client.type == "admin"
            )
        )
        if admin is None:
            # Leave it due: the tenant's admin has not been provisioned yet.
            raise RuntimeError("No platform client exists for the schedule's tenant")
        now = (await session.execute(select(func.clock_timestamp()))).scalar_one()
        try:
            next_due = (
                self.next_run(schedule.cron, schedule.timezone, now)
                if schedule.cron
                else None
            )
        except ScheduleTimingError as exc:
            schedule.paused = True
            schedule.last_error = str(exc)
            return None
        event_id = new_event_id()
        attribution = {"user_id": author.id, "name": author.name}
        if creator is not None:
            attribution = {
                "user_id": author.id,
                "name": creator.name,
                "agent_id": creator.id,
            }
        content = message_content(
            " ".join(f"@{a.name}" for a in targets) + " " + schedule.body,
            sender_name=admin.display_name,
            format="markdown",
            extra_content={PLATFORM_MARKER: {"on_behalf_of": attribution}},
        )
        routed = await self.router.store(
            session,
            tenant_id=schedule.tenant_id,
            room_id=room.id,
            transport_room_id=room.transport_room_id,
            message=message_row(
                room_id=room.id,
                event_id=event_id,
                sender_id=admin.transport_user_id,
                sender_client_id=admin.id,
                sender_name=admin.display_name,
                event_type="m.room.message",
                content=content,
                client_txn_id=None,
            ),
            attachments=[],
            recipient_agent_ids=frozenset(agent.id for agent in targets),
        )
        assert schedule.next_run_at is not None
        session.add(
            RoomScheduleRun(
                tenant_id=schedule.tenant_id,
                schedule_id=schedule.id,
                scheduled_for=schedule.next_run_at,
                message_event_id=event_id,
            )
        )
        schedule.next_run_at = next_due
        schedule.last_error = None
        await session.flush()
        return routed
