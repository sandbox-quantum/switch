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
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from switch_core.attachments import ATTACHMENT_GROUP_KEY
from switch_core.db.models import ClientRoom, MediaBlob, Message, MessageAttachment
from switch_core.messages.recorded_types import EPHEMERAL
from switch_core.messages.row import attachments_in, text_field, thread_root_of
from switch_core.transport.content import media_content, message_content
from switch_core.transport.ephemeral import EphemeralBus
from switch_core.transport.invites import InviteBus
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
        invites: InviteBus,
        ephemeral: EphemeralBus,
    ) -> None:
        self.user_id = user_id
        self.client_id = client_id
        self.display_name = display_name
        self._session_factory = session_factory
        self._room_store = room_store
        self._message_store = message_store
        self._media_store = media_store
        self._listener = listener
        self._invites = invites
        self._ephemeral = ephemeral
        self._handlers = TransportHandlers()
        # Per-room delivery position, and the transport-side id to hand back
        # to a handler. Both are keyed by the Switch room id, which is what
        # the listener announces.
        self._cursors: dict[str, int] = {}
        self._watching: dict[str, str] = {}
        self._receiving = False
        self._closed = asyncio.Event()
        # Rooms this client has been told moved but has not read yet, and the
        # signal its delivery loop waits on. A set because a room that moved
        # twice while the loop was busy is still one read.
        self._pending: set[str] = set()
        self._wake = asyncio.Event()
        self._delivering = False
        # A room's transport id never changes, so this only grows and never
        # goes stale.
        self._room_ids: dict[str, str] = {}

    # ── Session ───────────────────────────────────────────────────────────────

    async def connect(self) -> None:
        """Nothing to authenticate: the caller already knows who it is."""

    async def close(self) -> None:
        """Stop receiving. Sessions are borrowed per operation, so that is all
        there is to release."""
        self._closed.set()

    def register_handlers(self, handlers: TransportHandlers) -> None:
        self._handlers = handlers

    async def receive_forever(self) -> None:
        """Deliver every row written to this client's rooms from now on.

        Each room starts at its current head, so what an agent missed while it
        was away is not delivered here. That is a delivery-cursor question,
        and delivery cursors are a layer above this one.
        """
        rooms = await self.joined_rooms()
        if not rooms:
            logger.error(
                "Client %s is receiving but is a member of no room: it will "
                "hear nothing until something adds it to one. Under Matrix "
                "membership lived on the homeserver; here it is the "
                "client_rooms table, so a client whose rows were never "
                "written is silent rather than broken",
                self.user_id,
            )
        delivery = asyncio.create_task(self._deliver_forever())
        for transport_room_id in rooms:
            await self._watch(transport_room_id)
        self._receiving = True
        self._invites.register(self.user_id, self._on_invited)
        try:
            await self._closed.wait()
        finally:
            self._receiving = False
            self._invites.unregister(self.user_id)
            self._unwatch_all()
            delivery.cancel()

    async def _deliver_forever(self) -> None:
        """This client's own delivery loop: its rooms, one at a time.

        The listener fans out to every subscriber from a single task, so
        anything a waker awaits is awaited by every other client's delivery
        too — and a waker awaits its handler, which for a bridge is an HTTP
        call to Slack that can sit in a rate limit for seconds. Doing the work
        here instead means a stalled bridge stalls itself.

        Serial within the client, deliberately. Two concurrent runs for one
        room would both read the same cursor and deliver the same rows twice,
        and a redelivered message is indistinguishable to a reader from a new
        one. Overlapping wake-ups collapse into one more pass instead, which
        also bounds this client to one outstanding read.
        """
        while True:
            await self._wake.wait()
            self._wake.clear()
            rooms = list(self._pending)
            self._pending.clear()
            self._delivering = True
            try:
                for room_id in rooms:
                    try:
                        await self._drain_room(room_id)
                    except asyncio.CancelledError:
                        raise
                    except Exception:
                        # One room's failure is not the other rooms' problem,
                        # and this loop is the only delivery this client has.
                        logger.error(
                            "Delivery failed for client %s in room %s",
                            self.user_id,
                            room_id,
                            exc_info=True,
                        )
            finally:
                self._delivering = False

    async def _on_invited(self, transport_room_id: str) -> None:
        """Someone added this client to a room while it was running.

        Handed to `on_invite` rather than joined here, because auto-accepting
        is the client's decision and it already has one — the same one it made
        when the invitation arrived over sync.
        """
        handler = self._handlers.on_invite
        if handler is None:
            return
        await handler(
            RoomRef(room_id=transport_room_id),
            InboundMembership(
                room_id=transport_room_id,
                event_id=new_event_id(),
                sender=self.user_id,
                timestamp=_now_ms(),
                state_key=self.user_id,
                membership="invite",
                display_name=self.display_name,
            ),
        )

    async def _watch(
        self, transport_room_id: str, *, from_seq: int | None = None
    ) -> None:
        """Start delivering a room, from its head or from a given position.

        `from_seq` exists so a client can hear its own arrival. Over Matrix a
        join came back down the joining client's own connection — the
        homeserver turned it into an event and delivered it to everyone,
        including the person it was about — and code downstream learned it had
        joined by being told. Writing the row and then watching from the head
        steps over the client's own footprint: the room hears the arrival and
        the arriving client does not.

        Restoring the loop-back rather than dispatching the one handler that
        noticed keeps every guard downstream in play, and covers whatever else
        depended on hearing its own join.
        """
        async with self._session_factory() as session:
            room_id = await self._resolve_room(session, transport_room_id)
            if room_id in self._cursors:
                return
            self._cursors[room_id] = (
                from_seq
                if from_seq is not None
                else await self._message_store.head_seq(session, room_id)
            )
        self._watching[room_id] = transport_room_id
        self._listener.subscribe(room_id, self._on_room_advanced)
        self._ephemeral.subscribe(transport_room_id, self._on_ephemeral)
        if from_seq is not None:
            # The announcement for anything already written went out before
            # this subscription existed, so nothing will wake the loop for it.
            self._pending.add(room_id)
            self._wake.set()

    def _unwatch_all(self) -> None:
        for room_id, transport_room_id in self._watching.items():
            self._listener.unsubscribe(room_id, self._on_room_advanced)
            self._ephemeral.unsubscribe(transport_room_id, self._on_ephemeral)
        self._watching.clear()
        self._cursors.clear()

    async def _on_ephemeral(self, event: InboundCustomEvent) -> None:
        """An unstored event in a room this client watches.

        It arrives already assembled, unlike a row: there is nothing to read
        back, which is the whole difference between announcing a position and
        announcing a value.
        """
        handler = self._handlers.on_custom_event
        if handler is None:
            return
        await handler(RoomRef(room_id=event.room_id), event)

    async def _on_room_advanced(self, room_id: str) -> None:
        """The listener's waker: note the room and return.

        It must not deliver. The listener fans out from one task, so time
        spent here is time no other client in the process is being delivered
        to.
        """
        if room_id not in self._watching:
            return
        self._pending.add(room_id)
        self._wake.set()

    async def _drain_room(self, room_id: str) -> None:
        """Read what this client has not seen in one room, and hand it over.

        Driven by this client's own loop, which promises only that the room
        moved — and never that it moved once. The
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
            # ever shown, so it is delivered live instead of written: the
            # announcement carries the value, because there is nowhere for a
            # reader to go and fetch it.
            await self._ephemeral.publish(
                transport_room_id,
                InboundCustomEvent(
                    room_id=transport_room_id,
                    event_id=result.event_id,
                    sender=self.user_id,
                    timestamp=_now_ms(),
                    content=content,
                    event_type=event_type,
                ),
            )
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

        Watching is decided separately from the row, and that split is the
        point. Membership and subscription used to be one fact — the
        homeserver's join *was* what a sync loop delivered — but a row can now
        be written by something other than this client, and a client that
        returned early on finding one would be a member of a room it never
        reads, with no later join able to repair it. So the row is written
        once and the subscription is taken whenever it is missing.
        """
        async with self._session_factory() as session:
            switch_room_id = await self._resolve_room(session, room_id)
            existing = await session.get(
                ClientRoom, {"client_id": self.client_id, "room_id": switch_room_id}
            )
            if existing is not None:
                if self._receiving:
                    await self._watch(room_id)
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
            arrival_seq = arrival.seq
        if self._receiving:
            # From just before the arrival, so this client reads its own join
            # the way every other member does.
            await self._watch(room_id, from_seq=arrival_seq - 1)
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


def _now_ms() -> int:
    return int(datetime.now(UTC).timestamp() * 1000)


def _epoch_ms(sent_at: Any) -> int:
    return int(sent_at.timestamp() * 1000)
