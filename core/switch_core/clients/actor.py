"""Who a message is from: a room member's identity, and what it can write.

An actor is one row in `clients` seen from the running process: an id, a name,
the rooms it belongs to, and a transport to write through. It reads nothing.
Reading is a `Consumer`'s job, and a consumer is built around the actor whose
rooms it reads, so members that only ever write (a Slack person's
`HumanActor`) run no read loop at all.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import TYPE_CHECKING, ClassVar, Literal, TypedDict, Unpack

from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.clients.admin_messages import (
    PLATFORM_MARKER,
    AdminMessageType,
    OnBehalfOf,
    admin_extra_content,
)
from switch_core.db.stores.client_store import ClientStore
from switch_core.transport import MessageTransport, TransportError

if TYPE_CHECKING:
    from collections.abc import Callable

    from switch_core.db.models import Agent

logger = logging.getLogger(__name__)

# How often `wait_joined` re-reads membership while it waits. An actor with a
# consumer hears its own join as it happens; one without has only this.
MEMBERSHIP_POLL_SECONDS = 0.25


class ClientConfig(BaseModel):
    pass


class ActorKwargs[ConfigT: ClientConfig](TypedDict):
    """What every `Actor` subclass must forward to `Actor`.

    Subclasses take their own arguments and pass the rest through. Spelled as
    `**kwargs: Any`, that pass-through is invisible to the type checker on both
    sides: the subclass cannot be told it is missing something, and a caller
    cannot be told it is passing something that no longer exists. A stale
    `device_id=` type-checked clean that way and took all four collaboration
    bridges down at startup — the credential had moved elsewhere and nothing
    said so until the process refused to start.
    """

    client_id: str
    tenant_id: str
    transport_user_id: str
    display_name: str
    session_factory: async_sessionmaker[AsyncSession]
    client_store: ClientStore
    config: ConfigT
    transport_factory: Callable[[Actor[ConfigT]], MessageTransport]


# Who an actor is, as message metrics report it: the writer of a sent message
# and the reader of a delivered one. A plain `Actor` is a collaboration bridge's
# own member, the identity its `WorkspaceConsumer` reads for.
type ActorRole = Literal["human", "agent", "system", "bridge"]


class Actor[ConfigT: ClientConfig]:
    config_class: type[ConfigT] = ClientConfig  # type: ignore[assignment]
    role: ClassVar[ActorRole] = "bridge"

    def __init__(
        self,
        *,
        client_id: str,
        tenant_id: str,
        transport_user_id: str,
        display_name: str,
        session_factory: async_sessionmaker[AsyncSession],
        client_store: ClientStore,
        config: ConfigT,
        transport_factory: Callable[[Actor[ConfigT]], MessageTransport],
    ) -> None:
        self.client_id = client_id
        # The tenant of this actor's own row, carried rather than looked up.
        # An actor's task binds nothing on purpose and a consumer's handlers
        # bind some *room's* tenant, so neither context answers "which tenant
        # is this actor" — but every caller that builds one is holding the row
        # that says, so the answer travels with it instead of being asked of
        # the database again on the far side. Required, not defaulted: an
        # actor that does not know its tenant cannot write a scoped row.
        self.tenant_id = tenant_id
        self.transport_user_id = transport_user_id
        self.display_name = display_name
        self.session_factory = session_factory
        self.client_store = client_store
        self.config = config

        self._transport_factory = transport_factory
        self.transport: MessageTransport | None = None
        self.room_join_times: dict[str, int] = {}
        self._room_joined_events: dict[str, asyncio.Event] = {}
        self._ready = asyncio.Event()
        self._connected_at: int = 0

    async def connect(self) -> None:
        """Open the transport. Idempotent: a consumer connects the actor it
        reads for, and the lifecycle connects an actor that has none."""
        if self.transport is not None:
            return
        self._connected_at = int(time.time() * 1000)
        self.transport = self._transport_factory(self)
        await self.transport.connect()
        self._ready.set()

    async def close(self) -> None:
        if self.transport is not None:
            await self.transport.close()

    async def wait_ready(self) -> None:
        await self._ready.wait()

    async def set_display_name(self, display_name: str) -> None:
        """Change the name this actor shows under.

        The user id is an address and stays put; this is the label rooms
        render. Used to correct a human filed under a platform id before the
        platform would say who the person was.
        """
        await self._transport.set_display_name(display_name)
        self.display_name = display_name

    @property
    def _transport(self) -> MessageTransport:
        if self.transport is None:
            raise RuntimeError(
                f"Actor {self.transport_user_id} is not connected — call connect() first"
            )
        return self.transport

    # ── Membership ─────────────────────────────────────────────────────────────

    def _joined_event(self, room_id: str) -> asyncio.Event:
        event = self._room_joined_events.get(room_id)
        if event is None:
            event = asyncio.Event()
            self._room_joined_events[room_id] = event
        return event

    def mark_joined(self, room_id: str, joined_at_ms: int) -> None:
        self.room_join_times[room_id] = joined_at_ms
        self._joined_event(room_id).set()

    async def _is_joined_on_server(self, room_id: str) -> bool:
        return room_id in await self._transport.joined_rooms()

    async def wait_joined(self, room_id: str, timeout: float) -> bool:
        """Block until this actor is a member of `room_id`, up to `timeout`
        seconds. Returns True if joined, False on timeout. Callers that need to
        *send* into a room they have only just been invited to must await this
        first: any event that lands before a member's join is filtered out by
        the readers of that room.

        Membership is read, not only waited for. A join that predates the
        process is never redelivered, re-inviting an existing member is a
        no-op, and an actor with no consumer hears no joins at all — so the
        rows are checked on entry and again every `MEMBERSHIP_POLL_SECONDS`.
        """
        event = self._joined_event(room_id)
        if event.is_set():
            return True
        if await self._is_joined_on_server(room_id):
            self.mark_joined(room_id, self._connected_at)
            return True
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                return False
            try:
                await asyncio.wait_for(
                    event.wait(), min(MEMBERSHIP_POLL_SECONDS, remaining)
                )
                return True
            except TimeoutError:
                pass
            if deadline - loop.time() <= 0:
                return False
            if await self._is_joined_on_server(room_id):
                self.mark_joined(room_id, self._connected_at)
                return True

    async def join_room(self, room_id: str) -> None:
        if await self._transport.join_room(room_id):
            self.mark_joined(room_id, int(time.time() * 1000))
            logger.info("Actor %s joined %s", self.transport_user_id, room_id)

    # ── Writing ────────────────────────────────────────────────────────────────

    async def send_message(
        self,
        room_id: str,
        body: str,
        *,
        metered: bool,
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
                metered=metered,
                format=format,
                mentions=mentions,
                thread_root_id=thread_root_id,
                extra_content=extra_content,
            )
        except TransportError as exc:
            logger.error("Failed to send message to %s: %s", room_id, exc)
            return None
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
        media_uri: str,
        filename: str,
        mimetype: str,
        size: int,
        *,
        metered: bool,
        msgtype: str,
        caption: str | None = None,
        thread_root_id: str | None = None,
        group: dict[str, object] | None = None,
    ) -> str | None:
        """Send an m.image / m.file event pointing at an uploaded media URI.

        When `caption` is provided it becomes the event `body` (with the real
        filename carried separately in `filename`, per the rich-media-caption
        convention); otherwise `body` is the filename. When `thread_root_id` is
        set the event is related into that thread (mirrors send_message).

        `group` marks this event as one part of a multi-attachment message —
        `{"id": ..., "index": i, "total": n}`. A media event carries
        exactly one file, so a message
        carrying several files is sent as n events sharing a group id, which
        receivers coalesce back into one logical message. Absent the field, an
        event is simply a group of one.
        """
        try:
            result = await self._transport.send_media(
                room_id,
                media_uri,
                filename,
                mimetype,
                size,
                sender_name=self.display_name,
                metered=metered,
                msgtype=msgtype,
                caption=caption,
                thread_root_id=thread_root_id,
                group=group,
            )
        except TransportError as exc:
            logger.error("Failed to send media to %s: %s", room_id, exc)
            return None
        return result.event_id

    async def set_typing(self, room_id: str, is_typing: bool) -> None:
        await self._transport.set_typing(room_id, is_typing)


class HumanActor(Actor[ClientConfig]):
    """A person on another platform, as a member of Switch rooms.

    One per person per collaboration bridge (client type `user`). The bridge
    writes their messages through it; nothing reads for it, because what the
    room says reaches that person through the bridge's `WorkspaceConsumer`.
    """

    role: ClassVar[ActorRole] = "human"


class AgentActor(Actor[ClientConfig]):
    """An agent, as a member of Switch rooms (client type `agent`).

    Carries the agent row it stands for: the bridge writes the agent's replies
    through it, found by agent id. The row is loaded by the agent's consumer
    when it starts, and refreshed there when it may have been edited.
    """

    role: ClassVar[ActorRole] = "agent"

    def __init__(self, **kwargs: Unpack[ActorKwargs[ClientConfig]]) -> None:
        super().__init__(**kwargs)
        self._agent: Agent | None = None

    @property
    def agent(self) -> Agent:
        if self._agent is None:
            raise RuntimeError("Agent not loaded — its consumer has not started")
        return self._agent

    @property
    def agent_id(self) -> str | None:
        return self._agent.id if self._agent is not None else None

    def set_agent(self, agent: Agent) -> None:
        self._agent = agent


class SystemActor(Actor[ClientConfig]):
    """Switch itself, as a member of every room (client type `admin`).

    Writes command answers, notices and a template's kickoff. What it answers
    is read by its `CommandConsumer`.
    """

    role: ClassVar[ActorRole] = "system"

    # ── Platform messages ───────────────────────────────────────────────────

    async def send_platform_message(
        self,
        room_id: str,
        body: str,
        *,
        thread_root_id: str | None = None,
        on_behalf_of: OnBehalfOf | None = None,
        reply_in_channel: bool = False,
    ) -> str | None:
        """Send an addressed message as the Switch platform.

        Unlike an admin notice it carries no ADMIN_MARKER and IS addressed to
        agents. ``on_behalf_of`` names the person whose authority it carries:
        each addressed agent applies its policy to that person, so the
        platform can say what they could have said and nothing more. Without
        it the message is the platform's own, which agents deny unless a rule
        opts them in.
        """
        marker_value: dict[str, object] = {}
        if on_behalf_of is not None:
            marker_value["on_behalf_of"] = {
                "user_id": on_behalf_of.user_id,
                "name": on_behalf_of.name,
                **(
                    {"agent_id": on_behalf_of.agent_id}
                    if on_behalf_of.agent_id is not None
                    else {}
                ),
            }
        if reply_in_channel:
            # Only meaningful for a threaded message: the agents it addresses
            # answer at the top level instead of under it.
            marker_value["reply_in_channel"] = True
        return await self.send_message(
            room_id,
            body,
            format="markdown",
            thread_root_id=thread_root_id,
            extra_content={PLATFORM_MARKER: marker_value},
            metered=False,
        )

    # ── Admin notices ─────────────────────────────────────────────────────────

    async def send_notice(self, room_id: str, body: str) -> None:
        """Post a system notice about the room's run: that it was paused,
        continued or stopped. Like every admin message it addresses nobody,
        so no agent wakes on it."""
        await self.send_admin(
            room_id,
            body,
            message_type=AdminMessageType.RUN_NOTICE,
            thread_root_id=None,
        )

    # ── Helpers ───────────────────────────────────────────────────────────────

    async def send_admin(
        self,
        room_id: str,
        body: str,
        *,
        message_type: AdminMessageType,
        thread_root_id: str | None,
        mentions: list[str] | None = None,
    ) -> None:
        await self.send_message(
            room_id,
            body,
            format="markdown",
            mentions=mentions,
            thread_root_id=thread_root_id,
            extra_content=admin_extra_content(message_type),
            metered=False,
        )
