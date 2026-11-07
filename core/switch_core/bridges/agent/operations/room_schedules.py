"""Agent scheduling through the same service Console uses.

An agent acts in rooms it belongs to and its owner manages as a member.
Its owner's workspace-admin reach is never delegated. Firings retain the
agent's identity so target addressing policies judge the agent itself.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.agent.operations.context import get_agent_id, get_protocol
from switch_core.bridges.agent.operations.registry import operation
from switch_core.db.models import Agent, User, require_tenant_id, room_agents
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.user_store import UserStore
from switch_core.scheduling import service


@asynccontextmanager
async def permitted(room_id: str) -> AsyncIterator[tuple[AsyncSession, User, Agent]]:
    protocol = get_protocol()
    tenant_id = require_tenant_id()
    async with tenant_session(protocol.session_factory, tenant_id) as session:
        agent = await protocol.agent_store.get(session, get_agent_id())
        owner = (
            await session.get(User, agent.owner_id)
            if agent and agent.owner_id
            else None
        )
        if agent is None or owner is None:
            raise ValueError("An owned agent is required to manage room schedules.")
        member = await session.scalar(
            select(room_agents.c.agent_id).where(
                room_agents.c.tenant_id == tenant_id,
                room_agents.c.room_id == room_id,
                room_agents.c.agent_id == agent.id,
            )
        )
        if (
            member is None
            or await UserStore().tenant_role(session, tenant_id, owner.id) is None
        ):
            raise ValueError(
                "You and your owner must still belong to this workspace and room."
            )
        await service.managed_room(session, protocol.room_store, room_id, owner, False)
        yield session, owner, agent


@operation
async def list_room_schedules(room_id: str) -> list[dict[str, Any]]:
    """List schedules in a room you belong to and your owner owns.

    Workspace-admin powers are not delegated to agents. Use room and agent IDs
    returned by get_room_detail and list_participants. Returns next runs in UTC.
    """
    async with permitted(room_id) as (session, owner, _agent):
        rows = await service.list_schedules(
            room_id, session, get_protocol().room_store, owner, False
        )
        return [row.model_dump(mode="json") for row in rows]


@operation
async def schedule_room_message(
    room_id: str,
    body: str,
    agent_ids: list[str],
    timezone: str = "UTC",
    cron: str | None = None,
    run_at: datetime | None = None,
) -> dict[str, Any]:
    """Schedule a message to current agents in a room your owner owns.

    You must belong to the room. Supply either a future offset-aware run_at
    or five-field cron with an IANA timezone. The admin posts on your behalf,
    with your agent identity and addressing permissions. Missed repeats run once
    late. Your owner can review, edit or pause the schedule in Console.
    """
    data = service.ScheduleInput(
        body=body, agent_ids=agent_ids, timezone=timezone, cron=cron, run_at=run_at
    )
    async with permitted(room_id) as (session, owner, agent):
        row = await service.create_schedule(
            room_id,
            data,
            session,
            get_protocol().room_store,
            owner,
            False,
            author_agent_id=agent.id,
        )
        return row.model_dump(mode="json")


@operation
async def edit_room_schedule(
    room_id: str,
    schedule_id: str,
    body: str,
    agent_ids: list[str],
    timezone: str = "UTC",
    cron: str | None = None,
    run_at: datetime | None = None,
) -> dict[str, Any]:
    """Replace a room schedule's message, targets and timing. Editing adopts
    the schedule as your agent identity. Authorization and timing match creation.
    """
    data = service.ScheduleInput(
        body=body, agent_ids=agent_ids, timezone=timezone, cron=cron, run_at=run_at
    )
    async with permitted(room_id) as (session, owner, agent):
        row = await service.edit_schedule(
            room_id,
            schedule_id,
            data,
            session,
            get_protocol().room_store,
            owner,
            False,
            author_agent_id=agent.id,
        )
        return row.model_dump(mode="json")


@operation
async def pause_room_schedule(
    room_id: str, schedule_id: str, paused: bool
) -> dict[str, Any]:
    """Pause or resume a schedule in a room your owner owns. Resuming adopts
    your agent identity only when transitioning out of pause. Completed one-offs
    must be edited with a new date. Agents never inherit their owner's admin reach.
    """
    async with permitted(room_id) as (session, owner, agent):
        row = await service.pause_schedule(
            room_id,
            schedule_id,
            service.SchedulePause(paused=paused),
            session,
            get_protocol().room_store,
            owner,
            False,
            author_agent_id=agent.id,
        )
        return row.model_dump(mode="json")


@operation
async def delete_room_schedule(room_id: str, schedule_id: str) -> str:
    """Delete a schedule in a room you belong to and your owner owns. A room
    message committed before deletion stays in the room's history.
    """
    async with permitted(room_id) as (session, owner, _agent):
        await service.delete_schedule(
            room_id, schedule_id, session, get_protocol().room_store, owner, False
        )
        return "Schedule deleted."
