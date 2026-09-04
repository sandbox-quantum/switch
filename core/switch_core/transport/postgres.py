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

History is the one method left unimplemented, and deliberately: the read path
already queries these rows directly, and the only callers left are the walkers
that exist to compare a bus against them.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import TYPE_CHECKING, Any

from switch_core.attachments import ATTACHMENT_GROUP_KEY
from switch_core.db.models import ClientRoom, MediaBlob, Message, MessageAttachment
from switch_core.messages.recorded_types import EPHEMERAL
from switch_core.messages.row import attachments_in, text_field, thread_root_of
from switch_core.transport.content import media_content, message_content
from switch_core.transport.port import Handler, TransportHandlers
from switch_core.transport.types import (
    DownloadResult,
    HistoryPage,
    InboundCustomEvent,
    InboundEvent,
    InboundMedia,
    InboundMembership,
    InboundMessage,
    MessageFormat,
    RoomRef,
    SendResult,
    TransportError,
    UploadResult,
)

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.db.stores.media_store import MediaStore
    from switch_core.db.stores.message_store import MessageStore
    from switch_core.db.stores.room_store import RoomStore
    from switch_core.messages.notify import MessageListener

logger = logging.getLogger(__name__)

# How many rows one wake-up reads at a time. A page rather than everything
# outstanding, so a room that moved a long way while a handler was busy is
# delivered in bounded steps instead of one unbounded read.
_DELIVERY_PAGE = 200

MEMBERSHIP_EVENT_TYPE = "m.room.member"


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
        media_store: MediaStore,
        listener: MessageListener,
    ) -> None:
        self.user_id = user_id
        self.client_id = client_id
        self.display_name = display_name
        self._session_factory = session_factory
        self._room_store = room_store
        self._message_store = message_store
        self._media_store = media_store
        self._listener = listener
        self._handlers = TransportHandlers()
        # Per-room delivery position, and the transport-side id to hand back
        # to a handler. Both are keyed by the Switch room id, which is what
        # the listener announces.
        self._cursors: dict[str, int] = {}
        self._watching: dict[str, str] = {}
        self._receiving = False
        self._closed = asyncio.Event()
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
        """Stop receiving. Sessions are borrowed per operation, so that is all
        there is to release."""
        self._closed.set()

    async def relogin(self) -> None:
        """Never called: there is no session to be rejected."""

    def register_handlers(self, handlers: TransportHandlers) -> None:
        self._handlers = handlers

    async def receive_forever(self, *, since: str | None) -> None:
        """Deliver every row written to this client's rooms from now on.

        `since` is ignored, and that is the behaviour to keep rather than an
        omission. A Matrix client resumed from its stored sync token and then
        threw away everything older than the process (`ClientBase._should_ignore`),
        so what was actually delivered on a restart was "whatever happened
        while I was up". Starting each room at its current head says the same
        thing without the cursor that lied about it. What an agent missed
        while it was away is a delivery-cursor question, and delivery cursors
        are a layer above this one.
        """
        for transport_room_id in await self.joined_rooms():
            await self._watch(transport_room_id)
        self._receiving = True
        try:
            await self._closed.wait()
        finally:
            self._receiving = False
            self._unwatch_all()

    async def _watch(self, transport_room_id: str) -> None:
        """Start delivering a room, from wherever it is right now."""
        async with self._session_factory() as session:
            room_id = await self._resolve_room(session, transport_room_id)
            if room_id in self._cursors:
                return
            self._cursors[room_id] = await self._message_store.head_seq(
                session, room_id
            )
        self._watching[room_id] = transport_room_id
        self._listener.subscribe(room_id, self._on_room_advanced)

    def _unwatch_all(self) -> None:
        for room_id in self._watching:
            self._listener.unsubscribe(room_id, self._on_room_advanced)
        self._watching.clear()
        self._cursors.clear()

    async def _on_room_advanced(self, room_id: str) -> None:
        """Read what this client has not seen in one room, and hand it over.

        Called by the listener, which promises only that the room moved. The
        cursor is this transport's own, so a coalesced announcement, a
        duplicate, or a wake-up after a reconnect all reduce to the same
        thing: read from where I was, and advance.

        The cursor advances per row rather than at the end, so a handler that
        raises does not cost the rows already delivered — the failure belongs
        to one event, and redelivering its neighbours would be worse than
        dropping it.
        """
        transport_room_id = self._watching.get(room_id)
        if transport_room_id is None:
            return
        while True:
            async with self._session_factory() as session:
                rows = await self._message_store.list_for_room(
                    session,
                    room_id,
                    after_seq=self._cursors[room_id],
                    limit=_DELIVERY_PAGE,
                )
                attachments = await self._message_store.attachments_for(
                    session, [row.id for row in rows]
                )
            if not rows:
                return
            for row in rows:
                self._cursors[room_id] = row.seq
                await self._deliver(transport_room_id, row, attachments.get(row.id, []))
            if len(rows) < _DELIVERY_PAGE:
                return

    async def _deliver(
        self,
        transport_room_id: str,
        row: Message,
        attachments: list[MessageAttachment],
    ) -> None:
        room = RoomRef(room_id=transport_room_id)
        event = to_inbound(row, attachments, transport_room_id=transport_room_id)
        handler = self._handler_for(event)
        if handler is None:
            return
        await handler(room, event)

    def _handler_for(self, event: InboundEvent) -> Handler | None:
        if isinstance(event, InboundMedia):
            return self._handlers.on_media
        if isinstance(event, InboundMembership):
            return self._handlers.on_member_event
        if isinstance(event, InboundCustomEvent):
            return self._handlers.on_custom_event
        return self._handlers.on_message

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
        """Store the bytes and return the handle the message will carry.

        The handle is a key and nothing more. Callers already treat it as
        opaque — it crosses the agent protocol as `mxc` and comes back as a
        query parameter — so what is behind it can become object storage later
        without the protocol noticing.
        """
        uri = f"switch-media://{uuid.uuid4().hex}"
        async with self._session_factory() as session:
            await self._media_store.put(
                session,
                MediaBlob(
                    uri=uri,
                    content_type=content_type,
                    filename=filename,
                    size=len(data),
                    data=data,
                ),
            )
            await session.commit()
        return UploadResult(uri=uri)

    async def download_media(self, uri: str) -> DownloadResult:
        """The bytes for a handle.

        A handle with nothing behind it raises rather than returning empty
        bytes: an attachment the sender was told had been stored and a reader
        gets back as a zero-byte file is the worst of the available answers.
        """
        async with self._session_factory() as session:
            blob = await self._media_store.get(session, uri)
        if blob is None:
            raise TransportError(f"No media stored under {uri}")
        return DownloadResult(
            body=blob.data,
            content_type=blob.content_type,
            filename=blob.filename,
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
        """Membership is a row, and so is the arrival that announces it.

        Over Matrix these were one thing: the homeserver turned a join into an
        `m.room.member` event every other member saw, and Switch recorded that
        event separately so history could explain who appeared. Here the write
        does both jobs at once, which removes the case the recorder had to
        guard against — an arrival that happened but was never written.

        Returns True for an existing membership as well as a new one: the
        caller asked to be in the room, and it is.
        """
        async with self._session_factory() as session:
            switch_room_id = await self._resolve_room(session, room_id)
            existing = await session.get(
                ClientRoom, {"client_id": self.client_id, "room_id": switch_room_id}
            )
            if existing is not None:
                return True
            await self._room_store.add_client(session, self.client_id, switch_room_id)
            arrival = Message(
                room_id=switch_room_id,
                transport_event_id=new_event_id(),
                sender_matrix_id=self.user_id,
                sender_client_id=self.client_id,
                sender_name=self.display_name,
                event_type=MEMBERSHIP_EVENT_TYPE,
                msgtype=None,
                body=None,
                formatted_body=None,
                thread_root_event_id=None,
                # No rendered sentence: how an arrival reads is the reader's to
                # phrase, and freezing today's wording into every row is not
                # something a later change can take back.
                content={"membership": "join", "displayname": self.display_name},
            )
            await self._message_store.create(session, arrival, [])
            await session.commit()
        if self._receiving:
            await self._watch(room_id)
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


def to_inbound(
    row: Message,
    attachments: list[MessageAttachment],
    *,
    transport_room_id: str,
) -> InboundEvent:
    """One stored row as the event a handler expects.

    Which of the four inbound shapes a row becomes is read off the row itself,
    the same way the Matrix transport reads it off the event class: an
    arrival, a file, a `com.switch.*` payload, or a message. The row keeps the
    whole content dict, so nothing is reconstructed here that was not sent.
    """
    content = dict(row.content)
    room_id = transport_room_id
    event_id = row.transport_event_id
    sender = row.sender_matrix_id
    timestamp = _epoch_ms(row.sent_at)

    if row.event_type == MEMBERSHIP_EVENT_TYPE:
        return InboundMembership(
            room_id=room_id,
            event_id=event_id,
            sender=sender,
            timestamp=timestamp,
            content=content,
            state_key=row.sender_matrix_id,
            membership=text_field(content.get("membership")) or "join",
            # Only an arrival is ever written, so there is no previous state
            # to read back — and a row that carries one is honoured rather
            # than second-guessed.
            prev_membership=text_field(content.get("prev_membership")),
            display_name=row.sender_name,
        )

    if row.event_type != "m.room.message":
        return InboundCustomEvent(
            room_id=room_id,
            event_id=event_id,
            sender=sender,
            timestamp=timestamp,
            content=content,
            event_type=row.event_type,
            thread_root_id=row.thread_root_event_id,
        )

    if not attachments:
        return InboundMessage(
            room_id=room_id,
            event_id=event_id,
            sender=sender,
            timestamp=timestamp,
            content=content,
            body=row.body or "",
            sender_name=row.sender_name,
            formatted_body=row.formatted_body,
            msgtype=row.msgtype or "m.text",
            thread_root_id=row.thread_root_event_id,
        )

    file = attachments[0]
    group = content.get(ATTACHMENT_GROUP_KEY)
    return InboundMedia(
        room_id=room_id,
        event_id=event_id,
        sender=sender,
        timestamp=timestamp,
        content=content,
        body=row.body or "",
        sender_name=row.sender_name,
        formatted_body=row.formatted_body,
        msgtype=row.msgtype or "m.file",
        thread_root_id=row.thread_root_event_id,
        uri=file.uri,
        filename=file.filename,
        mimetype=file.mimetype,
        size=file.size,
        group=group if isinstance(group, dict) else None,
    )


def _epoch_ms(sent_at: Any) -> int:
    return int(sent_at.timestamp() * 1000)
