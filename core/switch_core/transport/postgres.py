"""Postgres implementation of `MessageTransport`.

The homeserver's remaining job is to carry an event from the client that sent
it to the clients that should see it, and to remember it in between. A table
does all three, and Switch already writes that table: every send is recorded
into `messages` today, beside the send, so the rows exist and have been
verified against the bus.

This turns that parallel record into the thing itself. **The write is the
send.** There is no second store to agree with, which is why the reconciler
this stack built has no work left once the flip happens — it exists to compare
two records of the same event, and there is only one.

Three consequences worth stating up front:

- **A send now fails when the database does.** The recorder deliberately could
  not fail a send, because a row was a nice-to-have next to a delivered
  message. Here the row *is* the delivery, so there is nothing left to protect:
  a write that fails is a message that was not sent, and the caller must hear
  about it.
- **Every durable event gets a row, not only the conversation.** The bus
  carried commands and task events too, and they have to reach their handlers.
  `recorded_types` therefore stops meaning "what is written" and starts meaning
  "what a reader is shown" — a projection applied on the way out. The one
  category with no row is the genuinely ephemeral: presence-like state whose
  next value replaces it, which is announced and never stored.
- **Ids are opaque, and these are not `$event` ids.** Nothing in Switch parses
  one; the columns holding them are already named `transport_event_id`.

What is *not* here yet: receiving, and media. Both are the next slice, and both
raise rather than returning something empty — a transport that silently
delivers nothing is the failure mode this codebase least wants to ship.
"""

from __future__ import annotations

import logging
import uuid
from typing import TYPE_CHECKING, Any

from switch_core.db.models import ClientRoom, Message
from switch_core.messages.recorded_types import EPHEMERAL
from switch_core.messages.row import attachments_in, text_field, thread_root_of
from switch_core.transport.content import media_content, message_content
from switch_core.transport.port import TransportHandlers
from switch_core.transport.types import (
    DownloadResult,
    HistoryPage,
    MessageFormat,
    SendResult,
    TransportError,
    UploadResult,
)

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.db.stores.message_store import MessageStore
    from switch_core.db.stores.room_store import RoomStore

logger = logging.getLogger(__name__)


def new_event_id() -> str:
    """A fresh event id.

    Prefixed so that a row's origin is readable at a glance during the window
    where a room holds both these and ids minted by the old bus. The prefix is
    decoration for humans — no code may branch on it.
    """
    return f"sw_{uuid.uuid4().hex}"


class PostgresTransport:
    """Carries a room's events in the `messages` table.

    One instance per client, as with the Matrix transport: it sends as that
    client and, once receiving lands, delivers to that client's handlers.
    """

    def __init__(
        self,
        *,
        user_id: str,
        client_id: str,
        display_name: str,
        session_factory: async_sessionmaker[AsyncSession],
        room_store: RoomStore,
        message_store: MessageStore,
    ) -> None:
        self.user_id = user_id
        self.client_id = client_id
        self.display_name = display_name
        self._session_factory = session_factory
        self._room_store = room_store
        self._message_store = message_store
        self._handlers = TransportHandlers()
        # A room's transport id never changes, so this only grows and never
        # goes stale.
        self._room_ids: dict[str, str] = {}

    # ── Session ───────────────────────────────────────────────────────────────

    @property
    def session_state(self) -> dict[str, str | None]:
        """Nothing to resume.

        The Matrix transport persisted an access token and a device id because
        logging in again cost a round trip and a new device. Here the client's
        identity is a row it already owns, so there is no credential to carry
        across a restart. The empty dict is the honest answer, and callers
        store it unread.
        """
        return {}

    async def connect(self) -> None:
        """Nothing to authenticate: the caller already knows who it is."""

    async def close(self) -> None:
        """Nothing held open. Sessions are borrowed per operation."""

    async def relogin(self) -> None:
        """Never called: there is no session to be rejected."""

    def register_handlers(self, handlers: TransportHandlers) -> None:
        self._handlers = handlers

    async def receive_forever(self, *, since: str | None) -> None:
        raise NotImplementedError(
            "PostgresTransport cannot receive yet; delivery from the message "
            "listener is the next step. Nothing should be running this "
            "transport as a client's only source of events."
        )

    # ── Outbound ──────────────────────────────────────────────────────────────

    async def send_message(
        self,
        room_id: str,
        body: str,
        *,
        sender_name: str,
        format: MessageFormat = "text",
        mentions: list[str] | None = None,
        thread_root_id: str | None = None,
        extra_content: dict[str, object] | None = None,
    ) -> SendResult:
        content = message_content(
            body,
            sender_name=sender_name,
            format=format,
            mentions=mentions,
            thread_root_id=thread_root_id,
            extra_content=extra_content,
        )
        return await self._send(room_id, "m.room.message", content, sender_name)

    async def send_event(
        self,
        room_id: str,
        event_type: str,
        content: dict[str, object],
    ) -> SendResult:
        return await self._send(room_id, event_type, content, self.display_name)

    async def send_media(
        self,
        room_id: str,
        uri: str,
        filename: str,
        mimetype: str,
        size: int,
        *,
        sender_name: str,
        msgtype: str,
        caption: str | None = None,
        thread_root_id: str | None = None,
        group: dict[str, object] | None = None,
    ) -> SendResult:
        content = media_content(
            uri,
            filename,
            mimetype,
            size,
            sender_name=sender_name,
            msgtype=msgtype,
            caption=caption,
            thread_root_id=thread_root_id,
            group=group,
        )
        return await self._send(room_id, "m.room.message", content, sender_name)

    async def _send(
        self,
        transport_room_id: str,
        event_type: str,
        content: dict[str, object],
        sender_name: str,
    ) -> SendResult:
        """Write the event, which is what sending it means here.

        The commit is the acceptance: the trigger on `messages` announces the
        row as part of it, so no subscriber can be woken for a row that a later
        rollback removes.
        """
        result = SendResult(
            event_id=new_event_id(), event_type=event_type, content=content
        )
        if event_type in EPHEMERAL:
            # Presence-like state, replaced by its own next value. Storing it
            # would put a row in the room's order for something no reader is
            # ever shown, and delivery of it is a live concern rather than a
            # durable one.
            return result

        async with self._session_factory() as session:
            room_id = await self._resolve_room(session, transport_room_id)
            message = Message(
                room_id=room_id,
                transport_event_id=result.event_id,
                sender_matrix_id=self.user_id,
                sender_client_id=self.client_id,
                sender_name=sender_name,
                event_type=event_type,
                msgtype=text_field(content.get("msgtype")),
                body=text_field(content.get("body")),
                formatted_body=text_field(content.get("formatted_body")),
                thread_root_event_id=thread_root_of(content),
                content=content,
            )
            await self._message_store.create(session, message, attachments_in(content))
            await session.commit()
        return result

    async def set_typing(self, room_id: str, is_typing: bool) -> None:
        """Not carried. Composing state is presence, and nothing consumes it."""

    async def upload_media(
        self, data: bytes, content_type: str, filename: str
    ) -> UploadResult:
        raise NotImplementedError(
            "PostgresTransport has no media store yet; uploads still go "
            "through the Matrix transport."
        )

    async def download_media(self, uri: str) -> DownloadResult:
        raise NotImplementedError(
            "PostgresTransport has no media store yet; downloads still go "
            "through the Matrix transport."
        )

    # ── History ───────────────────────────────────────────────────────────────

    async def get_event(self, room_id: str, event_id: str) -> Any | None:
        """One event by id, or None.

        Scoped to the room, so an id from elsewhere cannot be read through it —
        the caller is resolving a thread root supplied by an agent.
        """
        async with self._session_factory() as session:
            switch_room_id = await self._resolve_room(session, room_id)
            rows = await self._message_store.list_by_transport_event_ids(
                session, switch_room_id, [event_id]
            )
        return rows[0] if rows else None

    async def read_history(
        self, room_id: str, *, start: str | None, limit: int
    ) -> HistoryPage:
        raise NotImplementedError(
            "PostgresTransport does not serve history: the read path already "
            "queries `messages` directly, and the history walkers that use "
            "this method exist to compare the bus against those same rows."
        )

    # ── Rooms ─────────────────────────────────────────────────────────────────

    async def join_room(self, room_id: str) -> bool:
        """Membership is a row, so joining is writing it.

        Returns True for an existing membership as well as a new one: the
        caller asked to be in the room and it is.
        """
        async with self._session_factory() as session:
            switch_room_id = await self._resolve_room(session, room_id)
            existing = await session.get(
                ClientRoom, {"client_id": self.client_id, "room_id": switch_room_id}
            )
            if existing is None:
                await self._room_store.add_client(
                    session, self.client_id, switch_room_id
                )
                await session.commit()
        return True

    async def joined_rooms(self) -> list[str]:
        """The transport-side ids of this client's rooms."""
        async with self._session_factory() as session:
            rooms = await self._room_store.get_for_client(session, self.client_id)
        return [room.matrix_room_id for room in rooms if room.matrix_room_id]

    async def set_display_name(self, display_name: str) -> None:
        """Held on the client row, which is where every reader already looks."""
        self.display_name = display_name

    # ── Internals ─────────────────────────────────────────────────────────────

    async def _resolve_room(self, session: AsyncSession, transport_room_id: str) -> str:
        cached = self._room_ids.get(transport_room_id)
        if cached is not None:
            return cached
        room = await self._room_store.get_by_matrix_room_id(session, transport_room_id)
        if room is None:
            raise TransportError(f"{transport_room_id} is not a Switch room")
        self._room_ids[transport_room_id] = room.id
        return room.id
