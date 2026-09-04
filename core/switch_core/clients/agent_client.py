from __future__ import annotations

import asyncio
import logging
import random
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal, Unpack

from switch_core.attachments import parse_attachment_group
from switch_core.bridges.agent.commands import (
    AGENT_GREETINGS,
    COMMANDS_BY_NAME,
    _addressed_by_name_or_role,
    dispatch_command,
)
from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.types import (
    AgentEvent,
    AttachmentRef,
    CommandPayload,
    MessagePayload,
    RoomJoinPayload,
    TaskAcceptPayload,
    TaskCancelPayload,
    TaskDelegatePayload,
    TaskFinalisePayload,
    TaskUpdatePayload,
)
from switch_core.clients.client_base import (
    ClientBase,
    ClientBaseKwargs,
    ClientConfig,
)
from switch_core.clients.mentions import (
    NAME_CHAR as _NAME_CHAR,
)
from switch_core.clients.mentions import (
    mention_regex as _mention_regex,
)
from switch_core.clients.mentions import (
    strip_emphasis as _strip_emphasis,
)
from switch_core.clients.room_meta import RoomMeta
from switch_core.db.models import Agent
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.delivery.addressing import (
    ADDRESSING_DENIED_MESSAGE,
    ADDRESSING_UNCLAIMED_MESSAGE,
    AddressingDecision,
    AddressingResolver,
    IncomingMessage,
)
from switch_core.events import (
    CommandEvent,
    TaskAccept,
    TaskCancel,
    TaskDelegate,
    TaskFinalise,
    TaskUpdate,
)
from switch_core.gateway.known_agents import known_agent_for
from switch_core.transport import (
    InboundMedia,
    InboundMembership,
    InboundMessage,
    RoomRef,
)

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

# Content flag stamped on the no-session / busy-elsewhere auto-reply (see
# on_message). Its only job is to mark a message as itself an auto-reply so that
# another offline agent addressed by it does NOT emit a second auto-reply — two
# session-less agents tagging each other would otherwise ping-pong identical
# "no session" replies forever. Riding as a field on the plain
# m.room.message keeps the reply rendering normally for humans.
AUTO_REPLY_FLAG = "com.switch.auto_reply"

# How long to hold an incomplete multi-attachment group before delivering the
# parts that did arrive, flagged as incomplete. Groups normally complete in
# milliseconds (one sender, back-to-back events); this is a safety net so a
# broken batch surfaces rather than being buffered indefinitely.
ATTACHMENT_GROUP_TIMEOUT_SECONDS = 5.0


@dataclass
class _PendingAttachmentGroup:
    """Parts of a multi-attachment message seen so far, keyed by group index."""

    total: int
    parts: dict[int, AttachmentRef] = field(default_factory=dict)
    body: str = ""
    # Whether any part of the group addressed this agent. Addressing is read off
    # the message text, and the text rides on part 0 alone — every other part's
    # body is its bare filename. Answering from whichever part completes the
    # group would therefore say "not addressed" for any group not finishing on
    # part 0, which is every group a bridge sends in order.
    addressed: bool = False
    # The index-0 event, kept so a group that has to be flushed incomplete is
    # still anchored on its canonical first part (message_id / timestamp /
    # sender) rather than on whichever part happened to arrive last.
    first_event: InboundMedia | None = None


_UNAVAILABLE_MESSAGES = {
    "always_on": (
        "I'm currently offline — my connector isn't reporting in. "
        "I'll respond once it reconnects."
    ),
    "session_addressable": (
        "I'm not in an active session right now. "
        "I'll see this when I next connect to the room."
    ),
    "session_passive": (
        "I read room messages asynchronously, not in real time — my operator "
        "has to trigger me to pull the latest messages, either from a session I "
        "already have open or by starting a new one."
    ),
    # auto_session with no watcher reporting in: same honest "offline" story as
    # always_on — nothing is going to spin a session up right now.
    "auto_session": (
        "I'm currently offline — my connector isn't reporting in. "
        "I'll respond once it reconnects."
    ),
}


# Posted on the agent's behalf when an auto_session agent is addressed in a
# room where it has no live session but its connector is actively watching:
# the connector will spin a session up on demand to handle the message.
_STARTING_SESSION_MESSAGE = "Starting a session to handle this — one moment."


# Fallback (no known-agent connect command) for a session_addressable agent
# that has a session bound to this room but is not reporting as live — the
# usual cause is a session started without the dev-channels flag.
_CONNECTED_NOT_LIVE_MESSAGE = (
    "I have a session connected to this room, but it isn't reporting as live, "
    "so I'm not receiving messages — my operator may need to restart it."
)


def _offline_owner_message(
    owner_handle: str | None, asker_handle: str, cmd: str | None
) -> str:
    """The reply for an auto_session agent addressed with nothing to start it.

    An auto_session agent is brought online by Switch Console watching on its
    owner's machine, so reaching this means the app is not running or not
    connected — the fix is for the OWNER to open it, and nobody else in the
    room can act. So the owner leads and is asked directly; the asker is named
    as the reason, not as a second person being told to do something.

    Deliberately says "online" rather than anything about sessions: which
    process is or is not attached to which room is Switch's business, not
    something to hand a reader in a chat channel.
    """
    # The owner addressing their own agent is the common case; naming them as
    # the reason they should act reads as a stutter ("@me … and @me needs me").
    needs_me = "" if owner_handle == asker_handle else f", and @{asker_handle} needs me"
    if owner_handle:
        opening = (
            f"@{owner_handle} — I'm not online in this room{needs_me}. "
            "Open Switch Console to bring me online here."
        )
        terminal = "If you'd rather do it from a terminal:"
    else:
        # No owner account on this platform to mention. Still name who has to
        # act, so the message is not read as something the room can fix.
        opening = (
            f"I'm not online in this room{needs_me}. **My owner needs to open "
            "Switch Console** to bring me online here."
        )
        terminal = "Or, from a terminal:"
    if cmd is None:
        return opening
    return f"{opening} {terminal}\n\n```\n{cmd}\n```"


# The refusal wording lives with the decision that produces it. Kept under
# these names because they are how the rest of the package and its tests refer
# to them.
_ADDRESSING_DENIED_MESSAGE = ADDRESSING_DENIED_MESSAGE
_ADDRESSING_UNCLAIMED_MESSAGE = ADDRESSING_UNCLAIMED_MESSAGE


# Shown to an agent addressed here while it holds a role in THIS room but the
# session that assumed the role has hopped away to other room(s) (the lease
# still routes here). `room_names` lists where that session is now active.
def _elsewhere_message(room_names: list[str], holds_role_here: bool) -> str:
    where = ", ".join(f"**{name}**" for name in room_names)
    return (
        f"I hold a role in this room, but the session that assumed it is "
        f"active in {where} right now — I'll pick this up when it "
        f"reconnects here."
    )


# Single-room shorthand used by tests and callers that only have one room to
# name.
def _role_elsewhere_message(other_room_name: str) -> str:
    return _elsewhere_message([other_room_name], holds_role_here=True)


class AgentClient(ClientBase[ClientConfig]):
    def __init__(
        self,
        *,
        event_buffer: EventBuffer,
        agent_store: AgentStore,
        room_store: RoomStore,
        bridge_store: CollaborationBridgeStore,
        document_store: DocumentStore,
        reference_store: ReferenceStore,
        agent_session_store: AgentSessionStore,
        room_role_store: RoomRoleStore,
        external_user_store: ExternalUserStore,
        connections: ConnectionRegistry,
        frontend_base_url: str | None,
        **kwargs: Unpack[ClientBaseKwargs[ClientConfig]],
    ) -> None:
        super().__init__(**kwargs)
        self._event_buffer = event_buffer
        self._agent_store = agent_store
        self._room_store = room_store
        self._bridge_store = bridge_store
        self._document_store = document_store
        self._reference_store = reference_store
        self._agent_session_store = agent_session_store
        self._room_role_store = room_role_store
        self._external_user_store = external_user_store
        self._connections = connections
        self._frontend_base_url = (
            frontend_base_url.rstrip("/") if frontend_base_url else None
        )
        self._agent: Agent | None = None
        # Addressing is decided from stores, not from this client, so the same
        # rules can decide for a message read out of the log.
        self._addressing = AddressingResolver(
            session_factory=self.session_factory,
            room_store=room_store,
            room_role_store=room_role_store,
            client_store=self.client_store,
            agent_store=agent_store,
            external_user_store=external_user_store,
            live_agent_ids=connections.live_agent_ids,
        )
        self._room_meta: dict[str, RoomMeta | None] = {}
        # In-flight multi-attachment groups, by group id, with their safety-net
        # timers. Both are cleared when a group completes or times out, so a
        # never-completed group cannot leak.
        self._attachment_groups: dict[str, _PendingAttachmentGroup] = {}
        self._attachment_group_timers: dict[str, asyncio.TimerHandle] = {}

    @property
    def agent(self) -> Agent:
        if self._agent is None:
            raise RuntimeError("Agent not loaded — call start() first")
        return self._agent

    async def _fresh_agent(self) -> Agent:
        """Re-read the agent row and refresh the cached snapshot.

        `self.agent` is loaded once in `start()`. An operator can edit the
        agent's `integration_profile` (e.g. flip `connection_model` to/from
        `auto_session`) via the gateway while this client runs, so any branch
        on `connection_model` must read fresh rather than trust the boot-time
        snapshot.
        """
        async with self.session_factory() as session:
            fresh = await self._agent_store.get(session, self.agent.id)
        if fresh is not None:
            self._agent = fresh
        return self.agent

    async def start(self) -> None:
        async with self.session_factory() as session:
            agent = await self._agent_store.get_by_client_id(session, self.client_id)
            if agent is None:
                raise RuntimeError(f"No agent found for client: {self.client_id}")
            self._agent = agent
        await super().start()

    # ── Event hooks ───────────────────────────────────────────────────────────

    async def on_self_join(self, room: RoomRef, event: InboundMembership) -> None:
        is_direct = await self._is_direct_room(room.room_id)
        name = self.agent.name
        # The per-agent self-join greeting can be switched off per bridge
        # — e.g. on Mattermost, whose native "X joined the
        # channel" notice makes it redundant.
        meta = await self._resolve_room_meta(room.room_id)
        if meta is not None and not meta.agent_greetings_enabled:
            logger.info(
                "Suppressing self-join greeting for %s in %s "
                "(agent greetings disabled on the room's bridge)",
                name,
                room.room_id,
            )
            return
        if is_direct:
            greeting = f"Hi! I'm {name} — how can I help?"
        else:
            greeting = random.choice(AGENT_GREETINGS).format(name=name)
        await self.send_message(room.room_id, greeting, format="markdown")

    async def _member_name(
        self, session: AsyncSession, event: InboundMembership
    ) -> str:
        """What to call the member who just arrived.

        The name Switch knows them by, not the one on the membership event: a
        profile is set from whatever the source platform calls someone, so
        taking it makes the same person read one way when they arrive and
        another way when they speak — and the log, which records the Switch
        name, disagree with what was delivered live.
        """
        client = await self.client_store.get_by_matrix_user_id(session, event.state_key)
        if client is not None:
            return client.display_name
        fallback = event.display_name or event.state_key.split(":")[0].lstrip("@")
        logger.warning(
            "No Switch client owns %s; naming the arrival %r from the membership event",
            event.state_key,
            fallback,
        )
        return fallback

    async def on_member_event(self, room: RoomRef, event: InboundMembership) -> None:
        # Only forward genuine joins. A membership-preserving update (e.g. a
        # display-name or avatar change) re-fires m.room.member with
        # membership == "join" and prev_membership == "join" — exclude those, and
        # all leave/ban/knock transitions. The base handler already routes this
        # agent's own join to on_self_join and drops backfilled/self events, so
        # this fires once per other-member join (humans and agents alike).
        if event.membership != "join" or event.prev_membership == "join":
            return
        meta = await self._resolve_room_meta(room.room_id)
        if meta is None:
            return
        # `listening` tells each connector whether THIS receiving agent is
        # configured to react to join events in this room. The event is always
        # delivered; the connector decides whether to surface it.
        async with self.session_factory() as session:
            listening = await self._room_store.get_receives_join_events(
                session, meta.room_id, self.agent.id
            )
            member_name = await self._member_name(session, event)
        self._event_buffer.enqueue(
            self.agent.id,
            meta.room_id,
            AgentEvent(
                type="room_join",
                room_id=meta.room_id,
                bridge_id=meta.bridge_id,
                channel_type=meta.channel_type,
                payload=RoomJoinPayload(
                    member=event.state_key,
                    member_name=member_name,
                    timestamp=event.timestamp,
                    listening=listening,
                ),
            ),
        )

    async def on_message(self, room: RoomRef, event: InboundMessage) -> None:
        meta = await self._resolve_room_meta(room.room_id)
        if meta is None:
            return
        is_addressed = await self._compute_addressed(event, meta)

        thread_id = event.thread_root_id

        reply_thread_root = thread_id if thread_id is not None else event.event_id

        is_addressed = await self._gate_addressed(
            room, event, meta, reply_thread_root, is_addressed
        )

        if is_addressed:
            triggered_by_auto_reply = bool(event.content.get(AUTO_REPLY_FLAG))
            if not triggered_by_auto_reply and not await self._is_available(
                meta.room_id
            ):
                handle = self._sender_handle(event)
                msg = await self._reply_when_unavailable_here(meta, handle)
                already_tagged = _mention_regex(handle).search(msg) is not None
                body = msg if already_tagged else f"@{handle} {msg}"
                await self.send_message(
                    room.room_id,
                    body,
                    format="markdown",
                    mentions=[event.sender],
                    # Where this lands depends on whether an answer follows it.
                    #
                    # "Starting a session" is a preamble: the real answer arrives
                    # after it, in the room the question was asked in. Threading
                    # it off the trigger buries the notice away from the answer
                    # it introduces, so it goes where the question was —
                    # `thread_id`, which is None for a message at the root
                    # (CHOO-2173).
                    #
                    # Everything else here is the whole reply and nothing
                    # follows it, so it threads off the triggering message: an
                    # owner mention and a paste-ready command are a wall of text
                    # to drop into a channel for something only one person can
                    # act on (CHOO-2344).
                    thread_root_id=(
                        thread_id
                        if msg == _STARTING_SESSION_MESSAGE
                        else reply_thread_root
                    ),
                    extra_content={AUTO_REPLY_FLAG: True},
                )

        text = event.body

        sender_name = event.sender_name
        if not sender_name:
            sender_name = event.sender
            logger.error(
                "Message received without sender name, using matrix name: %s",
                sender_name,
            )

        agent_event = AgentEvent(
            type="message",
            room_id=meta.room_id,
            bridge_id=meta.bridge_id,
            channel_type=meta.channel_type,
            payload=MessagePayload(
                addressed=is_addressed,
                sender=event.sender,
                sender_name=sender_name,
                message_id=event.event_id,
                body=text,
                timestamp=event.timestamp,
                thread_id=thread_id,
            ),
        )

        logger.debug("Enqueuing event %s", agent_event.model_dump_json(indent=2))
        self._event_buffer.enqueue(
            self.agent.id,
            meta.room_id,
            agent_event,
        )

    async def on_media(self, room: RoomRef, event: InboundMedia) -> None:
        meta = await self._resolve_room_meta(room.room_id)
        if meta is None:
            return
        is_addressed = await self._compute_addressed(event, meta)

        content = event.content
        # With a caption, body is the caption text and the real filename lives in
        # `filename`; without one, body is the filename itself.
        attachment = AttachmentRef(
            filename=event.filename or event.body,
            mimetype=event.mimetype or "",
            size=event.size or 0,
            mxc=event.uri,
            msgtype=event.msgtype,
        )

        sender_name = event.sender_name
        if not sender_name:
            sender_name = event.sender
            logger.error(
                "Media received without sender name, using matrix name: %s",
                sender_name,
            )

        # Mirror on_message: surface the thread this media belongs to (if any).
        thread_id = event.thread_root_id

        # Several files posted as one message arrive as separate Matrix events
        # sharing a group marker (Matrix has no multi-attachment event). Hold
        # them until the group is complete, then emit ONE payload carrying all
        # of them, so the agent sees one message with N attachments.
        group = parse_attachment_group(content)
        if group is None:
            await self._emit_media(
                room,
                event,
                meta,
                is_addressed,
                sender_name,
                thread_id,
                [attachment],
                event.body,
            )
            return

        group_id, index, total = group
        pending = self._attachment_groups.setdefault(
            group_id, _PendingAttachmentGroup(total=total)
        )
        pending.parts[index] = attachment
        pending.addressed = pending.addressed or is_addressed
        if index == 0:
            pending.body = event.body
            pending.first_event = event
        if len(pending.parts) < total:
            self._schedule_attachment_group_flush(
                group_id, room, event, meta, sender_name, thread_id
            )
            return

        self._cancel_attachment_group_flush(group_id)
        self._attachment_groups.pop(group_id, None)
        # Anchor the coalesced message on part 0, not on whichever part
        # happened to complete the group, so message_id / timestamp are stable.
        await self._emit_media(
            room,
            pending.first_event or event,
            meta,
            pending.addressed,
            sender_name,
            thread_id,
            [pending.parts[i] for i in sorted(pending.parts)],
            pending.body or event.body,
        )

    def _schedule_attachment_group_flush(
        self,
        group_id: str,
        room: RoomRef,
        event: InboundMedia,
        meta: RoomMeta,
        sender_name: str,
        thread_id: str | None,
    ) -> None:
        """Arm the safety-net timer for an incomplete attachment group.

        The group should normally complete within milliseconds — every event is
        sent back-to-back by one sender. The timer exists so a group that never
        completes (a failed send mid-batch, a dropped event) surfaces what did
        arrive, clearly flagged, instead of being buffered forever.

        Armed once per group, NOT re-armed per part: the deadline bounds the
        whole group, so a batch dribbling in just under the timeout can't hold
        the buffer open indefinitely.
        """
        if group_id in self._attachment_group_timers:
            return
        self._attachment_group_timers[group_id] = asyncio.get_running_loop().call_later(
            ATTACHMENT_GROUP_TIMEOUT_SECONDS,
            lambda: asyncio.create_task(
                self._flush_incomplete_attachment_group(
                    group_id, room, event, meta, sender_name, thread_id
                )
            ),
        )

    def _cancel_attachment_group_flush(self, group_id: str) -> None:
        timer = self._attachment_group_timers.pop(group_id, None)
        if timer is not None:
            timer.cancel()

    async def _flush_incomplete_attachment_group(
        self,
        group_id: str,
        room: RoomRef,
        event: InboundMedia,
        meta: RoomMeta,
        sender_name: str,
        thread_id: str | None,
    ) -> None:
        self._attachment_group_timers.pop(group_id, None)
        pending = self._attachment_groups.pop(group_id, None)
        if pending is None:
            return
        received = len(pending.parts)
        logger.error(
            "Attachment group %s incomplete: %d of %d parts arrived within %ss; "
            "delivering what arrived",
            group_id,
            received,
            pending.total,
            ATTACHMENT_GROUP_TIMEOUT_SECONDS,
        )
        body = pending.body or event.body
        notice = (
            f"[incomplete attachment group: {received} of {pending.total} "
            f"files arrived]"
        )
        # Anchor on part 0 when we have it, so the payload's message_id matches
        # the completed-group case and replies thread off the canonical event.
        anchor = pending.first_event or event
        await self._emit_media(
            room,
            anchor,
            meta,
            pending.addressed,
            sender_name,
            thread_id,
            [pending.parts[i] for i in sorted(pending.parts)],
            f"{body}\n{notice}" if body else notice,
        )

    async def _emit_media(
        self,
        room: RoomRef,
        event: InboundMedia,
        meta: RoomMeta,
        is_addressed: bool,
        sender_name: str,
        thread_id: str | None,
        attachments: list[AttachmentRef],
        body: str,
    ) -> None:
        reply_thread_root = thread_id if thread_id is not None else event.event_id
        is_addressed = await self._gate_addressed(
            room, event, meta, reply_thread_root, is_addressed
        )

        agent_event = AgentEvent(
            type="message",
            room_id=meta.room_id,
            bridge_id=meta.bridge_id,
            channel_type=meta.channel_type,
            payload=MessagePayload(
                addressed=is_addressed,
                sender=event.sender,
                sender_name=sender_name,
                message_id=event.event_id,
                body=body,
                timestamp=event.timestamp,
                thread_id=thread_id,
                attachments=attachments,
            ),
        )

        logger.debug("Enqueuing media event %s", agent_event.model_dump_json(indent=2))
        self._event_buffer.enqueue(
            self.agent.id,
            meta.room_id,
            agent_event,
        )

    async def on_command(self, room: RoomRef, event: CommandEvent) -> None:
        meta = await self._resolve_room_meta(room.room_id)
        if meta is None:
            return

        # Admin-owned commands (room/info/alias) are handled by the admin
        # client, which is in every room; agents ignore them entirely.
        cmd = COMMANDS_BY_NAME.get(event.command)
        if cmd is not None and cmd.admin_owned:
            return

        # Targeting is a per-command policy: each Command decides whether its
        # args address this agent (Command.addressed). The default matches our
        # @name or a role we hold; some commands (e.g. run-cmd) override it.
        addressed = cmd.addressed if cmd is not None else _addressed_by_name_or_role
        if not await addressed(self, event.args, meta.room_id):
            return

        if not await self._gate_command(room, event, meta):
            return

        handled = await self._handle_command(room, event)
        if handled:
            return

        self._event_buffer.enqueue(
            self.agent.id,
            meta.room_id,
            AgentEvent(
                type="command",
                room_id=meta.room_id,
                bridge_id=meta.bridge_id,
                channel_type=meta.channel_type,
                payload=CommandPayload(
                    command=event.command,
                    args=event.args,
                    user_id=event.user_id,
                    user_name=event.user_name,
                ),
            ),
        )

    async def _command_targets_me_explicitly(self, args: str, room_id: str) -> bool:
        """Whether the command names this agent, rather than reaching it as part
        of a room-wide fan-out (`!reset-all-agents`, or a bare command with no
        `@` token)."""
        if "@" not in args:
            return False
        if self._args_tag_my_name(args):
            return True
        if await self._text_tags_my_alias(args, room_id):
            return True
        return await self._text_tags_my_role(args, room_id)

    async def _gate_command(
        self, room: RoomRef, event: CommandEvent, meta: RoomMeta
    ) -> bool:
        """Apply the addressing policy to a command aimed at this agent.

        Commands drive the agent as surely as a message does — `!reset` wipes
        its context, `!interrupt` stops it mid-task — so a sender who may not
        address the agent may not command it either.

        A refusal is posted only when the command named this agent. A room-wide
        command (`!reset-all-agents`, or a bare one with no target) makes no
        claim about this agent in particular, and answering every one of them
        would flood a room holding several restricted agents; those are declined
        quietly, with a warning in the log.
        """
        decision = await self._addressing_allowed(event.user_id, meta.room_id)
        if decision.allowed:
            return True
        if await self._command_targets_me_explicitly(event.args, meta.room_id):
            await self.reply_command(
                room.room_id,
                decision.refusal,
                thread_root_id=event.thread_id,
            )
        else:
            logger.warning(
                "Command %s from %s declined for %s in room %s: sender may not "
                "address this agent",
                event.command,
                event.user_id,
                self.agent.name,
                meta.room_id,
            )
        return False

    # ── Command handling ──────────────────────────────────────────────────────

    async def _handle_command(self, room: RoomRef, event: CommandEvent) -> bool:
        is_direct = await self._is_direct_room(room.room_id)
        return await dispatch_command(self, room, event, is_direct)

    async def reply_command(
        self,
        room_id: str,
        body: str,
        *,
        format: Literal["text", "markdown"] = "markdown",
        thread_root_id: str | None = None,
    ) -> None:
        """Post a command result as this agent (an agent-owned command like
        `!run-cmd` answers in the agent's own voice, not as a system message)."""
        await self.send_message(
            room_id, body, format=format, thread_root_id=thread_root_id
        )

    async def _resolve_room_meta(self, matrix_room_id: str) -> RoomMeta | None:
        if matrix_room_id in self._room_meta:
            return self._room_meta[matrix_room_id]

        async with self.session_factory() as session:
            room = await self._room_store.get_by_matrix_room_id(session, matrix_room_id)
            if room is None:
                logger.error("Room not found for matrix room ID: %s", matrix_room_id)
                self._room_meta[matrix_room_id] = None
                return None

            agent_greetings_enabled = True
            if room.bridge_id is not None:
                bridge = await self._bridge_store.get(session, room.bridge_id)
                if bridge is not None:
                    agent_greetings_enabled = bridge.agent_greetings_enabled

        meta = RoomMeta(
            room_id=room.id,
            name=room.name,
            bridge_id=room.bridge_id,
            agent_greetings_enabled=agent_greetings_enabled,
            channel_type=room.channel_type,
        )
        self._room_meta[matrix_room_id] = meta
        return meta

    async def _reply_when_unavailable_here(
        self, meta: RoomMeta, asker_handle: str
    ) -> str:
        """Message for an agent addressed here but not live in this room.

        If the agent has live session(s) connected to OTHER rooms, name them so
        the asker knows where to find it — a session hops rooms while keeping
        its heartbeat (and any role lease) alive, so the agent is reachable
        there even though it has no session in the room it was addressed from.
        When the agent also holds a role in *this* room, the wording notes that
        the role-assuming session has stepped away. A live session in a
        genuinely different room wins — the asker is pointed there. Sessions in
        rooms that show the SAME name as this one are NOT offered (pointing the
        asker to a room they appear to already be in is confusing and useless).

        session_passive agents have no heartbeat, so the elsewhere/role logic
        never applies — they fall through to the generic reply, whose wording
        already covers pulling from an existing session or starting a new one.
        For a session_addressable agent with a session bound to THIS room but
        not live here (and no live session in a distinct room), the reply says
        so and tells the operator to relaunch with live channels.
        """
        agent = await self._fresh_agent()
        connection_model = (agent.integration_profile or {}).get(
            "connection_model", "session_passive"
        )

        # auto_session: if a connector is actively watching (global heartbeat),
        # it will spin a session up to handle this — promise that rather than
        # the "elsewhere"/offline wording. With no watcher, fall through to the
        # generic offline reply below.
        # A live connection that declared itself spawn-capable and covers this
        # room WILL start a session, whatever the agent's configured model says.
        # Keying the promise off the observed capability rather than the enum
        # means a mis-set (or merely stale) connection_model can no longer
        # produce "my connector isn't reporting in" while a watcher is sitting
        # right there, connected, about to spawn.
        if self._connections.can_spawn_for(self.agent.id, meta.room_id):
            return _STARTING_SESSION_MESSAGE

        if connection_model == "auto_session":
            async with self.session_factory() as session:
                watching = await self._agent_session_store.get_live_agent_ids(
                    session, [self.agent.id], None
                )
            if self.agent.id in watching or self._connections.is_live(self.agent.id):
                return _STARTING_SESSION_MESSAGE

        async with self.session_factory() as session:
            room_ids = await self._agent_session_store.live_connected_rooms(
                session, self.agent.id
            )
            # A connection covering a room is a session in it, whether or not
            # anything wrote an agent_sessions row for it.
            room_ids = sorted(
                set(room_ids)
                | {
                    room
                    for conn in self._connections.for_agent(self.agent.id)
                    for room in conn.rooms
                }
            )
            bound_here = await self._agent_session_store.has_room_binding(
                session, self.agent.id, meta.room_id
            ) or self._connections.has_session_in(self.agent.id, meta.room_id)
            names: list[str] = []
            holds_role_here = False
            other_room_ids = [rid for rid in room_ids if rid != meta.room_id]
            if other_room_ids:
                for rid in other_room_ids:
                    room = await self._room_store.get(session, rid)
                    name = room.name if room is not None else rid
                    if name != meta.name:
                        names.append(name)
                holds_role_here = (
                    await self._room_role_store.agent_room_role(
                        session,
                        meta.room_id,
                        self.agent.id,
                        self._connections.live_agent_ids(),
                    )
                    is not None
                )

        if names:
            if holds_role_here:
                return _elsewhere_message(names, holds_role_here=True)
            # No role lease here, just sessions elsewhere: prefer the
            # known-agent reply so the operator gets the paste-ready
            # connect command alongside the "ask me there" alternative.
            return await self._unavailable_reply(
                meta, agent, asker_handle, other_room_names=names
            )

        # No live session in a distinct room. A session_addressable agent bound
        # to THIS room but not live here was most likely launched without live
        # channels: say a session is connected-but-not-live rather than imply
        # there is none.
        if connection_model == "session_addressable" and bound_here:
            return await self._unavailable_reply(
                meta, agent, asker_handle, connected_not_live=True
            )
        return await self._unavailable_reply(meta, agent, asker_handle)

    async def owner_handle_in(self, agent: Agent, bridge_id: str | None) -> str | None:
        """The agent owner's account on the platform this room is bridged to,
        for @-mentioning them (CHOO-2137).

        Resolved from who owns the agent and which account that person has
        claimed on this bridge, rather than from a handle configured on the
        agent. A handle only means anything on one platform — the same person
        is one name on Slack and another on Telegram — so a single stored
        string was at best right in one room and inert everywhere else.

        None when the agent has no owner, the room has no bridge, or the owner
        has claimed nothing on it. That is a message with no mention, not a
        message withheld.
        """
        if agent.owner_id is None or bridge_id is None:
            return None
        async with self.session_factory() as session:
            claimed = await self._external_user_store.get_by_user(
                session, agent.owner_id
            )
        # Claiming is not exclusive and one person may hold several accounts on
        # a bridge. Sorted so a second account cannot change who gets mentioned
        # between one message and the next.
        here = sorted(u.external_username for u in claimed if u.bridge_id == bridge_id)
        return here[0] if here else None

    async def _unavailable_reply(
        self,
        meta: RoomMeta,
        agent: Agent,
        asker_handle: str,
        other_room_names: list[str] | None = None,
        connected_not_live: bool = False,
    ) -> str:
        """Build the room-facing message for an addressed-but-offline agent.

        An auto_session agent with nowhere else to point the asker gets the
        owner-facing "I'm not online" reply: only its owner can act, so the
        message asks them and nobody else. Every other case prefers the
        per-known-agent `start_session_instructions` (e.g. the paste-ready
        terminal command for Claude Code), falling back to the static
        `_UNAVAILABLE_MESSAGES` text keyed by connection_model when the agent
        has no known-agent spec or the spec returns None; `connected_not_live`
        selects the "bound here but not live" fallback.

        `agent` is the freshly-read row supplied by the caller (via
        `_fresh_agent`), so option edits made through the gateway (e.g.
        `PATCH /agents/{id}/options`, `connection_model`) take effect without
        restarting this client — `self.agent` alone is a boot-time snapshot.
        """
        connection_model = (agent.integration_profile or {}).get(
            "connection_model", "session_passive"
        )
        spec_options = known_agent_for(agent)
        # `other_room_names` outranks this: a live session in another room is
        # somewhere the asker can go right now, which beats asking the owner to
        # start something.
        if (
            connection_model == "auto_session"
            and not other_room_names
            and not connected_not_live
        ):
            cmd = (
                spec_options[0].connect_command(spec_options[1], agent, meta.name, None)
                if spec_options is not None
                else None
            )
            return _offline_owner_message(
                await self.owner_handle_in(agent, meta.bridge_id),
                asker_handle,
                cmd,
            )
        if spec_options is not None:
            spec, options = spec_options
            msg = spec.start_session_instructions(
                options,
                agent,
                meta.name,
                await self.owner_handle_in(agent, meta.bridge_id),
                other_room_names=other_room_names,
                connected_not_live=connected_not_live,
            )
            if msg is not None:
                return msg
        if connected_not_live:
            return _CONNECTED_NOT_LIVE_MESSAGE
        return _UNAVAILABLE_MESSAGES.get(
            connection_model, _UNAVAILABLE_MESSAGES["session_passive"]
        )

    async def _is_available(self, room_id: str) -> bool:
        """Return True if this agent has a live session for `room_id`.

        always_on agents heartbeat against `room_id=None`; session_addressable
        agents heartbeat against the specific room; session_passive agents
        have no heartbeat and are never considered live in real time.
        """
        agent = await self._fresh_agent()
        connection_model = (agent.integration_profile or {}).get(
            "connection_model", "session_passive"
        )
        if connection_model == "session_passive":
            return False
        # Union of the two presence sources while both kinds of client exist
        # (CHOO-1857 stage B): a client on the push transport keeps only a
        # connection, one still polling keeps only the heartbeat row.
        if connection_model == "always_on":
            if self._connections.is_live(self.agent.id):
                return True
        elif self._connections.has_session_in(self.agent.id, room_id):
            # A claimed room slot, not mere coverage: an `all`-scope watcher
            # covering this room is not a session that can answer.
            return True

        heartbeat_room = None if connection_model == "always_on" else room_id
        async with self.session_factory() as session:
            live = await self._agent_session_store.get_live_agent_ids(
                session, [self.agent.id], heartbeat_room
            )
        return self.agent.id in live

    async def _is_direct_room(self, matrix_room_id: str) -> bool:
        meta = await self._resolve_room_meta(matrix_room_id)
        return meta is not None and meta.channel_type == "direct"

    # ── Task event forwarding ────────────────────────────────────────────────

    async def on_task_delegate(self, room: RoomRef, event: TaskDelegate) -> None:
        if event.performer_agent_id != self.agent.id:
            return
        await self.send_message(room.room_id, "Working on it.", format="markdown")
        meta = await self._resolve_room_meta(room.room_id)
        if meta is None:
            return
        self._event_buffer.enqueue(
            self.agent.id,
            meta.room_id,
            AgentEvent(
                type="task_delegate",
                room_id=meta.room_id,
                bridge_id=meta.bridge_id,
                channel_type=meta.channel_type,
                payload=TaskDelegatePayload(
                    task_id=event.task_id,
                    requester_agent_id=event.requester_agent_id,
                    performer_agent_id=event.performer_agent_id,
                    summary=event.summary,
                    description=event.description,
                ),
            ),
        )

    async def on_task_accept(self, room: RoomRef, event: TaskAccept) -> None:
        if event.requester_agent_id != self.agent.id:
            return
        meta = await self._resolve_room_meta(room.room_id)
        if meta is None:
            return
        self._event_buffer.enqueue(
            self.agent.id,
            meta.room_id,
            AgentEvent(
                type="task_accept",
                room_id=meta.room_id,
                bridge_id=meta.bridge_id,
                channel_type=meta.channel_type,
                payload=TaskAcceptPayload(
                    task_id=event.task_id,
                    requester_agent_id=event.requester_agent_id,
                    performer_agent_id=event.performer_agent_id,
                ),
            ),
        )

    async def on_task_update(self, room: RoomRef, event: TaskUpdate) -> None:
        if event.requester_agent_id != self.agent.id:
            return
        meta = await self._resolve_room_meta(room.room_id)
        if meta is None:
            return
        self._event_buffer.enqueue(
            self.agent.id,
            meta.room_id,
            AgentEvent(
                type="task_update",
                room_id=meta.room_id,
                bridge_id=meta.bridge_id,
                channel_type=meta.channel_type,
                payload=TaskUpdatePayload(
                    task_id=event.task_id,
                    requester_agent_id=event.requester_agent_id,
                    performer_agent_id=event.performer_agent_id,
                    update=event.update,
                ),
            ),
        )

    async def on_task_finalise(self, room: RoomRef, event: TaskFinalise) -> None:
        if event.requester_agent_id != self.agent.id:
            return
        meta = await self._resolve_room_meta(room.room_id)
        if meta is None:
            return
        self._event_buffer.enqueue(
            self.agent.id,
            meta.room_id,
            AgentEvent(
                type="task_finalise",
                room_id=meta.room_id,
                bridge_id=meta.bridge_id,
                channel_type=meta.channel_type,
                payload=TaskFinalisePayload(
                    task_id=event.task_id,
                    requester_agent_id=event.requester_agent_id,
                    performer_agent_id=event.performer_agent_id,
                    outcome=event.outcome,
                ),
            ),
        )

    async def on_task_cancel(self, room: RoomRef, event: TaskCancel) -> None:
        if event.performer_agent_id != self.agent.id:
            return
        meta = await self._resolve_room_meta(room.room_id)
        if meta is None:
            return
        self._event_buffer.enqueue(
            self.agent.id,
            meta.room_id,
            AgentEvent(
                type="task_cancel",
                room_id=meta.room_id,
                bridge_id=meta.bridge_id,
                channel_type=meta.channel_type,
                payload=TaskCancelPayload(
                    task_id=event.task_id,
                    requester_agent_id=event.requester_agent_id,
                    performer_agent_id=event.performer_agent_id,
                    reason=event.reason,
                ),
            ),
        )

    # ── Mention detection ─────────────────────────────────────────────────────

    @staticmethod
    def _as_incoming(event: InboundMessage) -> IncomingMessage:
        """The parts of a bus event that addressing is decided from."""
        return IncomingMessage(
            sender=event.sender,
            body=getattr(event, "body", "") or "",
            formatted_body=getattr(event, "formatted_body", None),
            content=event.content,
        )

    async def _compute_addressed(self, event: InboundMessage, meta: RoomMeta) -> bool:
        return await self._addressing.addresses(
            agent=self.agent,
            agent_matrix_id=self.matrix_user_id,
            room_id=meta.room_id,
            channel_type=meta.channel_type,
            message=self._as_incoming(event),
        )

    async def _addressing_allowed(
        self, matrix_sender: str, room_id: str
    ) -> AddressingDecision:
        """Whether `matrix_sender` may address this agent in `room_id`.

        The agent is re-read rather than taken from the cached one: the policy
        is the thing being enforced, and enforcing a stale copy of it is the
        one way this check can be wrong in the dangerous direction.
        """
        agent = await self._fresh_agent()
        return await self._addressing.permitted(
            agent=agent, room_id=room_id, sender=matrix_sender
        )

    async def _gate_addressed(
        self,
        room: RoomRef,
        event: InboundMessage,
        meta: RoomMeta,
        reply_thread_root: str,
        is_addressed: bool,
    ) -> bool:
        """Apply the scoped addressing policy to a would-be-addressed message.

        When the message tags this agent but the sender is not permitted by the
        agent's policy, demote it to unaddressed room chatter and (once, guarded
        by AUTO_REPLY_FLAG so two agents can't ping-pong) reply to the sender
        explaining they can't address it here. Returns the effective addressed
        flag. Zero cost for the common case: only messages that already tag this
        agent are ever checked, and open policies short-circuit.
        """
        if not is_addressed:
            return False
        decision = await self._addressing_allowed(event.sender, meta.room_id)
        if decision.allowed:
            return True
        triggered_by_auto_reply = bool(event.content.get(AUTO_REPLY_FLAG))
        if not triggered_by_auto_reply:
            handle = self._sender_handle(event)
            msg = decision.refusal
            already_tagged = _mention_regex(handle).search(msg) is not None
            body = msg if already_tagged else f"@{handle} {msg}"
            await self.send_message(
                room.room_id,
                body,
                format="markdown",
                mentions=[event.sender],
                thread_root_id=reply_thread_root,
                extra_content={AUTO_REPLY_FLAG: True},
            )
        return False

    def _args_tag_my_name(self, text: str) -> bool:
        """True when `text` contains our own `@name` at a full-token boundary
        (so a name that is a prefix of a longer one is not falsely matched)."""
        return _mention_regex(self.agent.name).search(_strip_emphasis(text)) is not None

    async def _text_tags_my_alias(self, text: str, room_id: str) -> bool:
        return await self._addressing.mentions_alias(
            agent=self.agent,
            room_id=room_id,
            message=IncomingMessage(sender="", body=text),
        )

    async def _text_tags_my_role(self, text: str, room_id: str) -> bool:
        return await self._addressing.mentions_role(
            agent=self.agent,
            room_id=room_id,
            message=IncomingMessage(sender="", body=text),
        )

    def _sender_handle(self, event: InboundMessage) -> str:
        """The @-handle to tag the message sender with.

        Prefers the bridge-provided `sender_name` (the external username, which
        the collaboration bridge rewrites into a real @mention on Slack /
        Mattermost); falls back to the mxid localpart for a native Matrix user
        (paired with `mentions=[event.sender]` so Matrix renders a pill).
        """
        content = event.content
        name = content.get("sender_name")
        if name:
            return str(name)
        return str(event.sender).split(":")[0].lstrip("@")

    def _is_mentioned(self, event: InboundMessage) -> bool:
        return self._addressing.mentions_name(
            agent=self.agent,
            agent_matrix_id=self.matrix_user_id,
            message=self._as_incoming(event),
        )

    def _strip_mention(self, text: str) -> str:
        pattern = re.compile(
            re.escape(f"@{self.agent.name}") + rf"(?!{_NAME_CHAR}):?",
            re.IGNORECASE,
        )
        return pattern.sub("", text).strip()
