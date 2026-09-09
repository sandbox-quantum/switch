"""Who may point a session at a room.

The lease says who runs a session. This says who may put it in front of people,
and the two are deliberately different records with different writers: a host
writes the lease with its own credential, so a host that could write this could
publish itself into any room it could name.

Nothing here is reachable from the agent bridge. That is the property, and it is
structural rather than checked — there is no route, no operation and no store
call on the host's side of the tree that reaches this module.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from switch_core.authz import Principal, require, require_manage
from switch_core.db.models import SessionRoomAssociation

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from switch_core.db.stores.agent_store import AgentStore
    from switch_core.db.stores.room_store import RoomStore
    from switch_core.db.stores.session_room_association_store import (
        SessionRoomAssociationStore,
    )
    from switch_core.db.stores.session_store import SessionStore

# How an association came about. A granted one was somebody's decision; a
# derived one came from a room message the server itself verified. They are
# recorded apart because they are different amounts of checking, and a later
# reader asking "who decided this room should see this" deserves the real
# answer.
GRANTED = "granted"


class SessionAssociationService:
    def __init__(
        self,
        sessions: SessionStore,
        associations: SessionRoomAssociationStore,
        rooms: RoomStore,
        agents: AgentStore,
    ) -> None:
        self.sessions = sessions
        self.associations = associations
        self.rooms = rooms
        self.agents = agents

    async def grant(
        self,
        db: AsyncSession,
        session_id: str,
        room_id: str,
        principal: Principal,
    ) -> SessionRoomAssociation:
        """Let a session publish into a room, on one actor's authority.

        Two permissions, because the decision exposes two things to each other
        and owning one of them is not owning the other. Publishing a session
        shows a room what that session is doing, so it takes authority over the
        session — held through the agent that owns it, the way every
        agent-initiated request already resolves to its owner. It also puts
        posts in a room, so it takes `write` on the room, the same permission
        the gateway asks for before anything else writes there.

        Raises `PermissionError` for either refusal, `LookupError` for a session
        or agent that is not there, and `SessionAlreadyAssociated` when the
        session already has a room.
        """
        if principal.id is None:
            raise PermissionError("An association has to name the actor granting it.")

        session = await self.sessions.get(db, session_id)
        if session is None:
            raise LookupError(f"Session {session_id!r} is not registered.")
        agent = await self.agents.get(db, session.agent_id)
        if agent is None:
            raise LookupError(f"Session {session_id!r} has no agent behind it.")
        require_manage(principal, agent.owner_id)

        room = await self.rooms.get(db, room_id)
        if room is None:
            raise LookupError(f"Room {room_id!r} does not exist.")
        require(principal, "write", room)

        return await self.associations.associate(
            db,
            SessionRoomAssociation(
                session_id=session_id,
                room_id=room_id,
                thread_id=None,
                origin_message_id=None,
                granted_by_actor_id=principal.id,
                source=GRANTED,
            ),
        )

    async def publication_room(
        self, db: AsyncSession, session_id: str
    ) -> SessionRoomAssociation | None:
        """The room this session may publish into, or nothing.

        Nothing is the answer for every session nobody has associated, and it
        means silence everywhere rather than a sensible default. The publisher
        reads this and stops.
        """
        return await self.associations.get(db, session_id)
