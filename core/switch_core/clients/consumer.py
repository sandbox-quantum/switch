"""Who reads a room: the delivery loop and the hooks it calls.

A consumer is built around an `Actor`. It reads the rooms that actor belongs
to from where its progress starts each room, filters out the actor's own
messages, and hands the rest to the hooks a subclass overrides. When a hook
needs to answer, it writes through the actor.

Where reading starts is the cursor, not a clock: a consumer that resumes from
its stored cursors is handed what its client has not handled yet however old
it is, and one that reads from each room's head is handed nothing from before
it started. Neither is handed anything from before its client joined a room.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Any

from switch_core.events import (
    AgentRuntimeStateEvent,
    CommandEvent,
    LlmCallReport,
    SwitchEvent,
    ToolCallReport,
)
from switch_core.transport import (
    InboundCustomEvent,
    InboundEvent,
    InboundMedia,
    InboundMembership,
    InboundMessage,
    MessageTransport,
    RoomRef,
    TransportHandlers,
)

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.clients.actor import Actor
    from switch_core.db.stores.client_store import ClientStore
    from switch_core.transport.cursors import DeliveryProgress

logger = logging.getLogger(__name__)

SYNC_MAX_RETRIES = 5
SYNC_BACKOFF_BASE = 1.0
SYNC_BACKOFF_CAP = 60.0


class Consumer[ActorT: Actor[Any]]:
    # The types of row this consumer acts on, or None for every row. One that
    # names them is woken only for those and reads past the rest
    # (`MessageTransport.receive_forever`).
    ROW_TYPES: frozenset[str] | None = None

    def __init__(self, *, actor: ActorT) -> None:
        self.actor = actor
        # Rooms this consumer has already announced its actor's arrival in.
        # Distinct from the actor's `room_join_times`, which is membership
        # bookkeeping recorded as early as possible (an explicit join, a
        # membership lookup) so `wait_joined` is accurate. Membership being
        # known is not evidence the arrival was announced.
        self._self_join_dispatched: set[str] = set()
        self._running: bool = False

    # The identity a consumer reads for is its actor's. Read-only views, so
    # the hooks below can say whose room this is without reaching through.

    @property
    def client_id(self) -> str:
        return self.actor.client_id

    @property
    def tenant_id(self) -> str:
        return self.actor.tenant_id

    @property
    def transport_user_id(self) -> str:
        return self.actor.transport_user_id

    @property
    def display_name(self) -> str:
        return self.actor.display_name

    @property
    def session_factory(self) -> async_sessionmaker[AsyncSession]:
        return self.actor.session_factory

    @property
    def client_store(self) -> ClientStore:
        return self.actor.client_store

    @property
    def transport(self) -> MessageTransport | None:
        return self.actor.transport

    @property
    def running(self) -> bool:
        """Whether this consumer is reading: started and not told to stop."""
        return self._running

    @property
    def _transport(self) -> MessageTransport:
        return self.actor._transport

    async def wait_ready(self) -> None:
        await self.actor.wait_ready()

    # ── Lifecycle ──────────────────────────────────────────────────────────────

    async def start(self, progress: DeliveryProgress) -> None:
        """Read the actor's rooms until stopped, starting each room where
        `progress` says and recording through it how far it got."""
        self._running = True

        await self.actor.connect()
        self.setup()

        logger.info("Consumer %s starting delivery loop", self.transport_user_id)
        retries = 0
        while self._running:
            try:
                await self._transport.receive_forever(
                    progress, row_types=self.ROW_TYPES
                )
                retries = 0
            except Exception:
                if not self._running:
                    break
                retries += 1
                if retries > SYNC_MAX_RETRIES:
                    logger.error(
                        "Consumer %s exceeded %d delivery retries, giving up",
                        self.transport_user_id,
                        SYNC_MAX_RETRIES,
                    )
                    raise
                delay = min(SYNC_BACKOFF_BASE * (2 ** (retries - 1)), SYNC_BACKOFF_CAP)
                logger.exception(
                    "Delivery loop error for %s (attempt %d/%d), retrying in %.1fs",
                    self.transport_user_id,
                    retries,
                    SYNC_MAX_RETRIES,
                    delay,
                )
                await asyncio.sleep(delay)

    async def stop(self) -> None:
        logger.info("Stopping consumer %s", self.transport_user_id)
        self._running = False
        await self.teardown()
        await self.actor.close()

    def setup(self) -> None:
        self._transport.register_handlers(
            TransportHandlers(
                on_message=self._handle_message,
                on_media=self._handle_media,
                on_reaction=self._handle_reaction,
                on_member_event=self._handle_member_event,
                on_custom_event=self._handle_custom_event,
                on_invite=self._handle_invite,
                on_removed=self._handle_removed,
                held_from=self.held_from,
            )
        )

    async def teardown(self) -> None:
        pass

    def held_from(self, room_id: str) -> int | None:
        """The lowest position in the room this consumer was handed and has
        not acted on yet, or None. Progress is recorded only up to before it,
        so whoever reads for the client next handles it. Nothing by default:
        a consumer acts on each row as it is handed."""
        return None

    # ── Internal event handlers (filtering + dispatch to hooks) ────────────────

    async def _handle_message(self, room: RoomRef, event: InboundMessage) -> None:
        if self._should_ignore(room, event):
            return
        try:
            await self.on_message(room, event)
        except Exception:
            logger.exception(
                "Error in on_message for %s in %s", self.transport_user_id, room.room_id
            )

    async def _handle_media(self, room: RoomRef, event: InboundMedia) -> None:
        if self._should_ignore(room, event):
            return
        try:
            await self.on_media(room, event)
        except Exception:
            logger.exception(
                "Error in on_media for %s in %s", self.transport_user_id, room.room_id
            )

    async def _handle_reaction(self, room: RoomRef, event: InboundEvent) -> None:
        if self._should_ignore(room, event):
            return
        try:
            await self.on_reaction(room, event)
        except Exception:
            logger.exception(
                "Error in on_reaction for %s in %s",
                self.transport_user_id,
                room.room_id,
            )

    async def _handle_member_event(
        self, room: RoomRef, event: InboundMembership
    ) -> None:
        if event.state_key == self.transport_user_id:
            if event.membership == "join":
                self.actor.mark_joined(room.room_id, event.timestamp)
                # A membership-preserving update (display name, avatar) re-fires
                # m.room.member with membership == "join"; only a transition into
                # membership is an arrival. A join is handed over only while the
                # client has not handled it, however long ago it was, and the
                # room is recorded so a redelivery of the same join does not
                # announce it twice.
                if (
                    event.prev_membership != "join"
                    and room.room_id not in self._self_join_dispatched
                ):
                    self._self_join_dispatched.add(room.room_id)
                    try:
                        await self.on_self_join(room, event)
                    except Exception:
                        logger.exception(
                            "Error in on_self_join for %s in %s",
                            self.transport_user_id,
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
                self.transport_user_id,
                room.room_id,
            )

    async def _handle_invite(self, room: RoomRef, event: InboundMembership) -> None:
        try:
            await self.on_invite(room, event)
        except Exception:
            logger.exception(
                "Error in on_invite for %s in %s", self.transport_user_id, room.room_id
            )

    async def _handle_removed(self, room: RoomRef, event: InboundMembership) -> None:
        # Departing ends the visit, the same way a leave delivered as a member
        # event does: being added back is a fresh arrival.
        self._self_join_dispatched.discard(room.room_id)
        try:
            await self.on_removed(room, event)
        except Exception:
            logger.exception(
                "Error in on_removed for %s in %s", self.transport_user_id, room.room_id
            )

    _EVENT_DISPATCH: dict[str, tuple[type[SwitchEvent], str]] = {
        "com.switch.command": (CommandEvent, "on_command"),
        "com.switch.report.tool_call": (ToolCallReport, "on_tool_call_report"),
        "com.switch.report.llm_call": (LlmCallReport, "on_llm_call_report"),
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
        # root; use that root so the result stays in that thread. Otherwise the
        # command itself roots the thread — use its own event id. The command
        # message keeps its own id as well, so two commands in one thread are
        # distinct. Neither id is part of the event content, so inject them here.
        if isinstance(typed_event, CommandEvent):
            typed_event.message_id = event.event_id
            typed_event.thread_id = event.thread_root_id or event.event_id
        typed_event.room_seq = event.seq
        typed_event.source_event_id = event.event_id

        try:
            await getattr(self, method_name)(room, typed_event)
        except Exception:
            logger.exception(
                "Error in handler for %s in %s", event.event_type, room.room_id
            )

    # ── Filtering ──────────────────────────────────────────────────────────────

    def _should_ignore(self, room: RoomRef, event: InboundEvent) -> bool:
        """The actor's own rows. Rows from before it joined are never handed
        over at all: its reading in a room starts at its arrival."""
        return event.sender == self.transport_user_id

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
            "Consumer %s auto-accepting invite to %s",
            self.transport_user_id,
            room.room_id,
        )
        await self.actor.join_room(room.room_id, event.timestamp)

    async def on_removed(self, room: RoomRef, event: InboundMembership) -> None:
        """This consumer's actor has been taken out of a room while it was
        running.

        Nothing to do for a consumer that holds no events of its own — the
        transport has already stopped reading the room. A consumer that hands
        events to something with a memory overrides this and empties it.
        """

    async def on_command(self, room: RoomRef, event: CommandEvent) -> None:
        pass

    async def on_tool_call_report(self, room: RoomRef, event: ToolCallReport) -> None:
        pass

    async def on_llm_call_report(self, room: RoomRef, event: LlmCallReport) -> None:
        pass

    async def on_agent_runtime_state(
        self, room: RoomRef, event: AgentRuntimeStateEvent
    ) -> None:
        pass
