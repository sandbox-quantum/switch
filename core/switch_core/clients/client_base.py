from __future__ import annotations

import asyncio
import logging
import time
from typing import TYPE_CHECKING, Literal, NotRequired, TypedDict

from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.stores.client_store import ClientStore
from switch_core.events import (
    AgentRuntimeStateEvent,
    CommandEvent,
    LlmCallReport,
    SwitchEvent,
    TaskAccept,
    TaskCancel,
    TaskDelegate,
    TaskFinalise,
    TaskUpdate,
    ToolCallReport,
)
from switch_core.messages import MessageRecorder
from switch_core.transport import (
    InboundCustomEvent,
    InboundEvent,
    InboundMedia,
    InboundMembership,
    InboundMessage,
    MessageTransport,
    RoomRef,
    SendResult,
    TransportError,
    TransportHandlers,
)

if TYPE_CHECKING:
    from collections.abc import Callable

logger = logging.getLogger(__name__)

SYNC_STATE_INTERVAL = 30
SYNC_MAX_RETRIES = 5
SYNC_BACKOFF_BASE = 1.0
SYNC_BACKOFF_CAP = 60.0


class ClientConfig(BaseModel):
    pass


class ClientBaseKwargs[ConfigT: ClientConfig](TypedDict):
    """What every `ClientBase` subclass must forward to `ClientBase`.

    Subclasses take their own arguments and pass the rest through. Spelled as
    `**kwargs: Any`, that pass-through is invisible to the type checker on both
    sides: the subclass cannot be told it is missing something, and a caller
    cannot be told it is passing something that no longer exists. A stale
    `device_id=` type-checked clean that way and took all four collaboration
    bridges down at startup — the credential had moved into `session_state`
    and nothing said so until the process refused to start.

    Declaring the shape here and unpacking it restores both checks without
    making every subclass restate eleven parameters.
    """

    client_id: str
    matrix_user_id: str
    display_name: str
    password: str
    server_url: str
    session_factory: async_sessionmaker[AsyncSession]
    client_store: ClientStore
    config: ConfigT
    transport_factory: Callable[[ClientBase[ConfigT]], MessageTransport]
    session_state: dict[str, str | None]
    message_recorder: MessageRecorder
    next_batch_token: NotRequired[str | None]


class ClientBase[ConfigT: ClientConfig]:
    config_class: type[ConfigT] = ClientConfig  # type: ignore[assignment]

    def __init__(
        self,
        *,
        client_id: str,
        matrix_user_id: str,
        display_name: str,
        password: str,
        server_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        client_store: ClientStore,
        config: ConfigT,
        transport_factory: Callable[[ClientBase[ConfigT]], MessageTransport],
        session_state: dict[str, str | None],
        message_recorder: MessageRecorder,
        next_batch_token: str | None = None,
    ) -> None:
        self.client_id = client_id
        self.matrix_user_id = matrix_user_id
        self.display_name = display_name
        self.password = password
        self.server_url = server_url
        self.session_factory = session_factory
        self.client_store = client_store
        self.config = config
        self.message_recorder = message_recorder

        # Credentials the transport owns. Stored and handed back unread, so
        # what authentication needs is the transport's business alone.
        self.session_state = session_state
        self.next_batch_token = next_batch_token

        self._transport_factory = transport_factory
        self.transport: MessageTransport | None = None
        self.room_join_times: dict[str, int] = {}
        self._room_joined_events: dict[str, asyncio.Event] = {}
        # Rooms this client has already announced its arrival in. Distinct from
        # `room_join_times`, which is membership bookkeeping recorded as early as
        # possible (an explicit join, a membership lookup) so `wait_joined` and
        # the `_should_ignore` cutoff are accurate. Membership being known is not
        # evidence the arrival was announced.
        self._self_join_dispatched: set[str] = set()
        self._ready = asyncio.Event()
        self._startup_ts: int = 0
        self._last_sync_persist: float = 0.0
        self._sync_state_dirty: bool = False
        self._running: bool = False

    async def wait_ready(self) -> None:
        await self._ready.wait()

    async def set_display_name(self, display_name: str) -> None:
        """Change the name this client shows under.

        The user id is an address and stays put; this is the label rooms
        render. Used to correct a puppet filed under a platform id before the
        platform would say who the person was.
        """
        await self._transport.set_display_name(display_name)
        self.display_name = display_name

    def _joined_event(self, room_id: str) -> asyncio.Event:
        event = self._room_joined_events.get(room_id)
        if event is None:
            event = asyncio.Event()
            self._room_joined_events[room_id] = event
        return event

    def _mark_joined(self, room_id: str, joined_at_ms: int) -> None:
        self.room_join_times[room_id] = joined_at_ms
        self._joined_event(room_id).set()

    async def _is_joined_on_server(self, room_id: str) -> bool:
        return room_id in await self._transport.joined_rooms()

    async def wait_joined(self, room_id: str, timeout: float) -> bool:
        """Block until this client is a member of `room_id`, up to `timeout`
        seconds. Returns True if joined, False on timeout. Callers that need to
        *send* into a room they have only just been invited to must await this
        first — a send issued before the join lands is rejected by the
        homeserver, and any event that does land before a member's join is
        filtered out by `_should_ignore`.

        A join observed through sync sets the event, but a join that predates
        this process never replays: the client resumes from a stored
        `next_batch` token, so an incremental sync carries no member event for a
        room it joined in an earlier run, and re-inviting an existing member is
        a no-op. The homeserver is therefore asked directly before waiting."""
        event = self._joined_event(room_id)
        if event.is_set():
            return True
        if await self._is_joined_on_server(room_id):
            self._mark_joined(room_id, self._startup_ts)
            return True
        try:
            await asyncio.wait_for(event.wait(), timeout)
        except TimeoutError:
            return False
        return True

    @property
    def _transport(self) -> MessageTransport:
        if self.transport is None:
            raise RuntimeError(
                f"Client {self.matrix_user_id} is not connected — call start() first"
            )
        return self.transport

    # ── Lifecycle ──────────────────────────────────────────────────────────────

    async def start(self) -> None:
        self._startup_ts = int(time.time() * 1000)
        self._running = True

        await self._create_client()
        self.setup()

        logger.info("Client %s starting sync loop", self.matrix_user_id)
        retries = 0
        while self._running:
            try:
                await self._transport.receive_forever(since=self.next_batch_token)
                retries = 0
            except Exception:
                if not self._running:
                    break
                retries += 1
                if retries > SYNC_MAX_RETRIES:
                    logger.error(
                        "Client %s exceeded %d sync retries, giving up",
                        self.matrix_user_id,
                        SYNC_MAX_RETRIES,
                    )
                    raise
                delay = min(SYNC_BACKOFF_BASE * (2 ** (retries - 1)), SYNC_BACKOFF_CAP)
                logger.exception(
                    "Sync loop error for %s (attempt %d/%d), retrying in %.1fs",
                    self.matrix_user_id,
                    retries,
                    SYNC_MAX_RETRIES,
                    delay,
                )
                await asyncio.sleep(delay)

    async def stop(self) -> None:
        logger.info("Stopping client %s", self.matrix_user_id)
        self._running = False
        await self._persist_state(force=True)
        await self.teardown()
        if self.transport is not None:
            await self.transport.close()

    def setup(self) -> None:
        self._transport.register_handlers(
            TransportHandlers(
                on_message=self._handle_message,
                on_media=self._handle_media,
                on_reaction=self._handle_reaction,
                on_member_event=self._handle_member_event,
                on_custom_event=self._handle_custom_event,
                on_invite=self._handle_invite,
                on_sync=self._handle_sync,
                on_sync_error=self._handle_sync_error,
            )
        )

    async def teardown(self) -> None:
        pass

    # ── Authentication ─────────────────────────────────────────────────────────

    async def _create_client(self) -> None:
        before = dict(self.session_state)
        self.transport = self._transport_factory(self)
        await self.transport.connect()
        self._absorb_session_state()
        if self.session_state != before:
            await self._persist_state(force=True)

        self._ready.set()

    def _absorb_session_state(self) -> None:
        """Take back whatever the transport wants persisted, without reading it."""
        self.session_state = dict(self._transport.session_state)

    # ── Internal event handlers (filtering + dispatch to hooks) ────────────────

    async def _handle_message(self, room: RoomRef, event: InboundMessage) -> None:
        if self._should_ignore(room, event):
            return
        try:
            await self.on_message(room, event)
        except Exception:
            logger.exception(
                "Error in on_message for %s in %s", self.matrix_user_id, room.room_id
            )

    async def _handle_media(self, room: RoomRef, event: InboundMedia) -> None:
        if self._should_ignore(room, event):
            return
        try:
            await self.on_media(room, event)
        except Exception:
            logger.exception(
                "Error in on_media for %s in %s", self.matrix_user_id, room.room_id
            )

    async def _handle_reaction(self, room: RoomRef, event: InboundEvent) -> None:
        if self._should_ignore(room, event):
            return
        try:
            await self.on_reaction(room, event)
        except Exception:
            logger.exception(
                "Error in on_reaction for %s in %s", self.matrix_user_id, room.room_id
            )

    async def _handle_member_event(
        self, room: RoomRef, event: InboundMembership
    ) -> None:
        if event.state_key == self.matrix_user_id:
            if event.membership == "join":
                self._mark_joined(room.room_id, event.timestamp)
                if event.prev_membership != "join":
                    # Recorded on the arrival itself rather than under the
                    # announcement guards below: the log wants every arrival,
                    # including ones too old to be worth announcing.
                    await self.message_recorder.record_join(
                        transport_room_id=room.room_id,
                        event=event,
                        client_id=self.client_id,
                        member_name=self.display_name,
                    )
                # A membership-preserving update (display name, avatar) re-fires
                # m.room.member with membership == "join"; only a transition into
                # membership is an arrival. Joins predating this process are not
                # ours to announce, and the room is recorded so a redelivery of
                # the same join does not announce it twice.
                if (
                    event.prev_membership != "join"
                    and event.timestamp >= self._startup_ts
                    and room.room_id not in self._self_join_dispatched
                ):
                    self._self_join_dispatched.add(room.room_id)
                    try:
                        await self.on_self_join(room, event)
                    except Exception:
                        logger.exception(
                            "Error in on_self_join for %s in %s",
                            self.matrix_user_id,
                            room.room_id,
                        )
                return
            if event.membership in ("leave", "ban"):
                # Departing ends the visit: being added back is a fresh arrival.
                self._self_join_dispatched.discard(room.room_id)
        if self._should_ignore(room, event):
            return
        try:
            await self.on_member_event(room, event)
        except Exception:
            logger.exception(
                "Error in on_member_event for %s in %s",
                self.matrix_user_id,
                room.room_id,
            )

    async def _handle_invite(self, room: RoomRef, event: InboundMembership) -> None:
        try:
            await self.on_invite(room, event)
        except Exception:
            logger.exception(
                "Error in on_invite for %s in %s", self.matrix_user_id, room.room_id
            )

    _EVENT_DISPATCH: dict[str, tuple[type[SwitchEvent], str]] = {
        "com.switch.command": (CommandEvent, "on_command"),
        "com.switch.report.tool_call": (ToolCallReport, "on_tool_call_report"),
        "com.switch.report.llm_call": (LlmCallReport, "on_llm_call_report"),
        "com.switch.task.delegate": (TaskDelegate, "on_task_delegate"),
        "com.switch.task.accept": (TaskAccept, "on_task_accept"),
        "com.switch.task.update": (TaskUpdate, "on_task_update"),
        "com.switch.task.finalise": (TaskFinalise, "on_task_finalise"),
        "com.switch.task.cancel": (TaskCancel, "on_task_cancel"),
        "com.switch.agent.runtime_state": (
            AgentRuntimeStateEvent,
            "on_agent_runtime_state",
        ),
    }

    async def _handle_custom_event(
        self, room: RoomRef, event: InboundCustomEvent
    ) -> None:
        if self._should_ignore(room, event):
            return

        entry = self._EVENT_DISPATCH.get(event.event_type)
        if entry is None:
            if event.event_type.startswith("com.switch.observe."):
                logger.warning(
                    "Observe event %s not yet supported in %s",
                    event.event_type,
                    room.room_id,
                )
            else:
                logger.error(
                    "Unhandled custom event type %s in %s",
                    event.event_type,
                    room.room_id,
                )
            return

        event_class, method_name = entry
        try:
            typed_event = event_class(
                **event.content,
            )
        except Exception:
            logger.exception(
                "Failed to parse %s event in %s", event.event_type, room.room_id
            )
            return

        # Command results reply into the command's thread. When the command was
        # typed inside an existing thread the bridge relates it to that thread's
        # root (m.thread); use that root so the result stays in that thread.
        # Otherwise the command itself roots the thread — use its own event id.
        # The id is not part of the event content, so inject it here.
        if isinstance(typed_event, CommandEvent):
            typed_event.thread_id = event.thread_root_id or event.event_id

        try:
            await getattr(self, method_name)(room, typed_event)
        except Exception:
            logger.exception(
                "Error in handler for %s in %s", event.event_type, room.room_id
            )

    async def _handle_sync(self, next_batch: str) -> None:
        if next_batch and next_batch != self.next_batch_token:
            self.next_batch_token = next_batch
            await self._persist_state()

    async def _handle_sync_error(self, message: str) -> None:
        logger.error("Sync error for %s: %s", self.matrix_user_id, message)
        if self.password:
            logger.info("Attempting re-login for %s", self.matrix_user_id)
            try:
                await self._transport.relogin()
            except TransportError as exc:
                logger.error("%s", exc)
                return
            self._absorb_session_state()

    # ── Filtering ──────────────────────────────────────────────────────────────

    def _should_ignore(self, room: RoomRef, event: InboundEvent) -> bool:
        if event.sender == self.matrix_user_id:
            return True

        if event.timestamp:
            join_time = self.room_join_times.get(room.room_id, self._startup_ts)
            if event.timestamp < join_time:
                return True

        return False

    # ── Event hooks (subclasses override) ──────────────────────────────────────

    async def on_message(self, room: RoomRef, event: InboundMessage) -> None:
        pass

    async def on_media(self, room: RoomRef, event: InboundMedia) -> None:
        pass

    async def on_reaction(self, room: RoomRef, event: InboundEvent) -> None:
        pass

    async def on_self_join(self, room: RoomRef, event: InboundMembership) -> None:
        pass

    async def on_member_event(self, room: RoomRef, event: InboundMembership) -> None:
        pass

    async def on_invite(self, room: RoomRef, event: InboundMembership) -> None:
        logger.info(
            "Client %s auto-accepting invite to %s", self.matrix_user_id, room.room_id
        )
        await self.join_room(room.room_id)

    async def on_command(self, room: RoomRef, event: CommandEvent) -> None:
        pass

    async def on_tool_call_report(self, room: RoomRef, event: ToolCallReport) -> None:
        pass

    async def on_llm_call_report(self, room: RoomRef, event: LlmCallReport) -> None:
        pass

    async def on_task_delegate(self, room: RoomRef, event: TaskDelegate) -> None:
        pass

    async def on_task_accept(self, room: RoomRef, event: TaskAccept) -> None:
        pass

    async def on_task_update(self, room: RoomRef, event: TaskUpdate) -> None:
        pass

    async def on_task_finalise(self, room: RoomRef, event: TaskFinalise) -> None:
        pass

    async def on_task_cancel(self, room: RoomRef, event: TaskCancel) -> None:
        pass

    async def on_agent_runtime_state(
        self, room: RoomRef, event: AgentRuntimeStateEvent
    ) -> None:
        pass

    # ── Message sending ────────────────────────────────────────────────────────

    async def send_message(
        self,
        room_id: str,
        body: str,
        *,
        format: Literal["text", "markdown"] = "text",
        mentions: list[str] | None = None,
        thread_root_id: str | None = None,
        extra_content: dict[str, object] | None = None,
    ) -> str | None:
        try:
            result = await self._transport.send_message(
                room_id,
                body,
                sender_name=self.display_name,
                format=format,
                mentions=mentions,
                thread_root_id=thread_root_id,
                extra_content=extra_content,
            )
        except TransportError as exc:
            logger.error("Failed to send message to %s: %s", room_id, exc)
            return None
        await self._record(room_id, result)
        return result.event_id

    async def send_event(
        self, room_id: str, event_type: str, content: dict[str, object]
    ) -> str:
        """Send a custom event, e.g. one of the `com.switch.*` types.

        Raises rather than returning None: unlike a chat message, these events
        carry protocol state, and a caller that proceeds as though one was
        delivered when it was not corrupts whatever it was coordinating.
        """
        result = await self._transport.send_event(room_id, event_type, content)
        await self._record(room_id, result)
        return result.event_id

    async def upload_media(self, data: bytes, content_type: str, filename: str) -> str:
        """Upload bytes to the media store and return the URI referencing them.

        Raises on failure — a media upload that silently returns None would
        produce a broken event referencing nothing.
        """
        result = await self._transport.upload_media(data, content_type, filename)
        return result.uri

    async def send_media(
        self,
        room_id: str,
        mxc: str,
        filename: str,
        mimetype: str,
        size: int,
        *,
        msgtype: str,
        caption: str | None = None,
        thread_root_id: str | None = None,
        group: dict[str, object] | None = None,
    ) -> str | None:
        """Send an m.image / m.file event pointing at an uploaded mxc URI.

        When `caption` is provided it becomes the event `body` (with the real
        filename carried separately in `filename`, per the rich-media-caption
        convention); otherwise `body` is the filename. When `thread_root_id` is
        set the event is related into that thread (mirrors send_message).

        `group` marks this event as one part of a multi-attachment message —
        `{"id": ..., "index": i, "total": n}`. Matrix has no native
        multi-attachment event (MSC4274 / MSC2881 are unmerged), so a message
        carrying several files is sent as n events sharing a group id, which
        receivers coalesce back into one logical message. Absent the field, an
        event is simply a group of one.
        """
        try:
            result = await self._transport.send_media(
                room_id,
                mxc,
                filename,
                mimetype,
                size,
                sender_name=self.display_name,
                msgtype=msgtype,
                caption=caption,
                thread_root_id=thread_root_id,
                group=group,
            )
        except TransportError as exc:
            logger.error("Failed to send media to %s: %s", room_id, exc)
            return None
        await self._record(room_id, result)
        return result.event_id

    async def _record(self, room_id: str, result: SendResult) -> None:
        await self.message_recorder.record(
            transport_room_id=room_id,
            result=result,
            sender_matrix_id=self.matrix_user_id,
            sender_client_id=self.client_id,
            sender_name=self.display_name,
        )

    async def set_typing(self, room_id: str, is_typing: bool) -> None:
        await self._transport.set_typing(room_id, is_typing)

    # ── Room operations ────────────────────────────────────────────────────────

    async def join_room(self, room_id: str) -> None:
        if await self._transport.join_room(room_id):
            self._mark_joined(room_id, int(time.time() * 1000))
            logger.info("Client %s joined %s", self.matrix_user_id, room_id)

    # ── State persistence ──────────────────────────────────────────────────────

    async def _persist_state(self, force: bool = False) -> None:
        now = time.monotonic()
        if not force and (now - self._last_sync_persist) < SYNC_STATE_INTERVAL:
            self._sync_state_dirty = True
            return

        try:
            async with self.session_factory() as session:
                await self.client_store.update_state(
                    session,
                    self.client_id,
                    next_batch_token=self.next_batch_token,
                    **self.session_state,
                )
                await session.commit()
            self._last_sync_persist = now
            self._sync_state_dirty = False
        except Exception:
            logger.exception("Failed to persist state for %s", self.matrix_user_id)
