"""Telling people a room of theirs changed, so their Console reads its room
list again (`switch_core.user_changes`, kind `room`).

Whoever a room concerns is told: its owner, the people in it (through their
Switch Console member client or a platform account they claimed) and the
owners of its agents. A room is reported when it is created or archived or
unarchived, when its agents change, and when anyone joins or leaves it; the
client that left is named so the person who lost the room is told too.

The notice is a "read again", so it is sent from a task of its own after the
change has committed, and a lost one costs only a delay: Console still reads
its lists every few minutes. Changes to a workspace's rooms within
`COALESCE_SECONDS` of the first are read together, in one session and one
query, and sent as one notice per person and room: a bridge adding a
channel's N members makes one read and N notices, not N reads and N²
notices, and an admin changing hundreds of rooms at once makes one read, not
hundreds side by side. Someone concerned by more than `ROOMS_NAMED_MAX` of
them is told once that their rooms changed. The read starts after the window
closes, so it sees every change made in it; a change after that opens a
window of its own.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

from sqlalchemy import (
    CompoundSelect,
    Result,
    Select,
    String,
    column,
    select,
    union,
    values,
)

from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.db.models import (
    Agent,
    Client,
    ClientRoom,
    ExternalUser,
    ExternalUserClaim,
    Room,
    room_agents,
)
from switch_core.db.session_scope import tenant_session
from switch_core.user_changes import ROOM

if TYPE_CHECKING:
    from collections.abc import Mapping

    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.user_changes import UserChangePublisher

logger = logging.getLogger(__name__)

COALESCE_SECONDS = 1.0

# Rooms one window may name to one person before they are told, once, that
# their rooms changed (`user_changes.UserChange` with no id).
ROOMS_NAMED_MAX = 16


class RoomChanges:
    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        publisher: UserChangePublisher,
        window_seconds: float,
    ) -> None:
        self._session_factory = session_factory
        self._publisher = publisher
        self._window_seconds = window_seconds
        self._tasks: set[asyncio.Task[None]] = set()
        # For each tenant with changes not yet read, its changed rooms and the
        # client ids gathered for each.
        self._pending: dict[str, dict[str, set[str]]] = {}
        # The one task per tenant that waits out each window and reads it,
        # one window after another.
        self._publishers: dict[str, asyncio.Task[None]] = {}

    def room_changed(self, tenant_id: str, room_id: str, client_ids: list[str]) -> None:
        """Tell everyone the room concerns, and the people behind `client_ids`
        (who may just have left it), that it changed. Returns at once."""
        self._add(tenant_id, {room_id: client_ids})

    def rooms_changed(self, tenant_id: str, room_ids: list[str]) -> None:
        """`room_changed` for many rooms at once (an agent in each was
        renamed, an admin changed them together). Rooms are told with the
        tenant's open window, or open it."""
        self._add(tenant_id, {room_id: [] for room_id in room_ids})

    def _add(self, tenant_id: str, changed: Mapping[str, list[str]]) -> None:
        if not changed:
            return
        pending = self._pending.setdefault(tenant_id, {})
        for room_id, client_ids in changed.items():
            pending.setdefault(room_id, set()).update(client_ids)
        if tenant_id in self._publishers:
            return
        task = asyncio.create_task(self._publish(tenant_id))
        self._publishers[tenant_id] = task
        self._tasks.add(task)
        task.add_done_callback(self._finished)

    def _finished(self, task: asyncio.Task[None]) -> None:
        self._tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            logger.error(
                "Could not tell people a room changed; their Console reads it "
                "again on its next poll",
                exc_info=task.exception(),
            )

    async def _publish(self, tenant_id: str) -> None:
        """Wait out the tenant's window, then read and tell what changed in
        it; a change made while that read runs opens the next window, after
        it, so a tenant never has two reads waiting for the pool."""
        try:
            while tenant_id in self._pending:
                await asyncio.sleep(self._window_seconds)
                changed = {
                    room_id: sorted(client_ids)
                    for room_id, client_ids in self._pending.pop(tenant_id).items()
                }
                try:
                    await self._tell(tenant_id, changed)
                except Exception:
                    logger.error(
                        "Could not tell people %d room(s) changed; their Console "
                        "reads them again on its next poll",
                        len(changed),
                        exc_info=True,
                    )
        finally:
            del self._publishers[tenant_id]

    async def _tell(self, tenant_id: str, changed: dict[str, list[str]]) -> None:
        async with tenant_session(self._session_factory, tenant_id) as session:
            concerned = await people_concerned(session, changed)
        rooms_of: dict[str, list[str]] = {}
        for room_id, user_ids in concerned.items():
            for user_id in user_ids:
                rooms_of.setdefault(user_id, []).append(room_id)
        for user_id, room_ids in rooms_of.items():
            if len(room_ids) > ROOMS_NAMED_MAX:
                self._publisher.publish(tenant_id, user_id, ROOM, None)
                continue
            for room_id in room_ids:
                self._publisher.publish(tenant_id, user_id, ROOM, room_id)


async def people_concerned(
    session: AsyncSession, changed: Mapping[str, list[str]]
) -> dict[str, list[str]]:
    """For each room in `changed`: its owner, the people in it and behind
    the client ids it maps to, and the owners of its agents. One query."""
    room_ids = list(changed)
    present: Select[tuple[str, str]] | CompoundSelect = select(
        ClientRoom.room_id, ClientRoom.client_id
    ).where(ClientRoom.room_id.in_(room_ids))
    named = [
        (room_id, client_id)
        for room_id, client_ids in changed.items()
        for client_id in client_ids
    ]
    if named:
        present = union(
            present,
            select(
                values(
                    column("room_id", String), column("client_id", String), name="named"
                ).data(named)
            ),
        )
    here = present.subquery()
    found: Result[tuple[str, str | None]] = await session.execute(
        union(
            select(Room.id, Room.owner_id).where(Room.id.in_(room_ids)),
            select(here.c.room_id, Client.user_id)
            .join(Client, Client.id == here.c.client_id)
            .where(Client.type == MEMBER_CLIENT_TYPE),
            select(here.c.room_id, ExternalUserClaim.user_id)
            .join(ExternalUser, ExternalUser.client_id == here.c.client_id)
            .join(
                ExternalUserClaim,
                ExternalUserClaim.external_user_id == ExternalUser.id,
            ),
            select(here.c.room_id, Agent.owner_id).join(
                Agent, Agent.client_id == here.c.client_id
            ),
            select(room_agents.c.room_id, Agent.owner_id)
            .join(Agent, Agent.id == room_agents.c.agent_id)
            .where(room_agents.c.room_id.in_(room_ids)),
        )
    )
    concerned: dict[str, set[str]] = {room_id: set() for room_id in room_ids}
    for room_id, user_id in found.tuples():
        if user_id is not None:
            concerned[room_id].add(user_id)
    return {room_id: sorted(users) for room_id, users in concerned.items()}
