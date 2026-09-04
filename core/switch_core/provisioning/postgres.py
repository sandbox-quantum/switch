"""Provisioning without a homeserver: every operation is a row.

What the Matrix implementation did over HTTP, this does against the same
database Switch already keeps the answer in. Two of the six turn out to be
almost nothing, and that is the finding rather than a shortcut:

- **An account is the `clients` row.** `register_user` created a homeserver
  account so that a row Switch was about to write would have something to
  authenticate as. There is no second system to register with now, so there is
  nothing to do — the caller writes the row immediately afterwards, and that
  row is the account.
- **A password is a Switch password.** `verify_login` asked the homeserver
  whether a password worked; it asks the `clients` table instead. Its one
  caller is a cutover check for a target server that already has accounts,
  which no longer has a homeserver to be true of.

The other four are writes:

- **A room** gets an id minted here and stored by the caller, exactly as the
  homeserver's `room_id` was.
- **Membership** is a `client_rooms` row plus the arrival that explains it.
  Over Matrix an invitation was a durable event a client picked up whenever it
  next synced; here a live client is woken through the invite bus and joins
  itself, which is what keeps its transport watching the room. When nobody is
  live the membership is written directly, because a client that is not
  running has nothing to wake and will find the room when it starts.
- **Removal** deletes the membership. No leave event is written: a departure
  is not something a reader of the room needs explained, and the timeline the
  log serves is what was said.
- **Discarding a room** is left to the caller's own delete, which cascades.
  Nothing here has a second copy to clean up.
"""

from __future__ import annotations

import logging
import uuid
from typing import TYPE_CHECKING

from switch_core.db.models import ClientRoom, Message

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.db.stores.client_store import ClientStore
    from switch_core.db.stores.message_store import MessageStore
    from switch_core.db.stores.room_store import RoomStore
    from switch_core.transport.invites import InviteBus

logger = logging.getLogger(__name__)

MEMBERSHIP_EVENT_TYPE = "m.room.member"


class ProvisioningError(RuntimeError):
    """A provisioning operation could not be carried out."""


def new_room_id() -> str:
    """A room's transport-side id.

    Stored in the column that held the homeserver's, and opaque in the same
    way: the prefix is for a human reading a row during the window where both
    kinds exist, and no code may branch on it.
    """
    return f"sw_room_{uuid.uuid4().hex}"


class PostgresProvisioning:
    """Accounts, rooms and membership as rows in Switch's own database."""

    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        room_store: RoomStore,
        client_store: ClientStore,
        message_store: MessageStore,
        invites: InviteBus,
    ) -> None:
        self._session_factory = session_factory
        self._room_store = room_store
        self._client_store = client_store
        self._message_store = message_store
        self._invites = invites

    async def register_user(
        self,
        user_id: str,
        password: str,
        display_name: str | None = None,
        is_admin: bool = False,
    ) -> None:
        """Nothing to register: the caller's `clients` row is the account."""

    async def verify_login(self, user_id: str, password: str) -> bool:
        async with self._session_factory() as session:
            client = await self._client_store.get_by_matrix_user_id(session, user_id)
        return client is not None and client.password == password

    async def create_room(self, name: str, topic: str) -> str:
        """Mint the id the caller will store on its own room row.

        No row is written here. The room is the caller's to create, and
        writing a second record of it would be a second thing to keep in step.
        """
        return new_room_id()

    async def invite_to_room(self, room_id: str, user_id: str) -> None:
        """Put a user in a room, waking them if they are running.

        A live client joins itself, which is what leaves its transport
        watching the room. Already a member is success, per the port.
        """
        async with self._session_factory() as session:
            switch_room_id, client_id, display_name = await self._resolve(
                session, room_id, user_id
            )
            existing = await session.get(
                ClientRoom, {"client_id": client_id, "room_id": switch_room_id}
            )
            if existing is not None:
                return

        if await self._invites.invite(user_id, room_id):
            return

        async with self._session_factory() as session:
            await self._room_store.add_client(session, client_id, switch_room_id)
            arrival = Message(
                room_id=switch_room_id,
                transport_event_id=f"sw_{uuid.uuid4().hex}",
                sender_matrix_id=user_id,
                sender_client_id=client_id,
                sender_name=display_name,
                event_type=MEMBERSHIP_EVENT_TYPE,
                msgtype=None,
                body=None,
                formatted_body=None,
                thread_root_event_id=None,
                content={"membership": "join", "displayname": display_name},
            )
            await self._message_store.create(session, arrival, [])
            await session.commit()

    async def kick_user(self, room_id: str, user_id: str) -> None:
        """Remove a membership. Already out is success, per the port."""
        async with self._session_factory() as session:
            switch_room_id, client_id, _ = await self._resolve(
                session, room_id, user_id
            )
            await self._room_store.remove_client(session, client_id, switch_room_id)
            await session.commit()

    async def delete_room(self, room_id: str) -> None:
        """Nothing of its own to discard.

        The caller deletes the room, and its messages and memberships go with
        it. The Matrix implementation had a second copy of the room to abandon;
        this has none.
        """

    async def close(self) -> None:
        """Nothing held open."""

    async def _resolve(
        self, session: AsyncSession, transport_room_id: str, user_id: str
    ) -> tuple[str, str, str]:
        room = await self._room_store.get_by_matrix_room_id(session, transport_room_id)
        if room is None:
            raise ProvisioningError(f"{transport_room_id} is not a Switch room")
        client = await self._client_store.get_by_matrix_user_id(session, user_id)
        if client is None:
            raise ProvisioningError(f"{user_id} is not a Switch client")
        return room.id, client.id, client.display_name
