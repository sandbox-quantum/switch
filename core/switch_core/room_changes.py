"""Telling people a room of theirs changed, so their Console reads its room
list again (`switch_core.user_changes`, kind `room`).

Whoever a room concerns is told: its owner, the people in it (through their
Switch Console member client or a platform account they claimed) and the
owners of its agents. A room is reported when it is created or archived or
unarchived, when its agents change, and when anyone joins or leaves it; the
client that left is named so the person who lost the room is told too.

The notice is a "read again", so it is sent from a task of its own after the
change has committed, and a lost one costs only a delay: Console still reads
its lists every few minutes. Changes to one room within `COALESCE_SECONDS` of
the first are sent as one notice per person, so a bridge adding a channel's N
members makes one read and N notices, not N reads and N² notices. The read
starts after the window closes, so it sees every change made in it; a change
after that opens a window of its own.
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
        # Client ids gathered for each room whose window is open.
        self._pending: dict[tuple[str, str], set[str]] = {}

    def room_changed(self, tenant_id: str, room_id: str, client_ids: list[str]) -> None:
        """Tell everyone the room concerns, and the people behind `client_ids`
        (who may just have left it), that it changed. Returns at once."""
        key = (tenant_id, room_id)
        if key in self._pending:
            self._pending[key].update(client_ids)
            return
        self._pending[key] = set(client_ids)
        self._start(tenant_id, [room_id])

    def rooms_changed(self, tenant_id: str, room_ids: list[str]) -> None:
        """`room_changed` for many rooms at once (an agent in each was
        renamed), read in one session and one query however many there are.
        A room whose window is open already is told with that window."""
        opened = []
        for room_id in dict.fromkeys(room_ids):
            key = (tenant_id, room_id)
            if key not in self._pending:
                self._pending[key] = set()
                opened.append(room_id)
        if opened:
            self._start(tenant_id, opened)

    def _start(self, tenant_id: str, room_ids: list[str]) -> None:
        task = asyncio.create_task(self._publish(tenant_id, room_ids))
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

    async def _publish(self, tenant_id: str, room_ids: list[str]) -> None:
        try:
            await asyncio.sleep(self._window_seconds)
        finally:
            changed = {
                room_id: sorted(self._pending.pop((tenant_id, room_id)))
                for room_id in room_ids
            }
        async with tenant_session(self._session_factory, tenant_id) as session:
            concerned = await people_concerned(session, changed)
        for room_id, user_ids in concerned.items():
            for user_id in user_ids:
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
