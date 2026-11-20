"""Incident control: taking an account out of every room, and freezing a room.

Both are for a workspace admin or the server's operator, never a room's own
admins: they are how info-sec contains a suspicious account or a room, not a
room setting.

`AccountRemoval` takes an agent, or a person (their Switch Console member
client, and with `include_agents` every agent they own), out of every room in
the workspace it is in, through the same single-room removal the rest of
Switch uses: `take_agents_out_of_room` for an agent and `kick_user` for a
member client. Each room gets the departure written into its history, its
`client_rooms` and `room_agents` triggers tell every process, and the room's
listeners are told after. One audit event records the lot. It is a removal,
not a ban: whoever may add the account to a room may add it again, so pair it
with taking away their access where that is the point.

`RoomFreeze` makes a room read-only (`room_read_only.py`) and writable again,
recording who and why, telling the room in an admin notice, and recording an
audit event.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal, Protocol

from sqlalchemy import or_, select

from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.models import (
    Agent,
    Client,
    ClientRoom,
    Room,
    TenantMember,
    room_agents,
)
from switch_core.db.session_scope import tenant_session
from switch_core.room_service import take_agents_out_of_room
from switch_core.tenant_context import tenant_scope

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.db.stores.room_store import RoomStore
    from switch_core.provisioning import Provisioning

logger = logging.getLogger(__name__)

FROZEN_NOTICE = (
    "🧊 A workspace admin has frozen this room. It is read-only: nothing new "
    "can be posted here, by people or agents, until it is unfrozen."
)
UNFROZEN_NOTICE = (
    "A workspace admin has unfrozen this room. People and agents can post here again."
)

# Long enough for an incident reference and a sentence; the reason is shown
# to admins and kept in the audit log, never to the room.
FREEZE_REASON_MAX = 2000


class ModerationTargetNotFound(LookupError):
    """The account or room is not in the workspace."""


class ModerationConflict(Exception):
    """The room is already in the state asked for."""


class RoomListeners(Protocol):
    """What is told once a room's members have changed, after the commit.
    `RoomService` is one; so is the operator command's stand-in."""

    async def room_agents_changed(
        self, tenant_id: str, room_ids: list[str]
    ) -> None: ...

    def room_changed(self, tenant_id: str, room_id: str) -> None: ...


# `(tenant_id, user_ids, room_ids)`: the people whose Switch Console chat
# lists changed, told after the commit (`ChatService.memberships_changed`).
MembershipsChanged = Callable[[str, list[str], list[str]], None]

# `(tenant_id, transport_room_id, body)`: post an admin notice in a room as
# the workspace's system client (`private_channel_rooms.notice_poster`).
NoticePoster = Callable[[str, str, str], Awaitable[None]]


@dataclass(frozen=True)
class RoomRef:
    id: str
    name: str

    def to_json(self) -> dict[str, str]:
        return {"id": self.id, "name": self.name}


@dataclass
class RemovedFromRooms:
    """What `AccountRemoval` took out of where. `agents` maps each agent
    taken out to the rooms it left; `rooms` is the person's own member
    client's rooms, or the agent's when the target is an agent."""

    target_type: Literal["agent", "user"]
    target_id: str
    rooms: list[RoomRef] = field(default_factory=list)
    agents: dict[str, list[RoomRef]] = field(default_factory=dict)

    def room_count(self) -> int:
        return len(
            {room.id for room in self.rooms}
            | {room.id for rooms in self.agents.values() for room in rooms}
        )

    def details(self) -> dict[str, Any]:
        return {
            "rooms": [room.to_json() for room in self.rooms],
            "agents": {
                agent_id: [room.to_json() for room in rooms]
                for agent_id, rooms in self.agents.items()
            },
        }


class AccountRemoval:
    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        provisioning: Provisioning,
        room_store: RoomStore,
        listeners: RoomListeners,
        memberships_changed: MembershipsChanged,
    ) -> None:
        self._session_factory = session_factory
        self._provisioning = provisioning
        self._room_store = room_store
        self._listeners = listeners
        self._memberships_changed = memberships_changed

    async def remove_agent(
        self,
        tenant_id: str,
        agent_id: str,
        *,
        actor_user_id: str | None,
        removed_by: str,
        request: str | None,
    ) -> RemovedFromRooms:
        """Take an agent out of every room in `tenant_id` it is in."""
        result = RemovedFromRooms(target_type="agent", target_id=agent_id)
        async with tenant_session(self._session_factory, tenant_id) as session:
            agent = await session.scalar(
                select(Agent).where(Agent.id == agent_id, Agent.tenant_id == tenant_id)
            )
            if agent is None:
                raise ModerationTargetNotFound(
                    f"No agent {agent_id} in this workspace."
                )
        await self._recorded(
            tenant_id,
            result,
            actor_user_id=actor_user_id,
            request=request,
            remove=lambda: self._remove_agent(
                tenant_id, agent, result.rooms, removed_by=removed_by
            ),
        )
        return result

    async def remove_person(
        self,
        tenant_id: str,
        user_id: str,
        *,
        include_agents: bool,
        actor_user_id: str | None,
        removed_by: str,
        request: str | None,
    ) -> RemovedFromRooms:
        """Take a person's Switch Console member client out of every room in
        `tenant_id` it is in, and with `include_agents` every agent they own
        there too, the agents first. Their accounts on messaging platforms
        are left alone: those follow the platform's channels."""
        result = RemovedFromRooms(target_type="user", target_id=user_id)
        async with tenant_session(self._session_factory, tenant_id) as session:
            member = await session.scalar(
                select(Client).where(
                    Client.tenant_id == tenant_id,
                    Client.user_id == user_id,
                    Client.type == MEMBER_CLIENT_TYPE,
                )
            )
            agents = (
                list(
                    await session.scalars(
                        select(Agent)
                        .where(Agent.tenant_id == tenant_id, Agent.owner_id == user_id)
                        .order_by(Agent.id)
                    )
                )
                if include_agents
                else []
            )
            known = (
                member is not None
                or bool(agents)
                or await session.scalar(
                    select(TenantMember.user_id).where(
                        TenantMember.tenant_id == tenant_id,
                        TenantMember.user_id == user_id,
                    )
                )
                is not None
            )
        if not known:
            raise ModerationTargetNotFound(
                f"Nobody with id {user_id} is in this workspace."
            )

        async def remove() -> None:
            for agent in agents:
                await self._remove_agent(
                    tenant_id,
                    agent,
                    result.agents.setdefault(agent.id, []),
                    removed_by=removed_by,
                )
            if member is not None:
                await self._remove_member(
                    tenant_id, user_id, member, result, removed_by=removed_by
                )

        await self._recorded(
            tenant_id,
            result,
            actor_user_id=actor_user_id,
            request=request,
            remove=remove,
        )
        return result

    async def _recorded(
        self,
        tenant_id: str,
        result: RemovedFromRooms,
        *,
        actor_user_id: str | None,
        request: str | None,
        remove: Callable[[], Awaitable[None]],
    ) -> None:
        """Run `remove` and record one audit event for what it did. A removal
        that fails part-way is recorded too, as incomplete and with what it
        did take out, before the failure is raised."""
        failure: BaseException | None = None
        try:
            await remove()
        except Exception as error:
            failure = error
        details = result.details()
        if request is not None:
            details["request"] = request
        if failure is not None:
            details["incomplete"] = True
            details["error"] = str(failure)
        async with tenant_session(self._session_factory, tenant_id) as session:
            await record_audit_event(
                session,
                tenant_id=tenant_id,
                actor_user_id=actor_user_id,
                action=AuditAction.MEMBER_REMOVED_FROM_ALL_ROOMS,
                target_type=result.target_type,
                target_id=result.target_id,
                details=details,
            )
            await session.commit()
        if failure is not None:
            logger.error(
                "Removing %s %s from every room stopped part-way, after %d rooms",
                result.target_type,
                result.target_id,
                result.room_count(),
            )
            raise failure
        logger.warning(
            "Removed %s %s from every room in tenant %s: %d rooms",
            result.target_type,
            result.target_id,
            tenant_id,
            result.room_count(),
        )

    async def _remove_agent(
        self,
        tenant_id: str,
        agent: Agent,
        left: list[RoomRef],
        *,
        removed_by: str,
    ) -> None:
        """Take `agent` out of each of its rooms, adding each to `left` as
        it goes, so a failure part-way still says which it left."""
        async with tenant_session(self._session_factory, tenant_id) as session:
            client = await session.get(Client, agent.client_id)
            if client is None:
                raise RuntimeError(f"Agent {agent.id} has no client")
            rooms = list(
                await session.scalars(
                    select(Room)
                    .where(
                        or_(
                            Room.id.in_(
                                select(room_agents.c.room_id).where(
                                    room_agents.c.agent_id == agent.id
                                )
                            ),
                            Room.id.in_(
                                select(ClientRoom.room_id).where(
                                    ClientRoom.client_id == client.id
                                )
                            ),
                        )
                    )
                    .order_by(Room.created_at, Room.id)
                )
            )
        for room in rooms:
            await take_agents_out_of_room(
                session_factory=self._session_factory,
                provisioning=self._provisioning,
                room_store=self._room_store,
                room=room,
                agent_ids=[agent.id],
                transport_user_ids=[client.transport_user_id],
                removed_by=removed_by,
            )
            left.append(RoomRef(room.id, room.name))
            with tenant_scope(tenant_id):
                await self._listeners.room_agents_changed(tenant_id, [room.id])
                self._listeners.room_changed(tenant_id, room.id)

    async def _remove_member(
        self,
        tenant_id: str,
        user_id: str,
        member: Client,
        result: RemovedFromRooms,
        *,
        removed_by: str,
    ) -> None:
        async with tenant_session(self._session_factory, tenant_id) as session:
            rooms = list(
                await session.scalars(
                    select(Room)
                    .join(ClientRoom, ClientRoom.room_id == Room.id)
                    .where(ClientRoom.client_id == member.id)
                    .order_by(Room.created_at, Room.id)
                )
            )
        for room in rooms:
            with tenant_scope(tenant_id):
                await self._provisioning.kick_user(
                    room.transport_room_id,
                    member.transport_user_id,
                    removed_by=removed_by,
                )
                result.rooms.append(RoomRef(room.id, room.name))
                self._listeners.room_changed(tenant_id, room.id)
        if rooms:
            self._memberships_changed(tenant_id, [user_id], [room.id for room in rooms])


class RoomFreeze:
    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        room_store: RoomStore,
        post_notice: NoticePoster,
    ) -> None:
        self._session_factory = session_factory
        self._room_store = room_store
        self._post_notice = post_notice

    async def freeze(
        self,
        tenant_id: str,
        room_id: str,
        *,
        actor_user_id: str,
        reason: str,
    ) -> str | None:
        """Make the room read-only and tell it so. Returns why the notice
        could not be posted, or None when it was: the freeze holds either
        way, and the caller says so."""
        reason = reason.strip()
        if not reason:
            raise ValueError("Give a reason for freezing the room.")
        if len(reason) > FREEZE_REASON_MAX:
            raise ValueError(
                f"The reason is {len(reason)} characters; keep it within "
                f"{FREEZE_REASON_MAX}."
            )
        async with tenant_session(self._session_factory, tenant_id) as session:
            room = await self._locked(session, tenant_id, room_id)
            if room.frozen_at is not None:
                raise ModerationConflict(f"Room '{room.name}' is already frozen.")
            await self._room_store.set_frozen(
                session, room, frozen_by=actor_user_id, reason=reason
            )
            await record_audit_event(
                session,
                tenant_id=tenant_id,
                actor_user_id=actor_user_id,
                action=AuditAction.ROOM_FROZEN,
                target_type="room",
                target_id=room.id,
                details={"name": room.name, "reason": reason},
            )
            transport_room_id = room.transport_room_id
            await session.commit()
        logger.warning("Room %s in tenant %s was frozen", room_id, tenant_id)
        return await self._tell(tenant_id, transport_room_id, FROZEN_NOTICE)

    async def unfreeze(
        self, tenant_id: str, room_id: str, *, actor_user_id: str
    ) -> str | None:
        """Make the room writable again and tell it so. Returns why the notice
        could not be posted, or None when it was."""
        async with tenant_session(self._session_factory, tenant_id) as session:
            room = await self._locked(session, tenant_id, room_id)
            if room.frozen_at is None:
                raise ModerationConflict(f"Room '{room.name}' is not frozen.")
            details = {
                "name": room.name,
                "frozen_at": room.frozen_at.isoformat(),
                "frozen_by": room.frozen_by,
                "reason": room.frozen_reason,
            }
            await self._room_store.clear_frozen(session, room)
            await record_audit_event(
                session,
                tenant_id=tenant_id,
                actor_user_id=actor_user_id,
                action=AuditAction.ROOM_UNFROZEN,
                target_type="room",
                target_id=room.id,
                details=details,
            )
            transport_room_id = room.transport_room_id
            await session.commit()
        logger.warning("Room %s in tenant %s was unfrozen", room_id, tenant_id)
        return await self._tell(tenant_id, transport_room_id, UNFROZEN_NOTICE)

    async def _locked(
        self, session: AsyncSession, tenant_id: str, room_id: str
    ) -> Room:
        room = await session.scalar(
            select(Room)
            .where(Room.id == room_id, Room.tenant_id == tenant_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if room is None:
            raise ModerationTargetNotFound(f"Room not found: {room_id}")
        return room

    async def _tell(
        self, tenant_id: str, transport_room_id: str, body: str
    ) -> str | None:
        try:
            with tenant_scope(tenant_id):
                await self._post_notice(tenant_id, transport_room_id, body)
        except Exception as error:
            logger.error(
                "Could not post the freeze notice in room %s",
                transport_room_id,
                exc_info=True,
            )
            return f"The room was not told: {error}"
        return None
