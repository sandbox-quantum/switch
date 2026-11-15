"""A room's auto-route switch and triage agent, one implementation for the
room detail, the room toggle (`PUT /rooms/{id}/auto-route`) and
`!auto-route`.

The switch is room metadata `auto_route_on`, the triage agent
`auto_route_fallback_agent` (an agent id). Whether auto-route can act in the
room is the workspace's (`decision/settings.py`).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from sqlalchemy import func, select

from switch_core.db.models import Agent, Room, room_agents
from switch_core.db.stores.room_store import (
    RoomStore,
    auto_route_fallback_in,
    auto_route_on_in,
    main_agent_in,
)

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from switch_core.decision.settings import DecisionAvailability


@dataclass(frozen=True)
class AutoRouteState:
    """`on` is the room's switch; `available` whether auto-route can act in
    the room, and `reason` why not; `fallback_agent` the triage agent's id,
    and `fallback_agent_name` its name, for display."""

    on: bool
    available: bool
    reason: str | None
    fallback_agent: str | None
    fallback_agent_name: str | None


class AutoRouteRefused(ValueError):
    """A change to the room's auto-route that cannot be made; the message
    says why, for the person who asked."""


async def auto_route_state(
    session: AsyncSession, availability: DecisionAvailability, room: Room
) -> AutoRouteState:
    checked = await availability.check(session, room.tenant_id)
    fallback_id = auto_route_fallback_in(room.metadata_)
    fallback = await session.get(Agent, fallback_id) if fallback_id else None
    return AutoRouteState(
        on=auto_route_on_in(room.metadata_),
        available=checked.available,
        reason=checked.reason,
        fallback_agent=fallback_id,
        fallback_agent_name=fallback.name if fallback is not None else None,
    )


async def set_auto_route_on(
    session: AsyncSession,
    availability: DecisionAvailability,
    room_store: RoomStore,
    room: Room,
    on: bool,
) -> None:
    """Turn the room's auto-route on or off. Turning it on is refused where
    it cannot act, so nobody is told it is working when it is not; turning it
    off always works."""
    if on:
        checked = await availability.check(session, room.tenant_id)
        if not checked.available:
            raise AutoRouteRefused(checked.reason or "Auto-route is unavailable here.")
    await room_store.set_auto_route_on(session, room.id, on)


async def room_agent(session: AsyncSession, room_id: str, handle: str) -> Agent | None:
    """The agent in the room going by `handle`, ignoring case: its id, its
    name or its alias here, with or without a leading `@`."""
    handle = handle.removeprefix("@").lower()
    result = await session.execute(
        select(Agent)
        .join(room_agents, room_agents.c.agent_id == Agent.id)
        .where(
            room_agents.c.room_id == room_id,
            (func.lower(Agent.id) == handle)
            | (func.lower(Agent.name) == handle)
            | (func.lower(room_agents.c.alias) == handle),
        )
        .limit(1)
    )
    return result.scalar_one_or_none()


async def set_auto_route_fallback(
    session: AsyncSession, room_store: RoomStore, room: Room, agent: Agent | None
) -> None:
    """Name the room's triage agent, or none. It must be in the room, and it
    cannot be the room's assigned agent, which already gets every untagged
    message before auto-route is asked."""
    if agent is not None:
        member = await session.scalar(
            select(room_agents.c.agent_id).where(
                room_agents.c.room_id == room.id, room_agents.c.agent_id == agent.id
            )
        )
        if member is None:
            raise AutoRouteRefused(f"{agent.name} is not in this room.")
        if main_agent_in(room.metadata_) == agent.id:
            raise AutoRouteRefused(
                f"{agent.name} is this room's assigned agent, so it already gets "
                "every message that tags nobody; a triage agent has to be "
                "another agent."
            )
    await room_store.set_auto_route_fallback(
        session, room.id, agent.id if agent is not None else None
    )
